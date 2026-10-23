import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeAcpSpawnEnvDigest } from '../acp/resolve-acp-spawn.js';
import {
  assertSessionResumeStoreMatches,
  assertSessionSidecarMatches,
  findLatestSessionResumeStoreForIssue,
  findLatestSessionSidecarForIssue,
  listSessionSidecars,
  loadSessionResumeStore,
  loadSessionSidecar,
  requireSessionResumeStoreForResume,
  requireSessionSidecarForResume,
  saveSessionSidecar,
  saveSessionResumeStore,
  SESSION_SIDECAR_VERSION,
  SESSION_RESUME_STORE_VERSION,
  sessionSidecarDir,
  sessionSidecarPath,
  sessionResumeStoreDir,
  sessionResumeStorePath,
  SessionResumeStoreNotFoundError,
  SessionSidecarNotFoundError,
  type SessionResumeStore,
  type SessionSidecar,
} from './session-resume-store.js';

function baseResumeStore(
  overrides: Partial<SessionResumeStore> & Pick<SessionResumeStore, 'conductorAgentId'>,
): SessionResumeStore {
  return {
    version: SESSION_RESUME_STORE_VERSION,
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
    const resumeStore = baseResumeStore({
      conductorAgentId: 'agent-1',
      repoRoot: tempDir,
      profile: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
      },
      sequence: 2,
      workers: {
        implementer: { acpSessionId: 'sess-1', acpCwd: '/repo/docs' },
      },
      conductorCwd: '/repo/.ensemble/worktrees/issue-1',
      cursorBootstrapRunId: 'run-bootstrap-1',
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
    await saveSessionResumeStore(path, resumeStore);
    const loaded = await loadSessionResumeStore(path);

    expect(loaded?.updatedAt).toBeGreaterThanOrEqual(before);
    expect(loaded).toMatchObject({
      ...resumeStore,
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
    await saveSessionResumeStore(
      path,
      baseResumeStore({
        conductorAgentId: 'agent-live',
        repoRoot: tempDir,
        harnessSocketPath: '/tmp/ens-oq-test/s.sock',
      }),
    );

    const [fileInfo, directoryInfo, loaded] = await Promise.all([
      stat(path),
      stat(sessionResumeStoreDir(tempDir)),
      loadSessionResumeStore(path),
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
    const resumeStore = baseResumeStore({
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

    await saveSessionResumeStore(path, resumeStore);
    const loaded = await loadSessionResumeStore(path);

    expect(loaded?.workers.implementer?.acpSpawn).toEqual({
      preset: 'claude',
      command: 'claude-agent-acp',
      args: [],
    });
  });

  it('redacts legacy ACP env values when reading and saving a resume store', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-session-resume-store-'));
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      conductorAgentId: 'agent-legacy-acp-env',
    });
    const marker = 'LEGACY_ACP_SECRET_MARKER';
    const legacyResumeStore = {
      ...baseResumeStore({
        conductorAgentId: 'agent-legacy-acp-env',
        repoRoot: tempDir,
      }),
      workers: {
        implementer: {
          acpSessionId: 'sess-legacy',
          acpSpawn: {
            preset: 'custom',
            command: 'custom-acp',
            args: [],
            env: { API_TOKEN: marker },
          },
        },
      },
    };
    await mkdir(sessionResumeStoreDir(tempDir), { recursive: true });
    await writeFile(path, `${JSON.stringify(legacyResumeStore)}\n`, 'utf8');

    const loaded = await loadSessionResumeStore(path);

    expect(loaded?.workers.implementer?.acpSpawn).toEqual({
      preset: 'custom',
      command: 'custom-acp',
      args: [],
      envDigest: computeAcpSpawnEnvDigest({ API_TOKEN: marker }),
    });
    expect(JSON.stringify(loaded)).not.toContain(marker);

    await saveSessionResumeStore(path, loaded!);
    expect(await readFile(path, 'utf8')).not.toContain(marker);
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

    await saveSessionResumeStore(
      closedPath,
      baseResumeStore({
        conductorAgentId: 'closed-agent',
        repoRoot: tempDir,
        lifecycle: 'closed',
      }),
    );
    await saveSessionResumeStore(
      legacyPath,
      baseResumeStore({
        conductorAgentId: 'legacy-agent',
        repoRoot: tempDir,
      }),
    );

    await expect(loadSessionResumeStore(closedPath)).resolves.toMatchObject({
      lifecycle: 'closed',
    });
    await expect(loadSessionResumeStore(legacyPath)).resolves.not.toHaveProperty(
      'lifecycle',
    );
  });

  it('persists the harness phase and aligns modifiedAt with updatedAt', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-session-resume-store-'));
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      conductorAgentId: 'active-agent',
    });

    await saveSessionResumeStore(path, {
      ...baseResumeStore({
        conductorAgentId: 'active-agent',
        repoRoot: tempDir,
        updatedAt: 1,
      }),
      harnessPhase: 'running',
      modifiedAt: 1,
    });

    const saved = await loadSessionResumeStore(path);
    expect(saved?.harnessPhase).toBe('running');
    expect(saved?.modifiedAt).toBe(saved?.updatedAt);
    expect(saved?.modifiedAt).toBeGreaterThan(1);
  });

  it('assumes cursor for a legacy record without conductorBackend', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-session-resume-store-'));
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      conductorAgentId: 'legacy-agent',
    });
    const legacyResumeStore = baseResumeStore({
      conductorAgentId: 'legacy-agent',
      repoRoot: tempDir,
    });
    await mkdir(sessionResumeStoreDir(tempDir), { recursive: true });
    await writeFile(path, `${JSON.stringify(legacyResumeStore)}\n`, 'utf8');

    const loaded = await loadSessionResumeStore(path);

    expect(loaded?.conductorBackend).toBe('cursor');
    expect(loaded?.lazyWorkers).toBeUndefined();
    expect(loaded).not.toHaveProperty('conductorCwd');
    expect(loaded).not.toHaveProperty('cursorBootstrapRunId');
  });

  it('rejects a conductor backend mismatch on resume validation', () => {
    const resumeStore = baseResumeStore({
      conductorAgentId: 'agent-backend',
      conductorBackend: 'pi',
      repoRoot: '/repo',
    });

    expect(() =>
      assertSessionResumeStoreMatches(resumeStore, {
        conductorAgentId: 'agent-backend',
        issueUrl: resumeStore.issueUrl,
        repoRoot: '/repo',
        conductorBackend: 'cursor',
      }),
    ).toThrow(/conductorBackend mismatch/);
  });

  it('rejects MCP configuration changes on resume', () => {
    const resumeStore = baseResumeStore({
      conductorAgentId: 'agent-mcp-digest',
      mcpConfigDigest: 'old-digest',
    });

    expect(() =>
      assertSessionResumeStoreMatches(resumeStore, {
        conductorAgentId: 'agent-mcp-digest',
        issueUrl: resumeStore.issueUrl,
        repoRoot: resumeStore.repoRoot,
        mcpConfigDigest: 'new-digest',
        mcpConfigConfigured: true,
      }),
    ).toThrow(/MCP config digest mismatch/);
  });

  it('rejects MCP resume when a legacy record has no digest', () => {
    const resumeStore = baseResumeStore({ conductorAgentId: 'agent-mcp-legacy' });

    expect(() =>
      assertSessionResumeStoreMatches(resumeStore, {
        conductorAgentId: 'agent-mcp-legacy',
        issueUrl: resumeStore.issueUrl,
        repoRoot: resumeStore.repoRoot,
        mcpConfigDigest: 'current-digest',
        mcpConfigConfigured: true,
      }),
    ).toThrow(/MCP config digest missing/);
  });

  it('rejects ensemble config changes on resume', () => {
    const resumeStore = baseResumeStore({
      conductorAgentId: 'agent-config-digest',
      ensembleConfigDigest: 'old-digest',
    });

    expect(() =>
      assertSessionResumeStoreMatches(resumeStore, {
        conductorAgentId: 'agent-config-digest',
        issueUrl: resumeStore.issueUrl,
        repoRoot: resumeStore.repoRoot,
        ensembleConfigDigest: 'new-digest',
      }),
    ).toThrow(/ensemble config digest mismatch/);
  });

  it('allows legacy resume stores without an ensemble config digest', () => {
    const resumeStore = baseResumeStore({
      conductorAgentId: 'agent-config-legacy',
    });

    expect(() =>
      assertSessionResumeStoreMatches(resumeStore, {
        conductorAgentId: 'agent-config-legacy',
        issueUrl: resumeStore.issueUrl,
        repoRoot: resumeStore.repoRoot,
        ensembleConfigDigest: 'current-digest',
      }),
    ).not.toThrow();
  });

  it('rejects mismatched issueUrl on assert', () => {
    const resumeStore = baseResumeStore({
      conductorAgentId: 'agent-1',
      repoRoot: '/repo',
    });

    expect(() =>
      assertSessionResumeStoreMatches(resumeStore, {
        conductorAgentId: 'agent-1',
        issueUrl: 'https://github.com/org/repo/issues/2',
        repoRoot: '/repo',
      }),
    ).toThrow(/issueUrl mismatch/);
  });

  it('throws SessionResumeStoreNotFoundError when the saved state is missing', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-session-resume-store-'));

    await expect(
      requireSessionResumeStoreForResume({
        repoRoot: tempDir,
        conductorAgentId: 'missing-agent',
      }),
    ).rejects.toThrow(SessionResumeStoreNotFoundError);
  });

  it('finds the latest session resume store for an issue by updatedAt', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-session-resume-store-'));
    const issueUrl = 'https://github.com/org/repo/issues/9';
    const dir = sessionResumeStoreDir(tempDir);
    await mkdir(dir, { recursive: true });

    const write = async (
      agentId: string,
      updatedAt: number,
      url = issueUrl,
    ) => {
      const resumeStore = baseResumeStore({
        conductorAgentId: agentId,
        repoRoot: tempDir,
        issueUrl: url,
        updatedAt,
      });
      await writeFile(
        join(dir, `${agentId}.json`),
        `${JSON.stringify(resumeStore)}\n`,
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

    const latest = await findLatestSessionResumeStoreForIssue({
      repoRoot: tempDir,
      issueUrl,
    });

    expect(latest?.conductorAgentId).toBe('agent-new');
  });

  it('prefers close or abort candidates and excludes exit for --continue', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-session-resume-store-'));
    const issueUrl = 'https://github.com/org/repo/issues/9';
    const dir = sessionResumeStoreDir(tempDir);
    await mkdir(dir, { recursive: true });
    const write = async (
      agentId: string,
      updatedAt: number,
      phase: SessionResumeStore['harnessPhase'] = undefined,
      lifecycle?: NonNullable<SessionResumeStore['lifecycle']>,
    ) => {
      const resumeStore = baseResumeStore({
        conductorAgentId: agentId,
        repoRoot: tempDir,
        issueUrl,
        updatedAt,
      });
      await writeFile(
        join(dir, `${agentId}.json`),
        `${JSON.stringify({
          ...resumeStore,
          harnessPhase: phase,
          ...(lifecycle ? { lifecycle } : {}),
        })}\n`,
        'utf8',
      );
    };

    await write('recent-idle', 500, 'idle');
    await write('older-closed', 200, 'close', 'closed');
    await write('newer-exit', 900, 'exit', 'exited');
    await write('legacy-abort', 250, undefined, 'interrupted');

    await expect(
      findLatestSessionResumeStoreForIssue({ repoRoot: tempDir, issueUrl }),
    ).resolves.toMatchObject({ conductorAgentId: 'legacy-abort' });

    await write('older-closed', 200, 'exit', 'exited');
    await write('legacy-abort', 250, 'exit', 'exited');
    await expect(
      findLatestSessionResumeStoreForIssue({ repoRoot: tempDir, issueUrl }),
    ).resolves.toMatchObject({ conductorAgentId: 'recent-idle' });

    await write('recent-idle', 500, 'exit', 'exited');
    await expect(
      findLatestSessionResumeStoreForIssue({ repoRoot: tempDir, issueUrl }),
    ).resolves.toBeUndefined();
  });

  it('keeps deprecated sidecar API aliases compatible through the deprecation period', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-session-resume-store-'));
    const options = { repoRoot: tempDir, conductorAgentId: 'legacy-agent' };
    const path = sessionResumeStorePath(options);
    const state: SessionSidecar = baseResumeStore({
      conductorAgentId: options.conductorAgentId,
      repoRoot: tempDir,
      updatedAt: 123,
    });

    expect(SESSION_SIDECAR_VERSION).toBe(SESSION_RESUME_STORE_VERSION);
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
