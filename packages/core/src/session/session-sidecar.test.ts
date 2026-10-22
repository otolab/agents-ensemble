import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSessionSidecarMatches,
  findLatestSessionSidecarForIssue,
  loadSessionSidecar,
  requireSessionSidecarForResume,
  saveSessionSidecar,
  SESSION_SIDECAR_VERSION,
  sessionSidecarDir,
  sessionSidecarPath,
  SessionSidecarNotFoundError,
  type SessionSidecar,
} from './session-sidecar.js';

function baseSidecar(
  overrides: Partial<SessionSidecar> & Pick<SessionSidecar, 'conductorAgentId'>,
): SessionSidecar {
  return {
    version: SESSION_SIDECAR_VERSION,
    issueUrl: 'https://github.com/org/repo/issues/1',
    repoRoot: overrides.repoRoot ?? '/repo',
    profile: { workers: [] },
    openQuestions: [],
    sequence: 0,
    workers: {},
    updatedAt: 0,
    ...overrides,
  };
}

describe('session sidecar', () => {
  let tempDir = '';

  afterEach(() => {
    tempDir = '';
  });

  it('round-trips through the filesystem and sets updatedAt on save', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-sidecar-'));
    const path = sessionSidecarPath({
      repoRoot: tempDir,
      conductorAgentId: 'agent-1',
    });
    const sidecar = baseSidecar({
      conductorAgentId: 'agent-1',
      repoRoot: tempDir,
      profile: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
      },
      sequence: 2,
      workers: {
        implementer: { acpSessionId: 'sess-1', acpCwd: '/repo/docs' },
      },
      lazyWorkers: true,
      githubMonitor: {
        pullRequests: {},
        explicitPullRequests: {
          '354': {
            registeredAt: '2026-09-07T05:00:00.000Z',
            kinds: ['pr.review', 'ci.completed'],
          },
        },
        pendingUpdates: [
          {
            id: 'issue-comment:101',
            kind: 'issue.comment',
            summary: 'stored until conductor receives it',
          },
        ],
      },
    });

    const before = Date.now();
    await saveSessionSidecar(path, sidecar);
    const loaded = await loadSessionSidecar(path);

    expect(loaded?.updatedAt).toBeGreaterThanOrEqual(before);
    expect(loaded).toMatchObject({
      ...sidecar,
      lazyWorkers: true,
      updatedAt: expect.any(Number),
    });
    expect(loaded?.githubMonitor?.explicitPullRequests).toEqual({
      '354': {
        registeredAt: '2026-09-07T05:00:00.000Z',
        kinds: ['pr.review', 'ci.completed'],
      },
    });
    expect(loaded?.githubMonitor?.pendingUpdates).toEqual([
      {
        id: 'issue-comment:101',
        kind: 'issue.comment',
        summary: 'stored until conductor receives it',
      },
    ]);
    expect(JSON.parse(await readFile(path, 'utf8')).updatedAt).toEqual(
      loaded?.updatedAt,
    );
  });

  it('records the live socket path and restricts session sidecar permissions', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-sidecar-'));
    const path = sessionSidecarPath({
      repoRoot: tempDir,
      conductorAgentId: 'agent-live',
    });
    await saveSessionSidecar(
      path,
      baseSidecar({
        conductorAgentId: 'agent-live',
        repoRoot: tempDir,
        harnessSocketPath: '/tmp/ens-oq-test/s.sock',
      }),
    );

    const [fileInfo, directoryInfo, loaded] = await Promise.all([
      stat(path),
      stat(sessionSidecarDir(tempDir)),
      loadSessionSidecar(path),
    ]);
    expect(loaded?.harnessSocketPath).toBe('/tmp/ens-oq-test/s.sock');
    expect(fileInfo.mode & 0o777).toBe(0o600);
    expect(directoryInfo.mode & 0o777).toBe(0o700);
  });

  it('round-trips worker acpSpawn through save and load', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-sidecar-'));
    const path = sessionSidecarPath({
      repoRoot: tempDir,
      conductorAgentId: 'agent-acp-spawn',
    });
    const sidecar = baseSidecar({
      conductorAgentId: 'agent-acp-spawn',
      repoRoot: tempDir,
      workers: {
        implementer: {
          acpSessionId: 'sess-1',
          acpCwd: '/repo/worktree',
          acpSpawn: {
            preset: 'claude',
            command: 'claude-agent-acp',
            args: [],
          },
        },
      },
    });

    await saveSessionSidecar(path, sidecar);
    const loaded = await loadSessionSidecar(path);

    expect(loaded?.workers.implementer?.acpSpawn).toEqual({
      preset: 'claude',
      command: 'claude-agent-acp',
      args: [],
    });
  });

  it('round-trips teardown lifecycle while legacy sidecars remain unset', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-sidecar-'));
    const closedPath = sessionSidecarPath({
      repoRoot: tempDir,
      conductorAgentId: 'closed-agent',
    });
    const legacyPath = sessionSidecarPath({
      repoRoot: tempDir,
      conductorAgentId: 'legacy-agent',
    });

    await saveSessionSidecar(
      closedPath,
      baseSidecar({
        conductorAgentId: 'closed-agent',
        repoRoot: tempDir,
        lifecycle: 'closed',
      }),
    );
    await saveSessionSidecar(
      legacyPath,
      baseSidecar({
        conductorAgentId: 'legacy-agent',
        repoRoot: tempDir,
      }),
    );

    await expect(loadSessionSidecar(closedPath)).resolves.toMatchObject({
      lifecycle: 'closed',
    });
    await expect(loadSessionSidecar(legacyPath)).resolves.not.toHaveProperty(
      'lifecycle',
    );
  });

  it('assumes cursor for a legacy sidecar without conductorBackend', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-sidecar-'));
    const path = sessionSidecarPath({
      repoRoot: tempDir,
      conductorAgentId: 'legacy-agent',
    });
    const legacySidecar = baseSidecar({
      conductorAgentId: 'legacy-agent',
      repoRoot: tempDir,
    });
    await mkdir(sessionSidecarDir(tempDir), { recursive: true });
    await writeFile(path, `${JSON.stringify(legacySidecar)}\n`, 'utf8');

    const loaded = await loadSessionSidecar(path);

    expect(loaded?.conductorBackend).toBe('cursor');
    expect(loaded?.lazyWorkers).toBeUndefined();
  });

  it('rejects a conductor backend mismatch on resume validation', () => {
    const sidecar = baseSidecar({
      conductorAgentId: 'agent-backend',
      conductorBackend: 'pi',
      repoRoot: '/repo',
    });

    expect(() =>
      assertSessionSidecarMatches(sidecar, {
        conductorAgentId: 'agent-backend',
        issueUrl: sidecar.issueUrl,
        repoRoot: '/repo',
        conductorBackend: 'cursor',
      }),
    ).toThrow(/conductorBackend mismatch/);
  });

  it('rejects MCP configuration changes on resume', () => {
    const sidecar = baseSidecar({
      conductorAgentId: 'agent-mcp-digest',
      mcpConfigDigest: 'old-digest',
    });

    expect(() =>
      assertSessionSidecarMatches(sidecar, {
        conductorAgentId: 'agent-mcp-digest',
        issueUrl: sidecar.issueUrl,
        repoRoot: sidecar.repoRoot,
        mcpConfigDigest: 'new-digest',
        mcpConfigConfigured: true,
      }),
    ).toThrow(/MCP config digest mismatch/);
  });

  it('rejects ensemble config changes on resume', () => {
    const sidecar = baseSidecar({
      conductorAgentId: 'agent-config-digest',
      ensembleConfigDigest: 'old-digest',
    });

    expect(() =>
      assertSessionSidecarMatches(sidecar, {
        conductorAgentId: 'agent-config-digest',
        issueUrl: sidecar.issueUrl,
        repoRoot: sidecar.repoRoot,
        ensembleConfigDigest: 'new-digest',
      }),
    ).toThrow(/ensemble config digest mismatch/);
  });

  it('allows legacy sidecars without an ensemble config digest', () => {
    const sidecar = baseSidecar({ conductorAgentId: 'agent-config-legacy' });

    expect(() =>
      assertSessionSidecarMatches(sidecar, {
        conductorAgentId: 'agent-config-legacy',
        issueUrl: sidecar.issueUrl,
        repoRoot: sidecar.repoRoot,
        ensembleConfigDigest: 'current-digest',
      }),
    ).not.toThrow();
  });

  it('rejects MCP resume when a legacy sidecar has no digest', () => {
    const sidecar = baseSidecar({ conductorAgentId: 'agent-mcp-legacy' });

    expect(() =>
      assertSessionSidecarMatches(sidecar, {
        conductorAgentId: 'agent-mcp-legacy',
        issueUrl: sidecar.issueUrl,
        repoRoot: sidecar.repoRoot,
        mcpConfigDigest: 'current-digest',
        mcpConfigConfigured: true,
      }),
    ).toThrow(/MCP config digest missing/);
  });

  it('rejects mismatched issueUrl on assert', () => {
    const sidecar = baseSidecar({
      conductorAgentId: 'agent-1',
      repoRoot: '/repo',
    });

    expect(() =>
      assertSessionSidecarMatches(sidecar, {
        conductorAgentId: 'agent-1',
        issueUrl: 'https://github.com/org/repo/issues/2',
        repoRoot: '/repo',
      }),
    ).toThrow(/issueUrl mismatch/);
  });

  it('throws SessionSidecarNotFoundError when resume sidecar is missing', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-sidecar-'));

    await expect(
      requireSessionSidecarForResume({
        repoRoot: tempDir,
        conductorAgentId: 'missing-agent',
      }),
    ).rejects.toThrow(SessionSidecarNotFoundError);
  });

  it('finds the latest sidecar for an issue by updatedAt', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-sidecar-'));
    const issueUrl = 'https://github.com/org/repo/issues/9';
    const dir = sessionSidecarDir(tempDir);
    await mkdir(dir, { recursive: true });

    const write = async (
      agentId: string,
      updatedAt: number,
      url = issueUrl,
    ) => {
      const sidecar = baseSidecar({
        conductorAgentId: agentId,
        repoRoot: tempDir,
        issueUrl: url,
        updatedAt,
      });
      await writeFile(
        join(dir, `${agentId}.json`),
        `${JSON.stringify(sidecar)}\n`,
        'utf8',
      );
    };

    await write('agent-old', 100);
    await write('agent-new', 200);
    await write(
      'agent-other',
      999,
      'https://github.com/org/repo/issues/99',
    );

    const latest = await findLatestSessionSidecarForIssue({
      repoRoot: tempDir,
      issueUrl,
    });

    expect(latest?.conductorAgentId).toBe('agent-new');
  });
});
