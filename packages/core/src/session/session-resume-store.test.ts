import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSessionResumeStateMatches,
  assertSessionSidecarMatches,
  findLatestSessionResumeStateForIssue,
  findLatestSessionSidecarForIssue,
  listSessionSidecars,
  loadSessionResumeState,
  loadSessionSidecar,
  requireSessionResumeStateForResume,
  requireSessionSidecarForResume,
  saveSessionSidecar,
  saveSessionResumeState,
  SESSION_SIDECAR_VERSION,
  SESSION_RESUME_STATE_VERSION,
  sessionSidecarDir,
  sessionSidecarPath,
  sessionResumeStoreDir,
  sessionResumeStorePath,
  SessionResumeStateNotFoundError,
  SessionSidecarNotFoundError,
  type SessionResumeState,
  type SessionSidecar,
} from './session-resume-store.js';

function baseResumeState(
  overrides: Partial<SessionResumeState> & Pick<SessionResumeState, 'conductorAgentId'>,
): SessionResumeState {
  return {
    version: SESSION_RESUME_STATE_VERSION,
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

describe('SessionResumeStore', () => {
  let tempDir = '';

  afterEach(() => {
    tempDir = '';
  });

  it('round-trips through the filesystem and sets updatedAt on save', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-session-resume-store-'));
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      conductorAgentId: 'agent-1',
    });
    expect(path).toBe(join(tempDir, '.ensemble', 'sessions', 'agent-1.json'));
    const resumeState = baseResumeState({
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
    await saveSessionResumeState(path, resumeState);
    const loaded = await loadSessionResumeState(path);

    expect(loaded?.updatedAt).toBeGreaterThanOrEqual(before);
    expect(loaded).toMatchObject({
      ...resumeState,
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

  it('records the live socket path and restricts SessionResumeStore permissions', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-session-resume-store-'));
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      conductorAgentId: 'agent-live',
    });
    await saveSessionResumeState(
      path,
      baseResumeState({
        conductorAgentId: 'agent-live',
        repoRoot: tempDir,
        harnessSocketPath: '/tmp/ens-oq-test/s.sock',
      }),
    );

    const [fileInfo, directoryInfo, loaded] = await Promise.all([
      stat(path),
      stat(sessionResumeStoreDir(tempDir)),
      loadSessionResumeState(path),
    ]);
    expect(loaded?.harnessSocketPath).toBe('/tmp/ens-oq-test/s.sock');
    expect(fileInfo.mode & 0o777).toBe(0o600);
    expect(directoryInfo.mode & 0o777).toBe(0o700);
  });

  it('round-trips worker acpSpawn through save and load', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-session-resume-store-'));
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      conductorAgentId: 'agent-acp-spawn',
    });
    const resumeState = baseResumeState({
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

    await saveSessionResumeState(path, resumeState);
    const loaded = await loadSessionResumeState(path);

    expect(loaded?.workers.implementer?.acpSpawn).toEqual({
      preset: 'claude',
      command: 'claude-agent-acp',
      args: [],
    });
  });

  it('round-trips teardown lifecycle and leaves it unset for legacy records', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-session-resume-store-'));
    const closedPath = sessionResumeStorePath({
      repoRoot: tempDir,
      conductorAgentId: 'closed-agent',
    });
    const legacyPath = sessionResumeStorePath({
      repoRoot: tempDir,
      conductorAgentId: 'legacy-agent',
    });

    await saveSessionResumeState(
      closedPath,
      baseResumeState({
        conductorAgentId: 'closed-agent',
        repoRoot: tempDir,
        lifecycle: 'closed',
      }),
    );
    await saveSessionResumeState(
      legacyPath,
      baseResumeState({
        conductorAgentId: 'legacy-agent',
        repoRoot: tempDir,
      }),
    );

    await expect(loadSessionResumeState(closedPath)).resolves.toMatchObject({
      lifecycle: 'closed',
    });
    await expect(loadSessionResumeState(legacyPath)).resolves.not.toHaveProperty(
      'lifecycle',
    );
  });

  it('assumes cursor for a legacy record without conductorBackend', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-session-resume-store-'));
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      conductorAgentId: 'legacy-agent',
    });
    const legacyResumeState = baseResumeState({
      conductorAgentId: 'legacy-agent',
      repoRoot: tempDir,
    });
    await mkdir(sessionResumeStoreDir(tempDir), { recursive: true });
    await writeFile(path, `${JSON.stringify(legacyResumeState)}\n`, 'utf8');

    const loaded = await loadSessionResumeState(path);

    expect(loaded?.conductorBackend).toBe('cursor');
    expect(loaded?.lazyWorkers).toBeUndefined();
  });

  it('rejects a conductor backend mismatch on resume validation', () => {
    const resumeState = baseResumeState({
      conductorAgentId: 'agent-backend',
      conductorBackend: 'pi',
      repoRoot: '/repo',
    });

    expect(() =>
      assertSessionResumeStateMatches(resumeState, {
        conductorAgentId: 'agent-backend',
        issueUrl: resumeState.issueUrl,
        repoRoot: '/repo',
        conductorBackend: 'cursor',
      }),
    ).toThrow(/conductorBackend mismatch/);
  });

  it('rejects MCP configuration changes on resume', () => {
    const resumeState = baseResumeState({
      conductorAgentId: 'agent-mcp-digest',
      mcpConfigDigest: 'old-digest',
    });

    expect(() =>
      assertSessionResumeStateMatches(resumeState, {
        conductorAgentId: 'agent-mcp-digest',
        issueUrl: resumeState.issueUrl,
        repoRoot: resumeState.repoRoot,
        mcpConfigDigest: 'new-digest',
        mcpConfigConfigured: true,
      }),
    ).toThrow(/MCP config digest mismatch/);
  });

  it('rejects MCP resume when a legacy record has no digest', () => {
    const resumeState = baseResumeState({ conductorAgentId: 'agent-mcp-legacy' });

    expect(() =>
      assertSessionResumeStateMatches(resumeState, {
        conductorAgentId: 'agent-mcp-legacy',
        issueUrl: resumeState.issueUrl,
        repoRoot: resumeState.repoRoot,
        mcpConfigDigest: 'current-digest',
        mcpConfigConfigured: true,
      }),
    ).toThrow(/MCP config digest missing/);
  });

  it('rejects mismatched issueUrl on assert', () => {
    const resumeState = baseResumeState({
      conductorAgentId: 'agent-1',
      repoRoot: '/repo',
    });

    expect(() =>
      assertSessionResumeStateMatches(resumeState, {
        conductorAgentId: 'agent-1',
        issueUrl: 'https://github.com/org/repo/issues/2',
        repoRoot: '/repo',
      }),
    ).toThrow(/issueUrl mismatch/);
  });

  it('throws SessionResumeStateNotFoundError when the saved state is missing', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-session-resume-store-'));

    await expect(
      requireSessionResumeStateForResume({
        repoRoot: tempDir,
        conductorAgentId: 'missing-agent',
      }),
    ).rejects.toThrow(SessionResumeStateNotFoundError);
  });

  it('finds the latest session resume state for an issue by updatedAt', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-session-resume-store-'));
    const issueUrl = 'https://github.com/org/repo/issues/9';
    const dir = sessionResumeStoreDir(tempDir);
    await mkdir(dir, { recursive: true });

    const write = async (
      agentId: string,
      updatedAt: number,
      url = issueUrl,
    ) => {
      const resumeState = baseResumeState({
        conductorAgentId: agentId,
        repoRoot: tempDir,
        issueUrl: url,
        updatedAt,
      });
      await writeFile(
        join(dir, `${agentId}.json`),
        `${JSON.stringify(resumeState)}\n`,
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

    const latest = await findLatestSessionResumeStateForIssue({
      repoRoot: tempDir,
      issueUrl,
    });

    expect(latest?.conductorAgentId).toBe('agent-new');
  });

  it('keeps deprecated sidecar API aliases compatible through the deprecation period', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-session-resume-store-'));
    const options = { repoRoot: tempDir, conductorAgentId: 'legacy-agent' };
    const path = sessionResumeStorePath(options);
    const state: SessionSidecar = baseResumeState({
      conductorAgentId: options.conductorAgentId,
      repoRoot: tempDir,
      updatedAt: 123,
    });

    expect(SESSION_SIDECAR_VERSION).toBe(SESSION_RESUME_STATE_VERSION);
    expect(sessionSidecarDir(tempDir)).toBe(sessionResumeStoreDir(tempDir));
    expect(sessionSidecarPath(options)).toBe(path);
    assertSessionSidecarMatches(state, {
      conductorAgentId: options.conductorAgentId,
      issueUrl: state.issueUrl,
      repoRoot: tempDir,
    });

    await saveSessionSidecar(path, state);
    await expect(loadSessionSidecar(path)).resolves.toMatchObject({
      conductorAgentId: options.conductorAgentId,
      issueUrl: state.issueUrl,
      repoRoot: tempDir,
    });
    await expect(listSessionSidecars(tempDir)).resolves.toHaveLength(1);
    await expect(
      findLatestSessionSidecarForIssue({
        repoRoot: tempDir,
        issueUrl: state.issueUrl,
      }),
    ).resolves.toMatchObject({ conductorAgentId: options.conductorAgentId });
    await expect(
      requireSessionSidecarForResume({
        repoRoot: tempDir,
        conductorAgentId: 'missing-agent',
      }),
    ).rejects.toMatchObject({
      name: SessionSidecarNotFoundError.name,
      code: 'SESSION_SIDECAR_NOT_FOUND',
    });
  });
});
