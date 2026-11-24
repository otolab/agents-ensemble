import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeAcpSpawnEnvDigest } from '../acp/resolve-acp-spawn.js';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import { SessionOwnership } from './session-ownership.js';
import {
  assertSessionResumeStoreMatches,
  assertSessionSidecarMatches,
  canonicalSessionResumeStorePath,
  findLatestSessionResumeStoreForIssue,
  findLatestSessionSidecarForIssue,
  findSessionResumeStore,
  findSessionResumeStoreBySelector,
  findUserSessionResumeStore,
  legacySessionResumeStoreDir,
  listLocatedSessionResumeStoresPage,
  listUserLocatedSessionResumeStoresPage,
  listLocatedSessionResumeStores,
  listSessionSidecars,
  loadSessionResumeStore,
  loadSessionSidecar,
  requireSessionResumeStoreForResume as requireStoreWithLease,
  requireLocatedSessionResumeStoreForResume as requireLocatedWithLease,
  requireSessionSidecarForResume as requireSidecarWithLease,
  saveSessionSidecar as saveSidecarWithLease,
  saveSessionResumeStore as saveStoreWithLease,
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

const TEST_ISSUE_URL = 'https://github.com/org/repo/issues/1';

async function withOwner<T>(path: string, fn: (owner: SessionOwnership, lease: import('./session-ownership.js').SessionWriteLease) => Promise<T>): Promise<T> {
  const owner = await SessionOwnership.acquire(path);
  try {
    return await owner.runWrite((lease) => fn(owner, lease));
  } finally {
    await owner.closeWritesAndDrain();
    owner.release();
  }
}

const saveSessionResumeStore = (path: string, value: SessionResumeStore) =>
  withOwner(path, (owner, lease) => saveStoreWithLease(path, value, owner, lease));
const saveSessionSidecar = (path: string, value: SessionSidecar) =>
  withOwner(path, (owner, lease) => saveSidecarWithLease(path, value, owner, lease));

type ResumeInput = Omit<Parameters<typeof requireStoreWithLease>[0], 'owner' | 'lease'>;
function resumePath(input: ResumeInput): string {
  return input.issueUrl
    ? canonicalSessionResumeStorePath(input)
    : join(input.repoRoot, 'invalid-session.json');
}
const requireSessionResumeStoreForResume = (input: ResumeInput) =>
  withOwner(resumePath(input), (owner, lease) => requireStoreWithLease({ ...input, owner, lease }));
const requireLocatedSessionResumeStoreForResume = (input: ResumeInput) =>
  withOwner(resumePath(input), (owner, lease) => requireLocatedWithLease({ ...input, owner, lease }));
const requireSessionSidecarForResume = (input: ResumeInput) =>
  withOwner(resumePath(input), (owner, lease) => requireSidecarWithLease({ ...input, owner, lease }));

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

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    tempDir = '';
  });

  async function createHome(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    vi.stubEnv('HOME', directory);
    return directory;
  }

  it('round-trips through the filesystem and sets updatedAt on save', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      issueUrl: TEST_ISSUE_URL,
      conductorAgentId: 'agent-1',
    });
    expect(path).toBe(
      join(
        sessionResumeStoreDir({
          repoRoot: tempDir,
          issueUrl: TEST_ISSUE_URL,
        }),
        'agent-1.json',
      ),
    );
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
      createdHarnessCliVersion: '0.19.0',
      cursorBootstrapRunId: 'run-bootstrap-1',
      cursorBootstrapComplete: false,
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
    expect(
      JSON.parse(await readFile(path, 'utf8')).createdHarnessCliVersion,
    ).toBe('0.19.0');
    await expect(
      stat(
        resolveEnsemblePaths({ repoRoot: tempDir })
          .legacyHashSessionResumeStorePath('agent-1'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      stat(
        resolveEnsemblePaths({ repoRoot: tempDir })
          .legacySessionResumeStorePath('agent-1'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('loads and saves a legacy fixture without backfilling its CLI version', async () => {
    tempDir = await createHome('ensemble-session-resume-store-legacy-');
    const legacyStore = JSON.parse(
      await readFile(
        new URL(
          '../../test/fixtures/session-resume-store-v1-legacy.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as SessionResumeStore;
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      issueUrl: TEST_ISSUE_URL,
      conductorAgentId: legacyStore.conductorAgentId,
    });

    await saveSessionResumeStore(path, { ...legacyStore, repoRoot: tempDir });

    const loaded = await loadSessionResumeStore(path);
    const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(loaded).not.toHaveProperty('createdHarnessCliVersion');
    expect(persisted).not.toHaveProperty('createdHarnessCliVersion');
    expect(persisted.version).toBe(SESSION_RESUME_STORE_VERSION);
  });

  it.each(['full', 'resume-feasibility'] as const)(
    'round-trips the %s config digest scheme',
    async (ensembleConfigDigestScheme) => {
      tempDir = await createHome('ensemble-session-resume-store-scheme-');
      const path = sessionResumeStorePath({
        repoRoot: tempDir,
        issueUrl: TEST_ISSUE_URL,
        conductorAgentId: `agent-${ensembleConfigDigestScheme}`,
      });
      await saveSessionResumeStore(
        path,
        baseResumeStore({
          conductorAgentId: `agent-${ensembleConfigDigestScheme}`,
          repoRoot: tempDir,
          ensembleConfigDigestScheme,
          ensembleConfigDigest: 'a'.repeat(64),
          acpModelConfigDigest: 'b'.repeat(64),
        }),
      );

      await expect(loadSessionResumeStore(path)).resolves.toMatchObject({
        ensembleConfigDigestScheme,
        ensembleConfigDigest: 'a'.repeat(64),
        acpModelConfigDigest: 'b'.repeat(64),
      });
    },
  );

  it('rejects unknown schemes and resume-feasibility stores without a digest', async () => {
    tempDir = await createHome('ensemble-session-resume-store-invalid-scheme-');
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      issueUrl: TEST_ISSUE_URL,
      conductorAgentId: 'agent-invalid-scheme',
    });
    await mkdir(dirname(path), { recursive: true });

    const base = baseResumeStore({
      conductorAgentId: 'agent-invalid-scheme',
      repoRoot: tempDir,
    });
    await writeFile(
      path,
      JSON.stringify({
        ...base,
        ensembleConfigDigestScheme: 'future-scheme',
        ensembleConfigDigest: 'a'.repeat(64),
      }),
      'utf8',
    );
    await expect(loadSessionResumeStore(path)).rejects.toThrow(
      /Unsupported session resume store ensembleConfigDigestScheme/,
    );

    await writeFile(
      path,
      JSON.stringify({
        ...base,
        ensembleConfigDigestScheme: 'resume-feasibility',
      }),
      'utf8',
    );
    await expect(loadSessionResumeStore(path)).rejects.toThrow(
      /resume-feasibility scheme requires ensembleConfigDigest/,
    );

    await writeFile(
      path,
      JSON.stringify({
        ...base,
        acpModelConfigDigest: 'not-a-sha256-digest',
      }),
      'utf8',
    );
    await expect(loadSessionResumeStore(path)).rejects.toThrow(
      /Invalid session resume store: acpModelConfigDigest/,
    );
  });

  it('keeps scheme-less stores without a digest as legacy unverifiable data', async () => {
    tempDir = await createHome('ensemble-session-resume-store-no-digest-');
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      issueUrl: TEST_ISSUE_URL,
      conductorAgentId: 'agent-no-digest',
    });
    await saveSessionResumeStore(
      path,
      baseResumeStore({
        conductorAgentId: 'agent-no-digest',
        repoRoot: tempDir,
      }),
    );

    const loaded = await loadSessionResumeStore(path);
    expect(loaded?.ensembleConfigDigestScheme).toBeUndefined();
    expect(loaded?.ensembleConfigDigest).toBeUndefined();
    expect(loaded?.acpModelConfigDigest).toBeUndefined();
  });

  it('records the live socket path and restricts SessionResumeStore permissions', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      issueUrl: TEST_ISSUE_URL,
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
      stat(
        sessionResumeStoreDir({
          repoRoot: tempDir,
          issueUrl: TEST_ISSUE_URL,
        }),
      ),
      loadSessionResumeStore(path),
    ]);
    expect(loaded?.harnessSocketPath).toBe('/tmp/ens-oq-test/s.sock');
    expect(fileInfo.mode & 0o777).toBe(0o600);
    expect(directoryInfo.mode & 0o777).toBe(0o700);
  });

  it.each([
    { label: 'custom', modelTag: 'urgent' },
    { label: 'empty', modelTag: '' },
    { label: 'whitespace-only', modelTag: '  ' },
  ])(
    'round-trips a $label worker modelTag through save and load',
    async ({ modelTag }) => {
      tempDir = await createHome('ensemble-session-resume-store-');
      const path = sessionResumeStorePath({
        repoRoot: tempDir,
        issueUrl: TEST_ISSUE_URL,
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
              preset: 'codex',
              command: 'codex-acp',
              args: [],
              modelTag,
              model: 'provider/opus',
              reasoning: 'high',
              modelProviderDigest: 'b'.repeat(64),
              envDigest: 'a'.repeat(64),
            },
          },
        },
      });

      await saveSessionResumeStore(path, resumeStore);
      const loaded = await loadSessionResumeStore(path);

      expect(loaded?.workers.implementer?.acpSpawn).toEqual({
        preset: 'codex',
        command: 'codex-acp',
        args: [],
        modelTag,
        model: 'provider/opus',
        reasoning: 'high',
        modelProviderDigest: 'b'.repeat(64),
        envDigest: 'a'.repeat(64),
      });
    },
  );

  it('persists the builtin Pi runtime marker in worker fingerprints', async () => {
    tempDir = await createHome('ensemble-session-resume-store-builtin-pi-');
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      issueUrl: TEST_ISSUE_URL,
      conductorAgentId: 'agent-builtin-pi',
    });
    const resumeStore = baseResumeStore({
      conductorAgentId: 'agent-builtin-pi',
      repoRoot: tempDir,
      workers: {
        implementer: {
          acpSessionId: 'sess-builtin-pi',
          acpCwd: '/repo/worktree',
          acpSpawn: {
            preset: 'pi',
            command: '/usr/bin/node',
            args: ['/core/dist/acp/pi-acp-wrapper.js'],
            piRuntime: 'builtin',
          },
        },
      },
    });

    await saveSessionResumeStore(path, resumeStore);

    await expect(loadSessionResumeStore(path)).resolves.toMatchObject({
      workers: {
        implementer: {
          acpSpawn: {
            preset: 'pi',
            piRuntime: 'builtin',
          },
        },
      },
    });
    expect(
      JSON.parse(await readFile(path, 'utf8')).workers.implementer.acpSpawn
        .piRuntime,
    ).toBe('builtin');
  });

  it('round-trips an explicitly configured Cursor fast mode, including false', async () => {
    tempDir = await createHome('ensemble-session-resume-store-cursor-fast-');
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      issueUrl: TEST_ISSUE_URL,
      conductorAgentId: 'agent-cursor-fast',
    });
    const resumeStore = baseResumeStore({
      conductorAgentId: 'agent-cursor-fast',
      repoRoot: tempDir,
      workers: {
        implementer: {
          acpSessionId: 'sess-cursor-fast',
          acpCwd: '/repo/worktree',
          acpSpawn: {
            preset: 'cursor',
            command: 'agent',
            args: ['--model', 'cursor-grok-4.6-high', 'acp'],
            modelTag: 'high',
            model: 'cursor-grok-4.6-high',
            reasoning: 'high',
            cursorFast: false,
          },
        },
      },
    });

    await saveSessionResumeStore(path, resumeStore);
    const loaded = await loadSessionResumeStore(path);

    expect(loaded?.workers.implementer?.acpSpawn).toMatchObject({
      preset: 'cursor',
      command: 'agent',
      model: 'cursor-grok-4.6-high',
      reasoning: 'high',
      cursorFast: false,
    });
  });

  it('loads an older worker fingerprint without reasoning or provider digest fields', async () => {
    tempDir = await createHome('ensemble-session-resume-store-legacy-reasoning-');
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      issueUrl: TEST_ISSUE_URL,
      conductorAgentId: 'agent-legacy-reasoning',
    });
    const resumeStore = baseResumeStore({
      conductorAgentId: 'agent-legacy-reasoning',
      repoRoot: tempDir,
      workers: {
        implementer: {
          acpSessionId: 'sess-legacy-reasoning',
          acpCwd: '/repo/worktree',
          acpSpawn: {
            preset: 'codex',
            command: 'codex-acp',
            args: [],
            modelTag: 'high',
            model: 'provider/opus',
            envDigest: 'a'.repeat(64),
          },
        },
      },
    });

    await saveSessionResumeStore(path, resumeStore);
    const loaded = await loadSessionResumeStore(path);

    expect(loaded?.workers.implementer?.acpSpawn).toEqual({
      preset: 'codex',
      command: 'codex-acp',
      args: [],
      modelTag: 'high',
      model: 'provider/opus',
      envDigest: 'a'.repeat(64),
    });
  });

  it('redacts legacy ACP env values when reading and saving a resume store', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      issueUrl: TEST_ISSUE_URL,
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
    await mkdir(
      sessionResumeStoreDir({
        repoRoot: tempDir,
        issueUrl: TEST_ISSUE_URL,
      }),
      { recursive: true },
    );
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
    tempDir = await createHome('ensemble-session-resume-store-');
    const closedPath = sessionResumeStorePath({
      repoRoot: tempDir,
      issueUrl: TEST_ISSUE_URL,
      conductorAgentId: 'closed-agent',
    });
    const legacyPath = sessionResumeStorePath({
      repoRoot: tempDir,
      issueUrl: TEST_ISSUE_URL,
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
    tempDir = await createHome('ensemble-session-resume-store-');
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      issueUrl: TEST_ISSUE_URL,
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
    tempDir = await createHome('ensemble-session-resume-store-');
    const path = sessionResumeStorePath({
      repoRoot: tempDir,
      issueUrl: TEST_ISSUE_URL,
      conductorAgentId: 'legacy-agent',
    });
    const legacyResumeStore = baseResumeStore({
      conductorAgentId: 'legacy-agent',
      repoRoot: tempDir,
    });
    await mkdir(
      sessionResumeStoreDir({
        repoRoot: tempDir,
        issueUrl: TEST_ISSUE_URL,
      }),
      { recursive: true },
    );
    await writeFile(path, `${JSON.stringify(legacyResumeStore)}\n`, 'utf8');

    const loaded = await loadSessionResumeStore(path);

    expect(loaded?.conductorBackend).toBe('cursor');
    expect(loaded?.lazyWorkers).toBeUndefined();
    expect(loaded).not.toHaveProperty('conductorCwd');
    expect(loaded).not.toHaveProperty('cursorBootstrapRunId');
    expect(loaded).not.toHaveProperty('cursorBootstrapComplete');
  });

  it('allows current backend changes when the Issue identity matches', () => {
    const resumeStore = baseResumeStore({
      conductorAgentId: 'agent-backend',
      conductorBackend: 'pi',
      repoRoot: '/repo',
    });

    expect(() =>
      assertSessionResumeStoreMatches(resumeStore, {
        conductorAgentId: 'agent-backend',
        issueUrl: resumeStore.issueUrl,
      }),
    ).not.toThrow();
  });

  it('allows MCP configuration changes through identity validation', () => {
    const resumeStore = baseResumeStore({
      conductorAgentId: 'agent-mcp-digest',
      mcpConfigDigest: 'old-digest',
    });

    expect(() =>
      assertSessionResumeStoreMatches(resumeStore, {
        conductorAgentId: 'agent-mcp-digest',
        issueUrl: resumeStore.issueUrl,
      }),
    ).not.toThrow();
  });

  it('allows legacy stores without an MCP digest through identity validation', () => {
    const resumeStore = baseResumeStore({ conductorAgentId: 'agent-mcp-legacy' });

    expect(() =>
      assertSessionResumeStoreMatches(resumeStore, {
        conductorAgentId: 'agent-mcp-legacy',
        issueUrl: resumeStore.issueUrl,
      }),
    ).not.toThrow();
  });

  it('allows ensemble config changes through identity validation', () => {
    const resumeStore = baseResumeStore({
      conductorAgentId: 'agent-config-digest',
      ensembleConfigDigest: 'old-digest',
    });

    expect(() =>
      assertSessionResumeStoreMatches(resumeStore, {
        conductorAgentId: 'agent-config-digest',
        issueUrl: resumeStore.issueUrl,
      }),
    ).not.toThrow();
  });

  it('treats a saved ACP model configuration digest as diagnostic metadata', () => {
    const resumeStore = baseResumeStore({
      conductorAgentId: 'agent-acp-model-digest',
      acpModelConfigDigest: 'a'.repeat(64),
    });

    expect(() =>
      assertSessionResumeStoreMatches(resumeStore, {
        conductorAgentId: 'agent-acp-model-digest',
        issueUrl: resumeStore.issueUrl,
      }),
    ).not.toThrow();
  });

  it('allows legacy resume stores without an ensemble config digest', () => {
    const resumeStore = baseResumeStore({
      conductorAgentId: 'agent-config-legacy',
    });

    expect(() =>
      assertSessionResumeStoreMatches(resumeStore, {
        conductorAgentId: 'agent-config-legacy',
        issueUrl: resumeStore.issueUrl,
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
      }),
    ).toThrow(/issueUrl mismatch/);
  });

  it('throws SessionResumeStoreNotFoundError when the saved state is missing', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');

    await expect(
      requireSessionResumeStoreForResume({
        repoRoot: tempDir,
        conductorAgentId: 'missing-agent',
        issueUrl: 'https://github.com/org/repo/issues/9',
      }),
    ).rejects.toThrow(SessionResumeStoreNotFoundError);
  });

  it('requires an Issue URL when reading a session for resume', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');

    await expect(
      requireLocatedSessionResumeStoreForResume({
        repoRoot: tempDir,
        conductorAgentId: 'agent-without-issue-scope',
        issueUrl: '',
      }),
    ).rejects.toThrow('issueUrl is required to resume a session.');
  });

  it('reads the canonical slug store and ignores hash and project copies', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
    const agentId = 'duplicate-agent';
    const issueUrl = 'https://github.com/org/repo/issues/9';
    const paths = resolveEnsemblePaths({ repoRoot: tempDir });
    const hashPath = paths.legacyHashSessionResumeStorePath(agentId);
    const slugPath = paths.canonicalSessionResumeStorePath(issueUrl, agentId);
    const projectPath = join(paths.legacySessionsDir, `${agentId}.json`);
    const hashStore = baseResumeStore({
      conductorAgentId: agentId,
      repoRoot: tempDir,
      issueUrl,
      updatedAt: 900,
    });
    const slugStore = baseResumeStore({
      conductorAgentId: agentId,
      repoRoot: tempDir,
      issueUrl,
      harnessSocketPath: '/tmp/ens-oq-live/s.sock',
      updatedAt: 100,
    });
    const projectStore = baseResumeStore({
      conductorAgentId: agentId,
      repoRoot: tempDir,
      issueUrl,
      updatedAt: 1_000,
    });
    for (const [path, store] of [
      [hashPath, hashStore],
      [slugPath, slugStore],
      [projectPath, projectStore],
    ] as const) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(store)}\n`, 'utf8');
    }
    const diagnostics: Array<{
      selectedPath: string;
      candidates: Array<{ path: string; hasHarnessSocketPath: boolean }>;
    }> = [];

    const selected = await findSessionResumeStore(tempDir, agentId, {
      onDuplicate: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(selected).toMatchObject({
      path: slugPath,
      location: 'canonical-slug',
      resumeStore: { harnessSocketPath: '/tmp/ens-oq-live/s.sock' },
    });
    expect(diagnostics).toEqual([]);
    await expect(
      findLatestSessionResumeStoreForIssue({
        repoRoot: tempDir,
        issueUrl,
      }),
    ).resolves.toMatchObject({
      conductorAgentId: agentId,
      harnessSocketPath: '/tmp/ens-oq-live/s.sock',
      repoRoot: tempDir,
      updatedAt: 100,
    });
    await expect(
      requireSessionResumeStoreForResume({
        repoRoot: tempDir,
        conductorAgentId: agentId,
        issueUrl,
      }),
    ).resolves.toMatchObject({
      harnessSocketPath: '/tmp/ens-oq-live/s.sock',
    });
    await expect(
      readFile(hashPath, 'utf8').then((raw) =>
        JSON.parse(raw).updatedAt as number,
      ),
    ).resolves.toBe(900);
  });

  it.each(['user-path-hash', 'project-legacy'] as const)(
    'does not read malformed %s data while listing canonical stores',
    async (location) => {
      tempDir = await createHome('ensemble-session-resume-store-');
      const agentId = `malformed-${location}`;
      const peerAgentId = `valid-peer-${location}`;
      const issueUrl = 'https://github.com/org/repo/issues/9';
      const peerIssueUrl = 'https://github.com/org/other-repo/issues/10';
      const paths = resolveEnsemblePaths({ repoRoot: tempDir });
      const malformedPath =
        location === 'user-path-hash'
          ? paths.legacyHashSessionResumeStorePath(agentId)
          : paths.legacySessionResumeStorePath(agentId);
      const slugPath = paths.canonicalSessionResumeStorePath(
        issueUrl,
        agentId,
      );
      const peerPath = paths.canonicalSessionResumeStorePath(
        peerIssueUrl,
        peerAgentId,
      );
      for (const path of [malformedPath, peerPath, slugPath]) {
        await mkdir(dirname(path), { recursive: true });
      }
      await writeFile(malformedPath, '{invalid json\n', 'utf8');
      await writeFile(
        peerPath,
        `${JSON.stringify(
          baseResumeStore({
            conductorAgentId: peerAgentId,
            issueUrl: peerIssueUrl,
            repoRoot: tempDir,
          }),
        )}\n`,
        'utf8',
      );
      await writeFile(
        slugPath,
        `${JSON.stringify(
          baseResumeStore({
            conductorAgentId: agentId,
            issueUrl,
            repoRoot: tempDir,
            harnessSocketPath: '/tmp/ens-oq-live/canonical.sock',
          }),
        )}\n`,
        'utf8',
      );

      const listed = await listLocatedSessionResumeStores(tempDir);

      expect(listed).toHaveLength(2);
      expect(listed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: slugPath,
            location: 'canonical-slug',
          }),
          expect.objectContaining({ path: peerPath, location: 'canonical-slug' }),
        ]),
      );
      await expect(
        requireLocatedSessionResumeStoreForResume({
          repoRoot: tempDir,
          issueUrl,
          conductorAgentId: agentId,
        }),
      ).resolves.toMatchObject({
        path: slugPath,
        location: 'canonical-slug',
        resumeStore: {
          harnessSocketPath: '/tmp/ens-oq-live/canonical.sock',
        },
      });
      await expect(readFile(malformedPath, 'utf8')).resolves.toBe(
        '{invalid json\n',
      );
    },
  );

  it.each([
    { reason: 'malformed JSON', contents: '{invalid json' },
    { reason: 'invalid schema', contents: '{}' },
  ])(
    'treats hash-only legacy data with $reason as unavailable without changing it',
    async ({ contents }) => {
      tempDir = await createHome('ensemble-session-resume-store-');
      const agentId = `corrupt-hash-only-${contents.length}`;
      const issueUrl = 'https://github.com/org/repo/issues/9';
      const paths = resolveEnsemblePaths({ repoRoot: tempDir });
      const hashPath = paths.legacyHashSessionResumeStorePath(agentId);
      const raw = `${contents}\n`;
      await mkdir(dirname(hashPath), { recursive: true });
      await writeFile(hashPath, raw, 'utf8');

      await expect(listLocatedSessionResumeStores(tempDir)).resolves.toEqual([]);
      await expect(
        requireLocatedSessionResumeStoreForResume({
          repoRoot: tempDir,
          conductorAgentId: agentId,
          issueUrl,
        }),
      ).rejects.toThrow(SessionResumeStoreNotFoundError);
      await expect(loadSessionResumeStore(hashPath)).rejects.toThrow(
        /Invalid session resume store/,
      );
      await expect(readFile(hashPath, 'utf8')).resolves.toBe(raw);
    },
  );

  it('selects a canonical slug Store and ignores an older hash copy', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
    const currentRepoRoot = join(tempDir, 'current-clone');
    const originRepoRoot = join(tempDir, 'origin-clone');
    const agentId = 'cross-clone-duplicate-agent';
    const issueUrl = 'https://github.com/org/repo/issues/9';
    const paths = resolveEnsemblePaths({ repoRoot: currentRepoRoot });
    const hashPath = paths.legacyHashSessionResumeStorePath(agentId);
    const slugPath = canonicalSessionResumeStorePath({
      repoRoot: currentRepoRoot,
      issueUrl,
      conductorAgentId: agentId,
    });
    const hashStore = baseResumeStore({
      conductorAgentId: agentId,
      repoRoot: currentRepoRoot,
      issueUrl,
      updatedAt: 900,
    });
    const slugStore = baseResumeStore({
      conductorAgentId: agentId,
      repoRoot: originRepoRoot,
      issueUrl,
      harnessSocketPath: '/tmp/ens-oq-live/cross-clone.sock',
      updatedAt: 100,
    });
    for (const [path, store] of [
      [hashPath, hashStore],
      [slugPath, slugStore],
    ] as const) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(store)}\n`, 'utf8');
    }
    const diagnostics: Array<{
      selectedPath: string;
      candidates: Array<{ path: string; hasHarnessSocketPath: boolean }>;
    }> = [];

    const selected = await findSessionResumeStore(currentRepoRoot, agentId, {
      onDuplicate: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(selected).toMatchObject({
      path: slugPath,
      location: 'canonical-slug',
      resumeStore: {
        repoRoot: originRepoRoot,
        harnessSocketPath: '/tmp/ens-oq-live/cross-clone.sock',
      },
    });
    expect(diagnostics).toEqual([]);
    await expect(
      requireLocatedSessionResumeStoreForResume({
        repoRoot: currentRepoRoot,
        issueUrl,
        conductorAgentId: agentId,
      }),
    ).resolves.toMatchObject({
      path: slugPath,
      resumeStore: { harnessSocketPath: '/tmp/ens-oq-live/cross-clone.sock' },
    });
  });

  it('rejects an ID-only lookup when the same session id exists in different repositories', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
    const conductorAgentId = 'shared-session-id';
    const issueUrls = [
      'https://github.com/org/first-repo/issues/1',
      'https://github.com/org/second-repo/issues/2',
    ];
    const paths = resolveEnsemblePaths({ repoRoot: tempDir });
    for (const [index, issueUrl] of issueUrls.entries()) {
      const path = paths.canonicalSessionResumeStorePath(
        issueUrl,
        conductorAgentId,
      );
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        `${JSON.stringify(
          baseResumeStore({
            conductorAgentId,
            issueUrl,
            repoRoot: `/clone/${index}`,
            updatedAt: index + 1,
          }),
        )}\n`,
        'utf8',
      );
    }

    await expect(
      findSessionResumeStore(tempDir, conductorAgentId),
    ).rejects.toThrow(
      /is ambiguous across saved Issues; use findSessionResumeStoreBySelector/,
    );
  });

  it('lists every local slug group with scope filters and keyset pagination', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
    const currentRepoRoot = join(tempDir, 'current-clone');
    const originRepoRoot = join(tempDir, 'origin-clone');
    const paths = resolveEnsemblePaths({ repoRoot: currentRepoRoot });
    const stores = [
      baseResumeStore({
        conductorAgentId: 'same-session-id',
        issueUrl: 'https://github.com/org/repo/issues/1',
        repoRoot: originRepoRoot,
        updatedAt: 300,
      }),
      baseResumeStore({
        conductorAgentId: 'same-session-id',
        issueUrl: 'https://github.com/org/repo/issues/2',
        repoRoot: originRepoRoot,
        updatedAt: 200,
      }),
      baseResumeStore({
        conductorAgentId: 'other-repo-session',
        issueUrl: 'https://github.com/other/repo/issues/3',
        repoRoot: originRepoRoot,
        updatedAt: 100,
      }),
    ];
    for (const [index, store] of stores.entries()) {
      const canonicalPath = paths.canonicalSessionResumeStorePath(
        store.issueUrl,
        store.conductorAgentId,
      );
      const path =
        index === 1
          ? join(dirname(canonicalPath), 'same-session-id-second.json')
          : canonicalPath;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(store)}\n`, 'utf8');
    }

    const all = await listLocatedSessionResumeStoresPage(currentRepoRoot);
    expect(all.total).toBe(3);
    expect(all.sessions.map(({ resumeStore }) => resumeStore.issueUrl)).toEqual([
      'https://github.com/org/repo/issues/1',
      'https://github.com/org/repo/issues/2',
      'https://github.com/other/repo/issues/3',
    ]);

    const firstPage = await listLocatedSessionResumeStoresPage(currentRepoRoot, {
      githubRepo: 'ORG/REPO',
      limit: 1,
    });
    expect(firstPage.total).toBe(2);
    expect(firstPage.sessions.map(({ resumeStore }) => resumeStore.issueUrl)).toEqual([
      'https://github.com/org/repo/issues/1',
    ]);
    expect(firstPage.nextCursor).toBeDefined();
    const secondPage = await listLocatedSessionResumeStoresPage(currentRepoRoot, {
      githubRepo: 'org/repo',
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.sessions.map(({ resumeStore }) => resumeStore.issueUrl)).toEqual([
      'https://github.com/org/repo/issues/2',
    ]);
    expect(secondPage.nextCursor).toBeUndefined();
    await expect(
      listLocatedSessionResumeStoresPage(currentRepoRoot, { cursor: '' }),
    ).rejects.toThrow(/Invalid session list cursor/);

    await expect(
      findSessionResumeStoreBySelector(currentRepoRoot, {
        conductorAgentId: 'same-session-id',
        githubRepo: 'org/repo',
      }),
    ).rejects.toThrow(/specify --issue-url/);
    await expect(
      findSessionResumeStoreBySelector(currentRepoRoot, {
        conductorAgentId: 'same-session-id',
        githubRepo: 'different/repo',
        issueUrl: 'https://github.com/org/repo/issues/1',
      }),
    ).rejects.toThrow(/different GitHub repositories/);
    await expect(
      findSessionResumeStoreBySelector(currentRepoRoot, {
        conductorAgentId: 'same-session-id',
        issueUrl: 'https://github.com/org/repo/issues/2',
      }),
    ).resolves.toMatchObject({
      resumeStore: {
        issueUrl: 'https://github.com/org/repo/issues/2',
        repoRoot: originRepoRoot,
      },
    });
  });

  it('lists only canonical user slug stores and ignores hash and project data', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
    const userEnsembleRoot = join(tempDir, '.ensemble');
    const oldCloneA = join(tempDir, 'checkout-a');
    const oldCloneB = join(tempDir, 'checkout-b');
    const paths = resolveEnsemblePaths({
      repoRoot: oldCloneA,
      userEnsembleRoot,
    });
    const canonical = baseResumeStore({
      conductorAgentId: 'canonical-session',
      issueUrl: 'https://github.com/org/one/issues/1',
      repoRoot: oldCloneA,
      updatedAt: 30,
    });
    const hashA = baseResumeStore({
      conductorAgentId: 'hash-session-a',
      issueUrl: 'https://github.com/org/two/issues/2',
      repoRoot: oldCloneA,
      updatedAt: 20,
    });
    const hashBPaths = resolveEnsemblePaths({
      repoRoot: oldCloneB,
      userEnsembleRoot,
    });
    const hashB = baseResumeStore({
      conductorAgentId: 'hash-session-b',
      issueUrl: 'https://github.com/other/repo/issues/3',
      repoRoot: oldCloneB,
      updatedAt: 10,
    });
    const projectLocal = baseResumeStore({
      conductorAgentId: 'project-local-session',
      issueUrl: 'https://github.com/org/local/issues/4',
      repoRoot: oldCloneA,
      updatedAt: 40,
    });
    const targets = [
      [
        paths.canonicalSessionResumeStorePath(
          canonical.issueUrl,
          canonical.conductorAgentId,
        ),
        canonical,
      ],
      [
        paths.legacyHashSessionResumeStorePath(hashA.conductorAgentId),
        hashA,
      ],
      [
        hashBPaths.legacyHashSessionResumeStorePath(hashB.conductorAgentId),
        hashB,
      ],
      [
        join(oldCloneA, '.ensemble', 'sessions', `${projectLocal.conductorAgentId}.json`),
        projectLocal,
      ],
    ] as const;
    for (const [path, store] of targets) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(store)}\n`, 'utf8');
    }

    const firstPage = await listUserLocatedSessionResumeStoresPage(
      { limit: 2 },
      { userEnsembleRoot },
    );
    expect(firstPage.total).toBe(1);
    expect(firstPage.sessions.map(({ resumeStore }) => resumeStore.conductorAgentId)).toEqual([
      'canonical-session',
    ]);
    expect(firstPage.nextCursor).toBeUndefined();
    await expect(
      findUserSessionResumeStore('hash-session-b', { userEnsembleRoot }),
    ).resolves.toBeUndefined();
    await expect(
      listUserLocatedSessionResumeStoresPage(
        { githubRepo: 'ORG/TWO' },
        { userEnsembleRoot },
      ),
    ).resolves.toMatchObject({
      total: 0,
      sessions: [],
    });
  });

  it('pages a large exact-repository inventory without leaking other repositories', async () => {
    tempDir = await createHome('ensemble-session-resume-store-page-');
    const userEnsembleRoot = join(tempDir, '.ensemble');
    const repoRoot = join(tempDir, 'clone');
    const paths = resolveEnsemblePaths({ repoRoot, userEnsembleRoot });
    const repositoryStores = Array.from({ length: 501 }, (_, index) => {
      const issueUrl = `https://github.com/org/repo/issues/${index + 1}`;
      return baseResumeStore({
        conductorAgentId: `run-${String(index).padStart(3, '0')}`,
        issueUrl,
        repoRoot,
        updatedAt: index,
      });
    });
    const firstPath = paths.canonicalSessionResumeStorePath(
      repositoryStores[0]!.issueUrl,
      repositoryStores[0]!.conductorAgentId,
    );
    await mkdir(dirname(firstPath), { recursive: true });
    await Promise.all(
      repositoryStores.map((store) =>
        writeFile(
          paths.canonicalSessionResumeStorePath(
            store.issueUrl,
            store.conductorAgentId,
          ),
          `${JSON.stringify(store)}\n`,
        ),
      ),
    );
    const excluded = baseResumeStore({
      conductorAgentId: 'other-repository-run',
      issueUrl: 'https://github.com/org/other/issues/1',
      repoRoot,
    });
    const excludedPath = paths.canonicalSessionResumeStorePath(
      excluded.issueUrl,
      excluded.conductorAgentId,
    );
    await mkdir(dirname(excludedPath), { recursive: true });
    await writeFile(excludedPath, `${JSON.stringify(excluded)}\n`);

    const firstPage = await listUserLocatedSessionResumeStoresPage(
      { githubRepo: 'ORG/REPO', limit: 500 },
      { userEnsembleRoot },
    );
    expect(firstPage.total).toBe(501);
    expect(firstPage.sessions).toHaveLength(500);
    expect(firstPage.nextCursor).toBeDefined();
    const secondPage = await listUserLocatedSessionResumeStoresPage(
      {
        githubRepo: 'org/repo',
        limit: 500,
        cursor: firstPage.nextCursor,
      },
      { userEnsembleRoot },
    );
    expect(secondPage.total).toBe(501);
    expect(secondPage.sessions).toHaveLength(1);
    expect(
      [...firstPage.sessions, ...secondPage.sessions].map(
        ({ resumeStore }) => resumeStore.conductorAgentId,
      ),
    ).toHaveLength(501);
    expect(
      [...firstPage.sessions, ...secondPage.sessions].some(
        ({ resumeStore }) => resumeStore.conductorAgentId === excluded.conductorAgentId,
      ),
    ).toBe(false);
  });

  it('keeps sessions with the same conductor id in different slugs separate and resumes the requested issue', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
    const currentRepoRoot = join(tempDir, 'current-clone');
    const conductorAgentId = 'shared-conductor-id';
    const issueUrls = [
      'https://github.com/org/first-repo/issues/1',
      'https://github.com/org/second-repo/issues/2',
    ];
    const paths = resolveEnsemblePaths({ repoRoot: currentRepoRoot });
    for (const [index, issueUrl] of issueUrls.entries()) {
      const path = paths.canonicalSessionResumeStorePath(
        issueUrl,
        conductorAgentId,
      );
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        `${JSON.stringify(
          baseResumeStore({
            conductorAgentId,
            issueUrl,
            repoRoot: `/clone/${index}`,
            updatedAt: index + 1,
          }),
        )}\n`,
        'utf8',
      );
    }

    const listed = await listLocatedSessionResumeStores(currentRepoRoot);
    expect(listed.map(({ resumeStore }) => resumeStore.issueUrl).sort()).toEqual(
      [...issueUrls].sort(),
    );
    await expect(
      requireLocatedSessionResumeStoreForResume({
        repoRoot: currentRepoRoot,
        issueUrl: issueUrls[0]!,
        conductorAgentId,
      }),
    ).resolves.toMatchObject({
      location: 'canonical-slug',
      resumeStore: { issueUrl: issueUrls[0] },
    });
  });

  it.each(['user-path-hash', 'project-legacy'] as const)(
    'does not resume from %s ResumeStore data',
    async (location) => {
      tempDir = await createHome('ensemble-session-resume-store-');
      const repoRoot = join(tempDir, 'repo');
      const agentId = `promote-${location}`;
      const issueUrl = 'https://github.com/org/repo/issues/9';
      const paths = resolveEnsemblePaths({ repoRoot });
      const sourcePath =
        location === 'user-path-hash'
          ? paths.legacyHashSessionResumeStorePath(agentId)
          : paths.legacySessionResumeStorePath(agentId);
      const sourceStore = baseResumeStore({
        conductorAgentId: agentId,
        repoRoot,
        issueUrl,
        updatedAt: 123,
      });
      const sourceText = `${JSON.stringify(sourceStore, null, 2)}\n`;
      await mkdir(dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, sourceText, 'utf8');

      await expect(
        requireLocatedSessionResumeStoreForResume({
          repoRoot,
          issueUrl,
          conductorAgentId: agentId,
        }),
      ).rejects.toThrow(SessionResumeStoreNotFoundError);
      await expect(readFile(sourcePath, 'utf8')).resolves.toBe(sourceText);
      await expect(
        loadSessionResumeStore(
          paths.canonicalSessionResumeStorePath(issueUrl, agentId),
        ),
      ).resolves.toBeUndefined();
    },
  );

  it('finds the latest session resume store for an issue by updatedAt', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
    const issueUrl = 'https://github.com/org/repo/issues/9';
    const paths = resolveEnsemblePaths({ repoRoot: tempDir });

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
      const path = paths.canonicalSessionResumeStorePath(url, agentId);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(resumeStore)}\n`, 'utf8');
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

  it('includes slug resume candidates whose stored repoRoot belongs to another clone', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
    const issueUrl = 'https://github.com/org/repo/issues/9';
    const agentId = 'latest-cross-clone-agent';
    const path = canonicalSessionResumeStorePath({
      repoRoot: tempDir,
      issueUrl,
      conductorAgentId: agentId,
    });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify(
        baseResumeStore({
          conductorAgentId: agentId,
          issueUrl,
          repoRoot: '/another/clone',
          updatedAt: 500,
        }),
      )}\n`,
      'utf8',
    );

    await expect(
      findLatestSessionResumeStoreForIssue({ repoRoot: tempDir, issueUrl }),
    ).resolves.toMatchObject({
      conductorAgentId: agentId,
      repoRoot: '/another/clone',
    });
  });

  it('prefers close or abort candidates and excludes exit for --continue', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
    const issueUrl = 'https://github.com/org/repo/issues/9';
    const paths = resolveEnsemblePaths({ repoRoot: tempDir });
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
      const path = paths.canonicalSessionResumeStorePath(issueUrl, agentId);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
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

  it('does not list or resume a project-local SessionResumeStore', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
    const agentId = 'legacy-project-agent';
    const legacyPath = join(
      legacySessionResumeStoreDir(tempDir),
      `${agentId}.json`,
    );
    await mkdir(legacySessionResumeStoreDir(tempDir), { recursive: true });
    const legacyText = `${JSON.stringify(
        baseResumeStore({
          conductorAgentId: agentId,
          repoRoot: tempDir,
          updatedAt: 123,
        }),
      )}\n`;
    await writeFile(legacyPath, legacyText, 'utf8');

    await expect(
      findLatestSessionResumeStoreForIssue({
        repoRoot: tempDir,
        issueUrl: 'https://github.com/org/repo/issues/1',
      }),
    ).resolves.toBeUndefined();

    await expect(
      requireSessionResumeStoreForResume({
        repoRoot: tempDir,
        conductorAgentId: agentId,
        issueUrl: 'https://github.com/org/repo/issues/1',
      }),
    ).rejects.toThrow(SessionResumeStoreNotFoundError);
    await expect(
      loadSessionResumeStore(
        resolveEnsemblePaths({ repoRoot: tempDir }).canonicalSessionResumeStorePath(
          'https://github.com/org/repo/issues/1',
          agentId,
        ),
      ),
    ).resolves.toBeUndefined();
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe(legacyText);
  });

  it('keeps deprecated sidecar API aliases compatible through the deprecation period', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
    const options = {
      repoRoot: tempDir,
      issueUrl: TEST_ISSUE_URL,
      conductorAgentId: 'legacy-agent',
    };
    const path = sessionResumeStorePath(options);
    const state: SessionSidecar = baseResumeStore({
      conductorAgentId: options.conductorAgentId,
      repoRoot: tempDir,
      updatedAt: 123,
    });

    expect(SESSION_SIDECAR_VERSION).toBe(SESSION_RESUME_STORE_VERSION);
    expect(
      sessionSidecarDir({
        repoRoot: tempDir,
        issueUrl: TEST_ISSUE_URL,
      }),
    ).toBe(
      sessionResumeStoreDir({
        repoRoot: tempDir,
        issueUrl: TEST_ISSUE_URL,
      }),
    );
    expect(sessionSidecarPath(options)).toBe(path);
    assertSessionSidecarMatches(state, {
      conductorAgentId: options.conductorAgentId,
      issueUrl: state.issueUrl,
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
    ).resolves.toMatchObject({
      conductorAgentId: options.conductorAgentId,
      issueUrl: state.issueUrl,
    });
    await expect(
      requireSessionSidecarForResume({
        repoRoot: tempDir,
        conductorAgentId: 'missing-agent',
        issueUrl: state.issueUrl,
      }),
    ).rejects.toMatchObject({
      name: SessionSidecarNotFoundError.name,
      code: 'SESSION_SIDECAR_NOT_FOUND',
    });
  });
});
