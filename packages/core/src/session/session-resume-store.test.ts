import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeAcpSpawnEnvDigest } from '../acp/resolve-acp-spawn.js';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import {
  assertSessionResumeStoreMatches,
  assertSessionSidecarMatches,
  canonicalSessionResumeStorePath,
  findLatestSessionResumeStoreForIssue,
  findLatestSessionSidecarForIssue,
  findSessionResumeStore,
  legacySessionResumeStoreDir,
  listLocatedSessionResumeStores,
  listSessionSidecars,
  loadSessionResumeStore,
  loadSessionSidecar,
  requireSessionResumeStoreForResume,
  requireLocatedSessionResumeStoreForResume,
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
      conductorAgentId: 'agent-1',
    });
    expect(path).toBe(
      join(sessionResumeStoreDir(tempDir), 'agent-1.json'),
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
    tempDir = await createHome('ensemble-session-resume-store-');
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
    tempDir = await createHome('ensemble-session-resume-store-');
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
    tempDir = await createHome('ensemble-session-resume-store-');
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
    expect(loaded).not.toHaveProperty('cursorBootstrapComplete');
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

  it('treats a saved ACP model configuration digest as diagnostic metadata', () => {
    const resumeStore = baseResumeStore({
      conductorAgentId: 'agent-acp-model-digest',
      acpModelConfigDigest: 'a'.repeat(64),
    });

    expect(() =>
      assertSessionResumeStoreMatches(resumeStore, {
        conductorAgentId: 'agent-acp-model-digest',
        issueUrl: resumeStore.issueUrl,
        repoRoot: resumeStore.repoRoot,
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
    tempDir = await createHome('ensemble-session-resume-store-');

    await expect(
      requireSessionResumeStoreForResume({
        repoRoot: tempDir,
        conductorAgentId: 'missing-agent',
      }),
    ).rejects.toThrow(SessionResumeStoreNotFoundError);
  });

  it('prefers the canonical slug store over duplicate hash and project files and reports the selected paths', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
    const agentId = 'duplicate-agent';
    const issueUrl = 'https://github.com/org/repo/issues/9';
    const paths = resolveEnsemblePaths({ repoRoot: tempDir });
    const hashPath = sessionResumeStorePath({
      repoRoot: tempDir,
      conductorAgentId: agentId,
    });
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
    expect(diagnostics).toMatchObject([
      {
        conductorAgentId: agentId,
        selectedPath: slugPath,
        selectedLocation: 'canonical-slug',
        candidates: [
          {
            path: slugPath,
            location: 'canonical-slug',
            hasHarnessSocketPath: true,
          },
          {
            path: hashPath,
            location: 'user-path-hash',
            hasHarnessSocketPath: false,
          },
          {
            path: projectPath,
            location: 'project-legacy',
            hasHarnessSocketPath: false,
          },
        ],
      },
    ]);
    await expect(
      requireSessionResumeStoreForResume({
        repoRoot: tempDir,
        conductorAgentId: agentId,
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

  it.each([
    { location: 'user-path-hash' as const, malformed: '{invalid json' },
    { location: 'project-legacy' as const, malformed: '{invalid json' },
  ])(
    'keeps slug and other candidates discoverable when a $location store is malformed',
    async ({ location, malformed }) => {
      tempDir = await createHome('ensemble-session-resume-store-');
      const agentId = `malformed-${location}`;
      const peerAgentId = `valid-peer-${location}`;
      const issueUrl = 'https://github.com/org/repo/issues/9';
      const peerIssueUrl = 'https://github.com/org/other-repo/issues/10';
      const paths = resolveEnsemblePaths({ repoRoot: tempDir });
      const malformedPath =
        location === 'user-path-hash'
          ? paths.sessionResumeStorePath(agentId)
          : paths.legacySessionResumeStorePath(agentId);
      const peerLocation =
        location === 'user-path-hash' ? 'project-legacy' : 'user-path-hash';
      const peerPath =
        peerLocation === 'user-path-hash'
          ? paths.sessionResumeStorePath(peerAgentId)
          : paths.legacySessionResumeStorePath(peerAgentId);
      const slugPath = paths.canonicalSessionResumeStorePath(
        issueUrl,
        agentId,
      );
      for (const path of [malformedPath, peerPath, slugPath]) {
        await mkdir(dirname(path), { recursive: true });
      }
      await writeFile(malformedPath, `${malformed}\n`, 'utf8');
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
          expect.objectContaining({ path: peerPath, location: peerLocation }),
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
        `${malformed}\n`,
      );
      await expect(loadSessionResumeStore(malformedPath)).rejects.toThrow(
        /Invalid session resume store/,
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
      const hashPath = sessionResumeStorePath({
        repoRoot: tempDir,
        conductorAgentId: agentId,
      });
      const raw = `${contents}\n`;
      await mkdir(dirname(hashPath), { recursive: true });
      await writeFile(hashPath, raw, 'utf8');

      await expect(listLocatedSessionResumeStores(tempDir)).resolves.toEqual([]);
      await expect(
        requireLocatedSessionResumeStoreForResume({
          repoRoot: tempDir,
          conductorAgentId: agentId,
        }),
      ).rejects.toThrow(SessionResumeStoreNotFoundError);
      await expect(loadSessionResumeStore(hashPath)).rejects.toThrow(
        /Invalid session resume store/,
      );
      await expect(readFile(hashPath, 'utf8')).resolves.toBe(raw);
    },
  );

  it('selects a canonical slug Store from another clone over an older hash copy without losing its live socket', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
    const currentRepoRoot = join(tempDir, 'current-clone');
    const originRepoRoot = join(tempDir, 'origin-clone');
    const agentId = 'cross-clone-duplicate-agent';
    const issueUrl = 'https://github.com/org/repo/issues/9';
    const paths = resolveEnsemblePaths({ repoRoot: currentRepoRoot });
    const hashPath = paths.sessionResumeStorePath(agentId);
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
    expect(diagnostics[0]).toMatchObject({
      selectedPath: slugPath,
      candidates: [
        { path: slugPath, hasHarnessSocketPath: true },
        { path: hashPath, hasHarnessSocketPath: false },
      ],
    });
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
    'promotes a %s ResumeStore to slug without changing its legacy source',
    async (location) => {
      tempDir = await createHome('ensemble-session-resume-store-');
      const repoRoot = join(tempDir, 'repo');
      const agentId = `promote-${location}`;
      const issueUrl = 'https://github.com/org/repo/issues/9';
      const paths = resolveEnsemblePaths({ repoRoot });
      const sourcePath =
        location === 'user-path-hash'
          ? paths.sessionResumeStorePath(agentId)
          : paths.legacySessionResumeStorePath(agentId);
      const slugPath = paths.canonicalSessionResumeStorePath(
        issueUrl,
        agentId,
      );
      const sourceStore = baseResumeStore({
        conductorAgentId: agentId,
        repoRoot,
        issueUrl,
        updatedAt: 123,
      });
      const sourceText = `${JSON.stringify(sourceStore, null, 2)}\n`;
      await mkdir(dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, sourceText, 'utf8');

      const located = await requireLocatedSessionResumeStoreForResume({
        repoRoot,
        issueUrl,
        conductorAgentId: agentId,
      });

      expect(located).toMatchObject({
        path: slugPath,
        location: 'canonical-slug',
        resumeStore: { updatedAt: 123, repoRoot },
      });
      await expect(readFile(sourcePath, 'utf8')).resolves.toBe(sourceText);
      await expect(loadSessionResumeStore(slugPath)).resolves.toMatchObject({
        conductorAgentId: agentId,
        issueUrl,
        updatedAt: 123,
      });
    },
  );

  it('finds the latest session resume store for an issue by updatedAt', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
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

  it('reads a legacy project SessionResumeStore and copies it into the canonical slug directory', async () => {
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
    ).resolves.toMatchObject({ conductorAgentId: agentId });

    const migrated = await requireSessionResumeStoreForResume({
      repoRoot: tempDir,
      conductorAgentId: agentId,
    });
    expect(migrated.updatedAt).toBe(123);
    await expect(
      readFile(
        resolveEnsemblePaths({ repoRoot: tempDir }).canonicalSessionResumeStorePath(
          'https://github.com/org/repo/issues/1',
          agentId,
        ),
        'utf8',
      ),
    ).resolves.toContain(agentId);
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe(legacyText);
  });

  it('keeps deprecated sidecar API aliases compatible through the deprecation period', async () => {
    tempDir = await createHome('ensemble-session-resume-store-');
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
