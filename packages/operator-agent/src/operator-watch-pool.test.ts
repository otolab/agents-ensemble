import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fork, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPEN_QUESTION_CONTROL_METHODS,
  OpenQuestionControlRemoteError,
  findSessionResumeStore,
  resolveEnsemblePaths,
  sendOpenQuestionControlRequest,
  startOpenQuestionControlServer,
  type SessionObservationSnapshot,
} from '@agents-ensemble/core';
import { listUserLocatedSessionResumeStoresPage } from '@agents-ensemble/core/operator-runtime';
import {
  createOperatorDispatchQueue,
  formatOperatorDispatchBatch,
} from './operator-dispatch.js';
import {
  createOperatorWatchPool,
  createRegisterRepositoryWatchTool,
  createRegisterSessionWatchTool,
  createUnregisterRepositoryWatchTool,
  operatorWatchStatePath,
} from './operator-watch-pool.js';
import { createListOperatorSessionsTool } from './list-operator-sessions-tool.js';

const DEFAULT_ISSUE_URL = 'https://github.com/example/repo/issues/1';

function currentWatchStatePath(_repoRoot: string): string {
  return operatorWatchStatePath(
    join(process.env.ENSEMBLE_USER_ROOT ?? '', ''),
    'default',
    DEFAULT_ISSUE_URL,
  );
}

function startWatchPollProcess(
  userEnsembleRoot: string,
  conductorAgentId: string,
  mode?: 'crash-after-persist',
): {
  child: ChildProcess;
  ready: Promise<void>;
  poll: () => void;
  result: Promise<number>;
  persistedBeforeEnqueue: Promise<void>;
  exit: Promise<void>;
} {
  const fixture = fileURLToPath(
    new URL('../test/fixtures/watch-state-poll-child.mjs', import.meta.url),
  );
  const child = fork(
    fixture,
    [userEnsembleRoot, conductorAgentId, ...(mode ? [mode] : [])],
    {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (count: number) => void;
  let rejectResult!: (error: Error) => void;
  let resolvePersistedBeforeEnqueue!: () => void;
  let rejectPersistedBeforeEnqueue!: (error: Error) => void;
  let resultSettled = false;
  const persistedBeforeEnqueue = new Promise<void>((resolve, reject) => {
    resolvePersistedBeforeEnqueue = resolve;
    rejectPersistedBeforeEnqueue = reject;
  });
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<number>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let readySettled = false;
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const payload = message as {
      type?: string;
      count?: number;
      error?: string;
    };
    if (payload.type === 'ready') {
      readySettled = true;
      resolveReady();
    } else if (payload.type === 'persisted-before-enqueue') {
      resolvePersistedBeforeEnqueue();
    } else if (payload.type === 'done' && typeof payload.count === 'number') {
      resultSettled = true;
      resolveResult(payload.count);
    } else if (payload.type === 'error') {
      const error = new Error(payload.error ?? 'watch poll child failed');
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      if (mode) rejectPersistedBeforeEnqueue(error);
      if (!mode) rejectResult(error);
    }
  });
  child.once('error', (error) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    if (mode) rejectPersistedBeforeEnqueue(error);
    if (!mode) rejectResult(error);
  });
  child.once('exit', (code) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error(`watch poll child exited before ready (${code}): ${stderr}`));
    }
    if (!resultSettled && !mode) {
      rejectResult(
        new Error(`watch poll child exited before returning a result (${code}): ${stderr}`),
      );
    }
  });
  const exit = new Promise<void>((resolve, reject) => {
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`watch poll child exited with code ${code}: ${stderr}`));
    });
  });

  return {
    child,
    ready,
    poll: () => {
      child.send({ type: 'poll' });
    },
    result,
    persistedBeforeEnqueue,
    exit,
  };
}

describe('operator watch pool', () => {
  let repoRoot = '';
  let homeRoot = '';
  let closeServers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    homeRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-home-'));
    vi.stubEnv('HOME', homeRoot);
    vi.stubEnv('ENSEMBLE_USER_ROOT', join(homeRoot, '.ensemble'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const close of closeServers) await close();
    closeServers = [];
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    repoRoot = '';
    if (homeRoot) await rm(homeRoot, { recursive: true, force: true });
    homeRoot = '';
    vi.unstubAllEnvs();
  });

  it('resolves canonical watch storage from a valid profile and Issue identity', () => {
    const userRoot = join(homeRoot, '.ensemble');
    expect(
      operatorWatchStatePath(
        userRoot,
        'work',
        'https://github.com/Example/Repo/issues/42',
      ),
    ).toBe(
      join(
        userRoot,
        'operator-agents',
        'work',
        'watch',
        'github.com',
        'example',
        'repo',
        'watch-state.json',
      ),
    );
    expect(() => operatorWatchStatePath(userRoot, 'work', '')).toThrow();
    expect(() =>
      operatorWatchStatePath(
        userRoot,
        '../legacy',
        'https://github.com/example/repo/issues/42',
      ),
    ).toThrow(/Invalid operator-agent profile name/u);
  });

  it('discovers repository runs, preserves first-observed times across restarts, and stops only automatic watches', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-repository-watch-'));
    const existingIssue = 'https://github.com/example/repo/issues/1';
    const manualIssue = 'https://github.com/example/repo/issues/2';
    const newIssue = 'https://github.com/example/repo/issues/3';
    await writeResumeStore('baseline-run', 900, undefined, existingIssue);
    await writeResumeStore('manual-run', 800, undefined, manualIssue);
    const dispatchQueue = createOperatorDispatchQueue();
    let pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
    await pool.register('manual-run', {
      pollIntervalMs: 60_000,
      debounceMs: 0,
    });
    try {
      const registration = await createRegisterRepositoryWatchTool(pool).execute({
        githubRepo: 'example/repo',
        scanIntervalMs: 5_000,
        pollIntervalMs: 60_000,
      });
      const registrationResult = JSON.parse(
        registration.content[0]!.text,
      ) as { baselineRunCount: number; enabledAt: number };
      expect(registrationResult.baselineRunCount).toBe(2);
      const baselineObservedAt = pool.getSessionTrackingInfo(
        'baseline-run',
        existingIssue,
      ).firstObservedAt;
      expect(baselineObservedAt).not.toBeNull();
      expect(
        pool.getSessionTrackingInfo('manual-run', manualIssue),
      ).toMatchObject({
        repositoryWatchEnabled: true,
        watchEnabled: true,
        watchSource: 'manual',
      });

      const duplicate = await pool.registerRepository('example/repo', {
        scanIntervalMs: 5_000,
        pollIntervalMs: 60_000,
      });
      expect(duplicate.enabledAt).toBe(registrationResult.enabledAt);
      expect(duplicate.managedSessionIds).toEqual(['baseline-run']);
      expect(
        pool.getSessionTrackingInfo('baseline-run', existingIssue)
          .firstObservedAt,
      ).toBe(baselineObservedAt);
      await expect(pool.unregister('baseline-run')).resolves.toBe(true);
      expect(
        pool.getSessionTrackingInfo('baseline-run', existingIssue),
      ).toMatchObject({
        watchEnabled: false,
        watchReason: 'suppressed',
      });

      await writeResumeStore('new-run', 1, undefined, newIssue);
      await expect(pool.scanRepositoriesOnce()).resolves.toBe(1);
      const newObservedAt = pool.getSessionTrackingInfo(
        'new-run',
        newIssue,
      ).firstObservedAt;
      expect(newObservedAt).not.toBeNull();
      expect(newObservedAt).toBeGreaterThan(baselineObservedAt!);
      expect(
        pool.getSessionTrackingInfo('new-run', newIssue),
      ).toMatchObject({
        repositoryWatchEnabled: true,
        watchEnabled: true,
        watchSource: 'repository_auto',
        repositoryScan: { status: 'fresh', error: null },
      });

      const newRunPath = resolveEnsemblePaths({
        repoRoot,
      }).canonicalSessionResumeStorePath(newIssue, 'new-run');
      await writeFile(newRunPath, '{ invalid json');
      await expect(pool.scanRepositoriesOnce()).rejects.toThrow();
      expect(
        pool.getSessionTrackingInfo('new-run', newIssue).repositoryScan,
      ).toMatchObject({ status: 'stale', error: 'scan_failed' });
      await writeResumeStore('new-run', 1, undefined, newIssue);
      await expect(pool.scanRepositoriesOnce()).resolves.toBe(0);

      pool.close();
      pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
      expect(pool.listRepositoryWatches()).toHaveLength(1);
      expect(
        pool.getSessionTrackingInfo('new-run', newIssue).firstObservedAt,
      ).toBe(newObservedAt);
      expect(
        pool.getSessionTrackingInfo('baseline-run', existingIssue).watchReason,
      ).toBe('suppressed');
      expect(pool.list().map((watch) => watch.conductorAgentId).sort()).toEqual([
        'manual-run',
        'new-run',
      ]);

      const stopped = await createUnregisterRepositoryWatchTool(pool).execute({
        githubRepo: 'example/repo',
      });
      expect(JSON.parse(stopped.content[0]!.text)).toEqual({
        githubRepo: 'example/repo',
        removed: true,
      });
      expect(pool.list().map((watch) => watch.conductorAgentId)).toEqual([
        'manual-run',
      ]);
      expect(
        pool.getSessionTrackingInfo('new-run', newIssue),
      ).toMatchObject({
        firstObservedAt: newObservedAt,
        repositoryWatchEnabled: false,
        watchEnabled: false,
        watchReason: 'repository_watch_stopped',
      });
      await pool.registerRepository('example/repo', {
        scanIntervalMs: 5_000,
        pollIntervalMs: 60_000,
      });
      expect(
        pool.getSessionTrackingInfo('baseline-run', existingIssue),
      ).toMatchObject({
        firstObservedAt: baselineObservedAt,
        watchEnabled: true,
        watchSource: 'repository_auto',
      });
    } finally {
      pool.close();
    }
  });

  it('caps repository auto watches at 20, keeps overflow visible, and honors registration scope', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-repository-watch-cap-'));
    await Promise.all(
      Array.from({ length: 21 }, (_, index) =>
        writeResumeStore(
          `cap-${String(index).padStart(2, '0')}`,
          index,
          undefined,
          `https://github.com/example/repo/issues/${100 + index}`,
        ),
      ),
    );
    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: createOperatorDispatchQueue(),
      profileIncludes: ['example/*'],
      repoFilters: ['example/repo'],
    });
    try {
      const config = await pool.registerRepository('example/repo', {
        scanIntervalMs: 5_000,
        pollIntervalMs: 60_000,
      });
      expect(config.managedSessionIds).toHaveLength(21);
      expect(pool.list()).toHaveLength(20);
      expect(
        pool.getSessionTrackingInfo(
          'cap-20',
          'https://github.com/example/repo/issues/120',
        ),
      ).toMatchObject({
        watchEnabled: false,
        watchReason: 'auto_watch_capacity',
      });
      await expect(
        pool.registerRepository('outside/repo'),
      ).rejects.toThrow('outside the selected profile include scope');
      await expect(
        pool.registerRepository('example/other'),
      ).rejects.toThrow('outside the active --repo-filter scope');
    } finally {
      pool.close();
    }
  });

  it('limits repository registrations per profile and preserves duplicate, restart, and freed-slot semantics', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-repository-watch-registration-limit-'));
    const dispatchQueue = createOperatorDispatchQueue();
    let pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
    const repositoryAt = (index: number) =>
      `example/repo-${String(index).padStart(2, '0')}`;
    const registerTool = createRegisterRepositoryWatchTool(pool);
    try {
      for (let index = 0; index < 19; index += 1) {
        await registerTool.execute({
          githubRepo: repositoryAt(index),
          scanIntervalMs: 60_000,
          pollIntervalMs: 60_000,
        });
      }
      expect(pool.listRepositoryWatches()).toHaveLength(19);

      const twentiethRegistration = await registerTool.execute({
        githubRepo: repositoryAt(19),
        scanIntervalMs: 60_000,
        pollIntervalMs: 60_000,
      });
      const twentiethConfig = JSON.parse(
        twentiethRegistration.content[0]!.text,
      ) as { enabledAt: number; githubRepo: string };
      expect(twentiethConfig).toMatchObject({
        githubRepo: repositoryAt(19),
      });
      expect(pool.listRepositoryWatches()).toHaveLength(20);

      await expect(
        registerTool.execute({ githubRepo: repositoryAt(20) }),
      ).rejects.toThrow(
        'At most 20 repositories can be watched in one profile.',
      );
      expect(pool.listRepositoryWatches()).toHaveLength(20);
      expect(
        pool.listRepositoryWatches().some(
          (watch) => watch.githubRepo === repositoryAt(20),
        ),
      ).toBe(false);

      const duplicateAtLimit = await registerTool.execute({
        githubRepo: repositoryAt(19),
        scanIntervalMs: 90_000,
        pollIntervalMs: 55_000,
      });
      expect(JSON.parse(duplicateAtLimit.content[0]!.text)).toMatchObject({
        enabledAt: twentiethConfig.enabledAt,
        githubRepo: repositoryAt(19),
        scanIntervalMs: 90_000,
        pollIntervalMs: 55_000,
      });
      expect(pool.listRepositoryWatches()).toHaveLength(20);

      pool.close();
      pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
      expect(pool.listRepositoryWatches()).toHaveLength(20);
      const restartedRegisterTool = createRegisterRepositoryWatchTool(pool);
      await expect(
        restartedRegisterTool.execute({
          githubRepo: repositoryAt(20),
        }),
      ).rejects.toThrow(
        'At most 20 repositories can be watched in one profile.',
      );
      const duplicateAfterRestart = await restartedRegisterTool.execute({
        githubRepo: repositoryAt(19),
        scanIntervalMs: 120_000,
      });
      expect(JSON.parse(duplicateAfterRestart.content[0]!.text)).toMatchObject({
        enabledAt: twentiethConfig.enabledAt,
        githubRepo: repositoryAt(19),
        scanIntervalMs: 120_000,
      });
      expect(pool.listRepositoryWatches()).toHaveLength(20);

      const unregistered = await createUnregisterRepositoryWatchTool(
        pool,
      ).execute({ githubRepo: repositoryAt(0) });
      expect(JSON.parse(unregistered.content[0]!.text)).toEqual({
        githubRepo: repositoryAt(0),
        removed: true,
      });
      expect(pool.listRepositoryWatches()).toHaveLength(19);

      const registrationAfterUnregister = await restartedRegisterTool.execute({
        githubRepo: repositoryAt(20),
        scanIntervalMs: 60_000,
        pollIntervalMs: 60_000,
      });
      expect(JSON.parse(registrationAfterUnregister.content[0]!.text)).toMatchObject({
        githubRepo: repositoryAt(20),
      });
      expect(pool.listRepositoryWatches()).toHaveLength(20);
    } finally {
      pool.close();
    }
  });

  it('discovers and auto-watches new runs beyond the 500-store page boundary without duplicates', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-repository-watch-page-boundary-'));
    const baselineIssue = 'https://github.com/example/repo/issues/1';
    const sharedNewIssue = 'https://github.com/example/repo/issues/900';
    await Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        writeResumeStore(
          `baseline-${String(index).padStart(3, '0')}`,
          index + 2,
          undefined,
          baselineIssue,
        ),
      ),
    );
    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: createOperatorDispatchQueue(),
    });
    try {
      const registered = await pool.registerRepository('example/repo', {
        scanIntervalMs: 60_000,
        pollIntervalMs: 60_000,
      });
      expect(registered.managedSessionIds).toHaveLength(500);

      // These older flush times place both new runs on page two of the
      // updatedAt-descending inventory, despite sharing one Issue.
      await writeResumeStore('boundary-run-a', 1, undefined, sharedNewIssue);
      await writeResumeStore('boundary-run-b', 0, undefined, sharedNewIssue);
      await expect(pool.scanRepositoriesOnce()).resolves.toBe(2);

      const discovered = pool.listRepositoryWatches()[0]!;
      expect(discovered.managedSessionIds).toHaveLength(502);
      expect(discovered.managedSessionIds).toEqual(
        expect.arrayContaining(['boundary-run-a', 'boundary-run-b']),
      );
      expect(
        discovered.managedSessionIds.filter(
          (id) => id === 'boundary-run-a' || id === 'boundary-run-b',
        ),
      ).toEqual(['boundary-run-a', 'boundary-run-b']);
      for (const conductorAgentId of ['boundary-run-a', 'boundary-run-b']) {
        expect(
          pool.getSessionTrackingInfo(conductorAgentId, sharedNewIssue),
        ).toMatchObject({
          repositoryWatchEnabled: true,
          watchEnabled: true,
          watchSource: 'repository_auto',
          watchReason: 'watching',
        });
        expect(
          pool.list().filter(
            (watch) => watch.conductorAgentId === conductorAgentId,
          ),
        ).toHaveLength(1);
      }

      await expect(pool.scanRepositoriesOnce()).resolves.toBe(0);
      expect(pool.listRepositoryWatches()[0]?.managedSessionIds).toHaveLength(
        502,
      );
      expect(
        pool.list().filter((watch) =>
          ['boundary-run-a', 'boundary-run-b'].includes(
            watch.conductorAgentId,
          ),
        ),
      ).toHaveLength(2);
    } finally {
      pool.close();
    }
  });

  it('does not load project-local operator watch state', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-legacy-'));
    const legacyPath = join(
      repoRoot,
      '.ensemble',
      'operator-agent',
      'watch-state.json',
    );
    const legacyState = {
      version: 1,
      watches: {
        'session-one': {
          conductorAgentId: 'session-one',
          pollIntervalMs: 60_000,
          debounceMs: 0,
        },
      },
      cursors: {},
      pendingReports: [],
    };
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, JSON.stringify(legacyState), 'utf8');

    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: createOperatorDispatchQueue(),
    });
    try {
      expect(pool.list()).toEqual([]);
      expect(JSON.parse(await readFile(legacyPath, 'utf8'))).toEqual(legacyState);
    } finally {
      pool.close();
    }
  });

  it('continues an existing slug-keyed watch state without reading or overwriting the stale hash copy', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-slug-state-'));
    const agentId = '607';
    const userRoot = join(homeRoot, '.ensemble');
    const paths = resolveEnsemblePaths({ repoRoot });
    const issueUrl = 'https://github.com/example/watch-state/issues/607';
    await writeResumeStore(agentId, 1, undefined, issueUrl);
    const canonicalPath = operatorWatchStatePath(
      userRoot,
      'default',
      issueUrl,
    );
    const hashPath = join(
      userRoot,
      'operator-agent',
      paths.repoKey,
      'watch-state.json',
    );
    const projectPath = join(
      repoRoot,
      '.ensemble',
      'operator-agent',
      'watch-state.json',
    );
    const state = (pollIntervalMs: number) => ({
      version: 1,
      watches: {
        [agentId]: {
          conductorAgentId: agentId,
          pollIntervalMs,
          debounceMs: 0,
        },
      },
      cursors: {},
      pendingReports: [],
    });
    await mkdir(dirname(canonicalPath), { recursive: true });
    await mkdir(dirname(hashPath), { recursive: true });
    await mkdir(dirname(projectPath), { recursive: true });
    await writeFile(canonicalPath, JSON.stringify(state(30_000)), 'utf8');
    await writeFile(hashPath, JSON.stringify(state(50_000)), 'utf8');
    await writeFile(projectPath, JSON.stringify(state(70_000)), 'utf8');

    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: createOperatorDispatchQueue(),
    });
    try {
      expect(pool.list()).toEqual([
        {
          conductorAgentId: agentId,
          pollIntervalMs: 30_000,
          debounceMs: 0,
        },
      ]);
      await pool.register(agentId, {
        pollIntervalMs: 60_000,
        debounceMs: 0,
      });
      expect(
        JSON.parse(await readFile(canonicalPath, 'utf8')).watches[agentId]
          .pollIntervalMs,
      ).toBe(60_000);
      expect(
        JSON.parse(await readFile(hashPath, 'utf8')).watches[agentId]
          .pollIntervalMs,
      ).toBe(50_000);
      expect(
        JSON.parse(await readFile(projectPath, 'utf8')).watches[agentId]
          .pollIntervalMs,
      ).toBe(70_000);
    } finally {
      pool.close();
    }
  });

  it('ignores old hash watch state when the profile store is missing', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-state-migrate-'));
    const paths = resolveEnsemblePaths({ repoRoot });
    const agentId = 'watch-state-migrate';
    const issueUrl = 'https://github.com/example/watch-state-migrate/issues/607';
    const slugStorePath = paths.canonicalSessionResumeStorePath(issueUrl, agentId);
    await mkdir(dirname(slugStorePath), { recursive: true });
    await writeFile(
      slugStorePath,
      JSON.stringify({
        version: 1,
        conductorAgentId: agentId,
        issueUrl,
        repoRoot,
        profile: { workers: [] },
        openQuestions: [],
        sequence: 0,
        workers: {},
        updatedAt: 1,
      }),
      'utf8',
    );
    const state = {
      version: 1,
      watches: {
        [agentId]: {
          conductorAgentId: agentId,
          pollIntervalMs: 30_000,
          debounceMs: 0,
        },
      },
      cursors: {},
      pendingReports: [],
    };
    const hashStatePath = join(
      join(homeRoot, '.ensemble'),
      'operator-agent',
      paths.repoKey,
      'watch-state.json',
    );
    const slugStatePath = operatorWatchStatePath(
      join(homeRoot, '.ensemble'),
      'default',
      issueUrl,
    );
    await mkdir(dirname(hashStatePath), { recursive: true });
    await writeFile(hashStatePath, JSON.stringify(state), 'utf8');

    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: createOperatorDispatchQueue(),
    });
    try {
      expect(pool.list()).toEqual([]);
      await expect(readFile(slugStatePath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        readFile(hashStatePath, 'utf8').then((text) => JSON.parse(text)),
      ).resolves.toMatchObject(state);
    } finally {
      pool.close();
    }
  });

  it('does not load a legacy hash watch bundle for multiple Issue sessions', async () => {
    const userRoot = join(homeRoot, '.ensemble');
    const firstIssue = 'https://github.com/org/one/issues/1';
    const secondIssue = 'https://github.com/org/two/issues/2';
    const firstId = 'legacy-watch-one';
    const secondId = 'legacy-watch-two';
    const paths = resolveEnsemblePaths({
      repoRoot: '/old/checkout',
      userEnsembleRoot: userRoot,
    });
    for (const [conductorAgentId, issueUrl] of [
      [firstId, firstIssue],
      [secondId, secondIssue],
    ]) {
      const path = paths.canonicalSessionResumeStorePath(
        issueUrl,
        conductorAgentId,
      );
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          conductorAgentId,
          issueUrl,
          repoRoot: '/old/checkout',
          profile: { workers: [] },
          openQuestions: [],
          sequence: 0,
          workers: {},
          updatedAt: 1,
        }),
      );
    }
    const legacyPath = join(
      userRoot,
      'operator-agent',
      'a'.repeat(64),
      'watch-state.json',
    );
    const legacyState = {
      version: 1,
      watches: Object.fromEntries(
        [firstId, secondId].map((conductorAgentId) => [
          conductorAgentId,
          { conductorAgentId, pollIntervalMs: 60_000, debounceMs: 0 },
        ]),
      ),
      cursors: Object.fromEntries(
        [firstId, secondId].map((conductorAgentId, sequence) => [
          conductorAgentId,
          {
            sequence: sequence + 1,
            questionFingerprints: {},
            statusFingerprints: {},
          },
        ]),
      ),
      messageListeners: Object.fromEntries(
        [firstId, secondId].map((conductorAgentId) => [
          conductorAgentId,
          { conductorAgentId, messageDebounceMs: 1_000 },
        ]),
      ),
      messageCursors: { [firstId]: 10, [secondId]: 20 },
      pendingReports: [firstIssue, secondIssue].map((issueUrl, index) => ({
        reportId: `legacy-report-${index + 1}`,
        reportType: 'open_question',
        conductorAgentId: index === 0 ? firstId : secondId,
        issueUrl,
        text: `pending ${index + 1}`,
        debounceMs: 0,
      })),
    };
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, JSON.stringify(legacyState));
    const stores = await listUserLocatedSessionResumeStoresPage(
      {},
      { userEnsembleRoot: userRoot },
    );
    expect(stores.total).toBe(2);
    expect(
      stores.sessions.map(({ resumeStore }) => resumeStore.conductorAgentId),
    ).toEqual(expect.arrayContaining([firstId, secondId]));

    const pool = await createOperatorWatchPool({
      userEnsembleRoot: userRoot,
      profile: 'work',
      dispatchQueue: createOperatorDispatchQueue(),
    });
    try {
      expect(pool.list()).toHaveLength(0);
      expect(pool.listConductorMessageListens()).toHaveLength(0);
      const firstPath = operatorWatchStatePath(userRoot, 'work', firstIssue);
      const secondPath = operatorWatchStatePath(userRoot, 'work', secondIssue);
      await expect(readFile(firstPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(secondPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(legacyPath, 'utf8')).resolves.toBe(
        JSON.stringify(legacyState),
      );
    } finally {
      pool.close();
    }
  });

  it('preserves unassigned watch bundles and emits one diagnostic per unresolved session', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-unassigned-'));
    const issueUrl = DEFAULT_ISSUE_URL;
    const userRoot = join(homeRoot, '.ensemble');
    const defaultPath = operatorWatchStatePath(userRoot, 'default', issueUrl);
    const wrongScopeIssueUrl =
      'https://github.com/other/repo/issues/99';
    const wrongScopePath = operatorWatchStatePath(
      userRoot,
      'default',
      wrongScopeIssueUrl,
    );
    const cursor = {
      sequence: 7,
      questionFingerprints: { 'inq-1': 'question-fingerprint' },
      questionSnapshots: {
        'inq-1': {
          question: 'Keep this cursor?',
          status: 'open',
          askedAt: 1,
        },
      },
      statusFingerprints: { '2': 'status-fingerprint' },
    };
    const ids = [
      'missing-store-session',
      'ambiguous-store-session',
      'report-url-mismatch-session',
    ];
    const unassignedState = {
      version: 1,
      watches: Object.fromEntries(
        ids.map((id) => [
          id,
          { conductorAgentId: id, pollIntervalMs: 60_000, debounceMs: 0 },
        ]),
      ),
      cursors: Object.fromEntries(ids.map((id) => [id, cursor])),
      messageListeners: Object.fromEntries(
        ids.map((id) => [
          id,
          { conductorAgentId: id, messageDebounceMs: 1_000 },
        ]),
      ),
      messageCursors: Object.fromEntries(ids.map((id) => [id, 17])),
      pendingReports: ids.map((id, index) => ({
        reportId: `unassigned-report-${index + 1}`,
        reportType: 'open_question',
        conductorAgentId: id,
        issueUrl:
          id === 'report-url-mismatch-session'
            ? 'https://github.com/example/repo/issues/89'
            : issueUrl,
        text: `pending text ${index + 1}`,
        debounceMs: 0,
      })),
    };
    const wrongScopeState = {
      ...unassignedState,
      watches: {
        'wrong-scope-session': {
          conductorAgentId: 'wrong-scope-session',
          pollIntervalMs: 60_000,
          debounceMs: 0,
        },
      },
      cursors: { 'wrong-scope-session': cursor },
      messageListeners: {},
      messageCursors: {},
      pendingReports: [
        {
          reportId: 'wrong-scope-report',
          reportType: 'open_question',
          conductorAgentId: 'wrong-scope-session',
          issueUrl: 'https://github.com/example/repo/issues/99',
          text: 'keep source scope',
          debounceMs: 0,
        },
      ],
    };
    await writeResumeStore('verified-session', 1, undefined, issueUrl);
    await writeResumeStore(
      'ambiguous-store-session',
      2,
      undefined,
      'https://github.com/example-one/repo/issues/20',
    );
    await writeResumeStore(
      'ambiguous-store-session',
      3,
      undefined,
      'https://github.com/example-two/repo/issues/21',
    );
    await writeResumeStore(
      'report-url-mismatch-session',
      4,
      undefined,
      'https://github.com/example/repo/issues/88',
    );
    await writeResumeStore(
      'wrong-scope-session',
      5,
      undefined,
      'https://github.com/example/repo/issues/99',
    );
    await mkdir(dirname(defaultPath), { recursive: true });
    await mkdir(dirname(wrongScopePath), { recursive: true });
    await writeFile(defaultPath, JSON.stringify(unassignedState));
    await writeFile(wrongScopePath, JSON.stringify(wrongScopeState));
    const warnings: string[] = [];
    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue,
      onError: (message) => warnings.push(message),
    });
    try {
      // Unverified reports must not be dispatched merely because the source
      // watch-state file contains an Issue URL.
      expect(dispatchQueue.pendingEventCount).toBe(0);
      expect(warnings).toHaveLength(4);
      for (const id of [
        ...ids,
        'wrong-scope-session',
      ]) {
        expect(warnings.filter((warning) => warning.includes(`for ${id} `)))
          .toHaveLength(1);
      }
      expect(
        warnings.find((warning) =>
          warning.includes('for ambiguous-store-session '),
        ),
      ).toContain('multiple SessionResumeStores');
      expect(
        warnings.find((warning) => warning.includes('for missing-store-session ')),
      ).toContain('no unique verified Issue session');

      await pool.register('verified-session', {
        pollIntervalMs: 60_000,
        debounceMs: 0,
      });
      await pool.register('verified-session', {
        pollIntervalMs: 60_000,
        debounceMs: 0,
      });
      // Repeated persist calls do not repeat warnings or discard unresolved
      // cursors, listeners, watches, or pending reports.
      expect(warnings).toHaveLength(4);
      const storedDefault = JSON.parse(
        await readFile(defaultPath, 'utf8'),
      ) as typeof unassignedState & {
        watches: Record<string, unknown>;
        cursors: Record<string, unknown>;
        messageListeners: Record<string, unknown>;
        messageCursors: Record<string, number>;
        pendingReports: Array<{ reportId: string }>;
      };
      expect(storedDefault.watches['verified-session']).toMatchObject({
        conductorAgentId: 'verified-session',
      });
      for (const id of ids) {
        expect(storedDefault.watches[id]).toBeDefined();
        expect(storedDefault.cursors[id]).toEqual(cursor);
        expect(storedDefault.messageListeners[id]).toBeDefined();
        expect(storedDefault.messageCursors[id]).toBe(17);
      }
      expect(storedDefault.pendingReports.map((report) => report.reportId)).toEqual([
        'unassigned-report-1',
        'unassigned-report-2',
        'unassigned-report-3',
      ]);

      const storedWrongScope = JSON.parse(
        await readFile(wrongScopePath, 'utf8'),
      ) as typeof wrongScopeState;
      expect(storedWrongScope.watches['wrong-scope-session']).toBeDefined();
      expect(storedWrongScope.pendingReports[0]?.reportId).toBe(
        'wrong-scope-report',
      );
      await expect(
        readFile(
          operatorWatchStatePath(userRoot, 'default', issueUrl),
          'utf8',
        ).then((text) => JSON.parse(text).watches['wrong-scope-session']),
      ).resolves.toBeUndefined();
    } finally {
      pool.close();
    }

    // Once the missing Store becomes uniquely discoverable with the same
    // Issue identity, its exact pending report and cursors can be restored.
    await writeResumeStore('missing-store-session', 6, undefined, issueUrl);
    const recoveryQueue = createOperatorDispatchQueue();
    const recoveryWarnings: string[] = [];
    const recoveryPool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: recoveryQueue,
      onError: (message) => recoveryWarnings.push(message),
    });
    try {
      expect(recoveryWarnings).toHaveLength(3);
      expect(recoveryQueue.pendingEventCount).toBe(1);
      expect(recoveryPool.list()).toContainEqual({
        conductorAgentId: 'missing-store-session',
        pollIntervalMs: 60_000,
        debounceMs: 0,
      });
      const retry = recoveryQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(retry.events).toMatchObject([
        {
          reportId: 'unassigned-report-1',
          conductorAgentId: 'missing-store-session',
          issueUrl,
          text: 'pending text 1',
        },
      ]);
      const stored = JSON.parse(
        await readFile(defaultPath, 'utf8'),
      ) as {
        cursors: Record<string, unknown>;
        messageListeners: Record<string, unknown>;
        messageCursors: Record<string, number>;
        pendingReports: Array<{ reportId: string }>;
      };
      expect(stored.cursors['missing-store-session']).toEqual(cursor);
      expect(stored.messageListeners['missing-store-session']).toBeDefined();
      expect(stored.messageCursors['missing-store-session']).toBe(17);
      await recoveryPool.acknowledge(retry.events);
      expect(
        JSON.parse(await readFile(defaultPath, 'utf8')).pendingReports,
      ).toMatchObject([
        { reportId: 'unassigned-report-2' },
        { reportId: 'unassigned-report-3' },
      ]);
    } finally {
      recoveryPool.close();
    }
  });

  it('refreshes the Issue mapping when a Store appears after pool startup', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-late-store-'));
    const dispatchQueue = createOperatorDispatchQueue();
    const warnings: string[] = [];
    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue,
      onError: (message) => warnings.push(message),
    });
    try {
      await writeResumeStore('late-session', 1);
      await pool.register('late-session', {
        pollIntervalMs: 60_000,
        debounceMs: 0,
      });

      const stored = JSON.parse(
        await readFile(currentWatchStatePath(repoRoot), 'utf8'),
      ) as {
        watches: Record<string, unknown>;
      };
      expect(stored.watches['late-session']).toMatchObject({
        conductorAgentId: 'late-session',
        pollIntervalMs: 60_000,
      });
      expect(warnings).toEqual([]);
    } finally {
      pool.close();
    }
  });

  it('quarantines a previously verified bundle if its Store becomes ambiguous or moves Issues', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-changed-issue-'));
    const oldIssueUrl = DEFAULT_ISSUE_URL;
    const newIssueUrl = 'https://github.com/other/repo/issues/10';
    const userRoot = join(homeRoot, '.ensemble');
    const oldStatePath = operatorWatchStatePath(
      userRoot,
      'default',
      oldIssueUrl,
    );
    const newStatePath = operatorWatchStatePath(
      userRoot,
      'default',
      newIssueUrl,
    );
    const reportId = 'pending-before-issue-change';
    await writeResumeStore('changed-session', 1, undefined, oldIssueUrl);
    await mkdir(dirname(oldStatePath), { recursive: true });
    await writeFile(
      oldStatePath,
      JSON.stringify({
        version: 1,
        watches: {
          'changed-session': {
            conductorAgentId: 'changed-session',
            pollIntervalMs: 60_000,
            debounceMs: 0,
          },
        },
        cursors: {
          'changed-session': {
            sequence: 1,
            questionFingerprints: {},
            statusFingerprints: {},
          },
        },
        messageListeners: {},
        messageCursors: {},
        pendingReports: [
          {
            reportId,
            reportType: 'open_question',
            conductorAgentId: 'changed-session',
            issueUrl: oldIssueUrl,
            text: 'Keep the old Issue report unassigned',
            debounceMs: 0,
          },
        ],
      }),
    );

    const dispatchQueue = createOperatorDispatchQueue();
    const warnings: string[] = [];
    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue,
      onError: (message) => warnings.push(message),
    });
    try {
      expect(dispatchQueue.pendingEventCount).toBe(1);
      const oldStorePath = resolveEnsemblePaths({
        repoRoot,
      }).canonicalSessionResumeStorePath(oldIssueUrl, 'changed-session');
      await writeResumeStore('changed-session', 2, undefined, newIssueUrl);

      expect(await pool.pollOnce('changed-session')).toBe(0);
      expect(dispatchQueue.pendingEventCount).toBe(0);
      expect(pool.list()).toEqual([]);
      await expect(
        pool.register('changed-session'),
      ).rejects.toThrow('ambiguous across saved Issues');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('multiple SessionResumeStores');

      await rm(oldStorePath);
      await expect(
        pool.register('changed-session'),
      ).rejects.toThrow('source repository scope does not match');
      expect(warnings).toHaveLength(2);

      await writeResumeStore(
        'unrelated-session',
        3,
        undefined,
        'https://github.com/another/repo/issues/11',
      );
      await pool.register('unrelated-session', {
        pollIntervalMs: 60_000,
        debounceMs: 0,
      });
      const preserved = JSON.parse(
        await readFile(oldStatePath, 'utf8'),
      ) as { pendingReports: Array<{ reportId: string }> };
      expect(preserved.pendingReports).toMatchObject([{ reportId }]);
      await expect(
        readFile(newStatePath, 'utf8').then((text) =>
          JSON.parse(text).pendingReports,
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      pool.close();
    }
  });

  it('watches multiple sessions through live UDS and persists cursors without replay', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    let liveSnapshot: SessionObservationSnapshot = {
      sequence: 1,
      openQuestions: [
        {
          id: 'inq-1',
          question: 'Review the release?',
          responseType: 'yes_no',
          source: 'conductor',
          status: 'open',
          askedAt: 10,
        },
      ],
      sessionState: {
        current: { statusLine: 'CI 待ち', reportedAt: 20 },
        history: [],
      },
    };
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => liveSnapshot,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());
    await writeResumeStore('live-one', 1, liveServer.socketPath);
    await writeResumeStore('offline-two', 2, '/tmp/no-such-ensemble-socket');
    await writeOfflineSnapshots('offline-two', {
      sequence: 1,
      questions: [
        {
          id: 'inq-1',
          question: 'Choose an approach?',
          responseType: 'choice',
          source: 'conductor',
          status: 'open',
          askedAt: 30,
        },
      ],
      statusLine: 'レビュー中',
      reportedAt: 40,
    });

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue,
    });
    try {
      await pool.register('live-one', { pollIntervalMs: 60_000, debounceMs: 0 });
      await pool.register('offline-two', { pollIntervalMs: 60_000, debounceMs: 0 });
      // Existing questions in a watch's first observation establish a
      // baseline and do not create Open Question reports.
      expect(await pool.pollOnce('live-one')).toBe(1);
      expect(await pool.pollOnce('offline-two')).toBe(1);
      expect(pool.getLiveStatus('live-one')).toMatchObject({
        connectivity: 'reachable',
        checkedAt: expect.any(Number),
        unreachableSince: null,
      });
      expect(pool.getLiveStatus('offline-two')).toMatchObject({
        connectivity: 'unreachable',
        checkedAt: expect.any(Number),
        unreachableSince: expect.any(Number),
      });
      expect(dispatchQueue.pendingEventCount).toBe(2);
      for (const sessionId of ['live-one', 'offline-two']) {
        const baseline = dispatchQueue.takeBatch(
          { continuationConsumed: false },
          Date.now(),
        )!;
        expect(baseline.sourceKey).toBe(`session:${sessionId}`);
        expect(baseline.events).toHaveLength(1);
        expect(baseline.events[0]).toMatchObject({
          type: 'report',
          reportType: 'session_state',
        });
        await pool.acknowledge(baseline.events);
      }
      expect(dispatchQueue.pendingEventCount).toBe(0);

      liveSnapshot = {
        ...liveSnapshot,
        sequence: 2,
        openQuestions: [
          ...liveSnapshot.openQuestions,
          {
            id: 'inq-2',
            question: 'New live question?',
            responseType: 'text',
            source: 'conductor',
            status: 'open',
            askedAt: 11,
          },
        ],
        sessionState: {
          current: { statusLine: 'CI 完了', reportedAt: 21 },
          history: [],
        },
      };
      await writeOfflineSnapshots('offline-two', {
        sequence: 2,
        questions: [
          {
            id: 'inq-1',
            question: 'Choose an approach?',
            responseType: 'choice',
            source: 'conductor',
            status: 'open',
            askedAt: 30,
          },
          {
            id: 'inq-2',
            question: 'New offline question?',
            responseType: 'text',
            source: 'conductor',
            status: 'open',
            askedAt: 31,
          },
        ],
        statusLine: 'レビュー中',
        reportedAt: 40,
      });
      expect(await pool.pollOnce('live-one')).toBe(2);
      expect(await pool.pollOnce('offline-two')).toBe(1);
      expect(dispatchQueue.pendingEventCount).toBe(3);

      const firstBatch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      );
      expect(firstBatch?.sourceKey).toBe('session:live-one');
      expect(firstBatch?.events.map((event) =>
        event.type === 'report' ? event.reportType : event.type,
      )).toEqual(['open_question', 'session_state']);
      expect(firstBatch?.events.map((event) => event.text).join('\n')).toContain(
        'New live question?',
      );
      expect(firstBatch?.events.map((event) => event.text).join('\n')).toContain(
        'CI 完了',
      );
      expect(dispatchQueue.pendingEventCount).toBe(1);
      await pool.acknowledge(firstBatch!.events);

      expect(await pool.pollOnce('live-one')).toBe(0);
      expect(await pool.pollOnce('offline-two')).toBe(0);
      const stored = JSON.parse(
        await readFile(currentWatchStatePath(repoRoot), 'utf8'),
      ) as { cursors: Record<string, { sequence: number }> };
      expect(stored.cursors['live-one']?.sequence).toBe(2);
      expect(stored.cursors['offline-two']?.sequence).toBe(2);
      pool.close();

      const resumedQueue = createOperatorDispatchQueue();
      const resumedPool = await createOperatorWatchPool({
        repoRoot,
        dispatchQueue: resumedQueue,
      });
      try {
        expect(resumedQueue.pendingEventCount).toBe(1);
        expect(
          resumedQueue.takeBatch(
            { continuationConsumed: false },
            Date.now(),
          )?.sourceKey,
        ).toBe('session:offline-two');
      } finally {
        resumedPool.close();
      }
    } finally {
      pool.close();
    }
  });

  it('counts only unanswered questions and re-baselines legacy total counts after restart', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-question-count-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    let snapshot: SessionObservationSnapshot = {
      sequence: 1,
      openQuestions: [
        {
          id: 'inq-1',
          question: 'Still open?',
          responseType: 'text',
          source: 'conductor',
          status: 'open',
          askedAt: 10,
        },
        {
          id: 'inq-2',
          question: 'Already answered?',
          responseType: 'text',
          source: 'conductor',
          status: 'answered',
          answer: 'Yes.',
          answeredBy: 'operator',
          answeredAt: 15,
          askedAt: 11,
        },
      ],
    };
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => snapshot,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());
    const issueUrl = 'https://github.com/example/repo/issues/72';
    const sessionId = 'question-count-session';
    await writeResumeStore(sessionId, 1, liveServer.socketPath, issueUrl);
    const dispatchQueue = createOperatorDispatchQueue();
    let pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
    const getObservation = () =>
      pool.getSessionTrackingInfo(sessionId, issueUrl).questionCountObservation;
    try {
      await pool.register(sessionId, {
        pollIntervalMs: 60_000,
        debounceMs: 0,
      });
      await pool.pollOnce(sessionId);
      expect(getObservation()).toMatchObject({
        metric: 'unanswered_open_questions',
        current: { count: 1, source: 'uds' },
      });

      pool.close();
      pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
      snapshot = {
        sequence: 2,
        openQuestions: [
          {
            id: 'inq-1',
            question: 'Still open?',
            responseType: 'text',
            source: 'conductor',
            status: 'answered',
            answer: 'Done.',
            answeredBy: 'operator',
            answeredAt: 20,
            askedAt: 10,
          },
          {
            id: 'inq-2',
            question: 'Already answered?',
            responseType: 'text',
            source: 'conductor',
            status: 'answered',
            answer: 'Yes.',
            answeredBy: 'operator',
            answeredAt: 15,
            askedAt: 11,
          },
        ],
      };
      await pool.pollOnce(sessionId);
      const answered = getObservation();
      expect(answered).toMatchObject({
        metric: 'unanswered_open_questions',
        current: { count: 0, source: 'uds' },
        previous: { count: 1, source: 'uds' },
      });
      const listTool = createListOperatorSessionsTool(
        { userEnsembleRoot: join(homeRoot, '.ensemble') },
        undefined,
        undefined,
        (id, url) => pool.getSessionTrackingInfo(id, url),
      );
      const listed = JSON.parse(
        (await listTool.execute({ includeGithub: false })).content[0]!.text,
      ) as {
        sessions: Array<{
          conductorAgentId: string;
          openQuestionObservation: Record<string, unknown>;
        }>;
      };
      expect(listed.sessions[0]).toMatchObject({
        conductorAgentId: sessionId,
        openQuestionObservation: {
          metric: 'unanswered_open_questions',
          current: { count: 0, source: 'uds' },
          previous: { count: 1, source: 'uds' },
          delta: -1,
          comparedAt: expect.any(Number),
        },
      });

      const statePath = currentWatchStatePath(repoRoot);
      const savedState = JSON.parse(await readFile(statePath, 'utf8')) as {
        cursors: Record<
          string,
          { questionCountObservation: Record<string, unknown> }
        >;
      };
      delete savedState.cursors[sessionId]!.questionCountObservation.metric;
      await writeFile(statePath, `${JSON.stringify(savedState)}\n`, 'utf8');

      pool.close();
      pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
      snapshot = {
        sequence: 3,
        openQuestions: [
          ...snapshot.openQuestions,
          {
            id: 'inq-3',
            question: 'A new unanswered question?',
            responseType: 'text',
            source: 'conductor',
            status: 'open',
            askedAt: 30,
          },
        ],
      };
      await pool.pollOnce(sessionId);
      expect(getObservation()).toMatchObject({
        metric: 'unanswered_open_questions',
        current: { count: 1, source: 'uds' },
      });
      expect(getObservation()?.previous).toBeUndefined();
    } finally {
      pool.close();
    }
  });

  it('holds an answered question and status update together until both holds release', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-held-answer-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    let snapshot: SessionObservationSnapshot = {
      sequence: 1,
      openQuestions: [
        {
          id: 'inq-1',
          question: 'Continue the release?',
          responseType: 'yes_no',
          source: 'conductor',
          status: 'open',
          askedAt: 10,
        },
      ],
      sessionState: {
        current: { statusLine: 'operator response pending', reportedAt: 20 },
        history: [],
      },
    };
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => snapshot,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());
    await writeResumeStore('held-answer-session', 1, liveServer.socketPath);

    const dispatchQueue = createOperatorDispatchQueue();
    dispatchQueue.setConversationHold(true);
    dispatchQueue.setHold(true);
    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue,
    });
    try {
      await pool.register('held-answer-session', {
        pollIntervalMs: 60_000,
        debounceMs: 0,
      });
      expect(await pool.pollOnce('held-answer-session')).toBe(1);
      expect(dispatchQueue.heldEventCount).toBe(1);

      snapshot = {
        sequence: 2,
        openQuestions: [
          {
            id: 'inq-1',
            question: 'Continue the release?',
            responseType: 'yes_no',
            source: 'conductor',
            status: 'answered',
            answer: 'yes',
            answeredBy: 'operator',
            askedAt: 10,
            answeredAt: 30,
          },
        ],
        sessionState: {
          current: { statusLine: 'release resumed', reportedAt: 31 },
          history: [],
        },
      };
      expect(await pool.pollOnce('held-answer-session')).toBe(2);
      expect(dispatchQueue.heldEventCount).toBe(3);

      expect(dispatchQueue.setHold(false)).toEqual({
        heldEventCount: 3,
        releasedEventCount: 0,
      });
      expect(dispatchQueue.conversationHold).toBe(true);
      expect(dispatchQueue.pendingEventCount).toBe(0);
      expect(dispatchQueue.setConversationHold(false)).toEqual({
        heldEventCount: 0,
        releasedEventCount: 3,
      });

      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.sourceKey).toBe('session:held-answer-session');
      expect(batch.events.map((event) =>
        event.type === 'report' ? event.reportType : event.type,
      )).toEqual(['session_state', 'open_question', 'session_state']);
      const text = formatOperatorDispatchBatch(batch.events);
      expect(text).toContain('回答: yes');
      expect(text).toContain('answeredBy: operator');
      expect(text).toContain('release resumed');
      expect(await pool.pollOnce('held-answer-session')).toBe(0);
      await pool.acknowledge(batch.events);
      expect(
        JSON.parse(
          await readFile(currentWatchStatePath(repoRoot), 'utf8'),
        ).pendingReports,
      ).toEqual([]);
    } finally {
      pool.close();
    }
  });

  it('watches through the canonical slug socket without reading a path-hash duplicate', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-duplicate-'));
    const agentId = 'duplicate-live-session';
    const issueUrl = 'https://github.com/example/live-socket/issues/607';
    const paths = resolveEnsemblePaths({ repoRoot });
    let liveSnapshot: SessionObservationSnapshot = {
      sequence: 1,
      openQuestions: [
        {
          id: 'inq-live',
          question: 'Observed from the active harness?',
          responseType: 'text',
          source: 'conductor',
          status: 'open',
          askedAt: 10,
        },
      ],
    };
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => liveSnapshot,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());

    const hashPath = join(paths.legacyHashSessionsDir, `${agentId}.json`);
    const slugPath = paths.canonicalSessionResumeStorePath(issueUrl, agentId);
    const hashStore = {
      version: 1,
      conductorAgentId: agentId,
      issueUrl,
      repoRoot,
      profile: { workers: [], agents: {} },
      openQuestions: [],
      sequence: 0,
      workers: {},
      updatedAt: 900,
    };
    const slugStore = {
      ...hashStore,
      harnessSocketPath: liveServer.socketPath,
      updatedAt: 100,
    };
    await mkdir(dirname(hashPath), { recursive: true });
    await mkdir(dirname(slugPath), { recursive: true });
    await writeFile(hashPath, JSON.stringify(hashStore), 'utf8');
    await writeFile(slugPath, JSON.stringify(slugStore), 'utf8');

    const dispatchQueue = createOperatorDispatchQueue();
    const diagnostics: string[] = [];
    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue,
      onError: (message) => diagnostics.push(message),
    });
    try {
      await pool.register(agentId, { pollIntervalMs: 60_000, debounceMs: 0 });
      expect(diagnostics).toHaveLength(0);
      await pool.pollOnce(agentId);
      expect(pool.getLiveStatus(agentId)).toMatchObject({
        connectivity: 'reachable',
      });

      liveSnapshot = {
        sequence: 2,
        openQuestions: [
          ...liveSnapshot.openQuestions,
          {
            id: 'inq-live-new',
            question: 'A later question from the live harness?',
            responseType: 'yes_no',
            source: 'conductor',
            status: 'open',
            askedAt: 20,
          },
        ],
      };
      await expect(pool.pollOnce(agentId)).resolves.toBe(1);
      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      );
      expect(batch?.events[0]).toMatchObject({
        type: 'report',
        reportType: 'open_question',
      });
      expect(batch?.events[0]?.type === 'report' && batch.events[0].text).toContain(
        'A later question from the live harness?',
      );
    } finally {
      pool.close();
    }
  });

  it('uses canonical slug YAML for snapshot watch fallback when duplicate hash YAML is stale', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-slug-yaml-'));
    const agentId = 'duplicate-offline-session';
    const issueUrl = 'https://github.com/example/offline-yaml/issues/608';
    const paths = resolveEnsemblePaths({ repoRoot });
    const resumeStore = {
      version: 1,
      conductorAgentId: agentId,
      issueUrl,
      repoRoot,
      profile: { workers: [], agents: {} },
      openQuestions: [],
      sequence: 0,
      workers: {},
      updatedAt: 1,
    };
    const hashPath = join(paths.legacyHashSessionsDir, `${agentId}.json`);
    const slugPath = paths.canonicalSessionResumeStorePath(issueUrl, agentId);
    await mkdir(dirname(hashPath), { recursive: true });
    await mkdir(dirname(slugPath), { recursive: true });
    await writeFile(hashPath, JSON.stringify(resumeStore), 'utf8');
    await writeFile(slugPath, JSON.stringify(resumeStore), 'utf8');

    const hashYamlPath = join(
      paths.legacyHashSessionsDir,
      agentId,
      'open-questions.yaml',
    );
    const slugYamlPath = paths.canonicalOpenQuestionsPath(issueUrl, agentId);
    await mkdir(dirname(hashYamlPath), { recursive: true });
    await mkdir(dirname(slugYamlPath), { recursive: true });
    await writeFile(
      hashYamlPath,
      [
        'version: 1',
        'sequence: 1',
        'openQuestions:',
        '  - id: inq-1',
        '    question: stale hash question',
        '    responseType: text',
        '    source: conductor',
        '    status: open',
        '    askedAt: 1',
        '',
      ].join('\n'),
      'utf8',
    );
    const writeSlugQuestions = async (sequence: number, questions: string[]) => {
      await writeFile(
        slugYamlPath,
        [
          'version: 1',
          `sequence: ${sequence}`,
          'openQuestions:',
          ...questions.flatMap((question, index) => [
            `  - id: inq-${index + 1}`,
            `    question: ${JSON.stringify(question)}`,
            '    responseType: text',
            '    source: conductor',
            '    status: open',
            `    askedAt: ${index + 1}`,
          ]),
          '',
        ].join('\n'),
        'utf8',
      );
    };
    await writeSlugQuestions(1, ['initial canonical question']);

    await expect(
      findSessionResumeStore(repoRoot, agentId),
    ).resolves.toMatchObject({
      resumeStore: { issueUrl, conductorAgentId: agentId },
      location: 'canonical-slug',
    });
    const dispatchQueue = createOperatorDispatchQueue();
    const diagnostics: string[] = [];
    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue,
      onError: (message) => diagnostics.push(message),
    });
    try {
      await pool.register(agentId, { pollIntervalMs: 60_000, debounceMs: 0 });
      expect(await pool.pollOnce(agentId)).toBe(0);
      expect(diagnostics).toHaveLength(0);
      await writeSlugQuestions(2, [
        'initial canonical question',
        'new canonical slug question',
      ]);
      expect(await pool.pollOnce(agentId)).toBe(1);
      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      );
      expect(diagnostics).toHaveLength(0);
      expect(batch?.events[0]?.type === 'report' && batch.events[0].text).toContain(
        'new canonical slug question',
      );
    } finally {
      pool.close();
    }
  });

  it('reads canonical slug snapshots and ignores clone-local hash snapshots', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-location-yaml-'));
    const paths = resolveEnsemblePaths({ repoRoot });
    const issueUrl = 'https://github.com/example/canonical-snapshots/issues/607';
    const agentId = 'canonical-snapshots';
    const resumeStore = {
      version: 1,
      conductorAgentId: agentId,
      issueUrl,
      repoRoot,
      profile: { workers: [], agents: {} },
      openQuestions: [],
      sequence: 0,
      workers: {},
      updatedAt: 1,
    };
    const canonicalStorePath = paths.canonicalSessionResumeStorePath(
      issueUrl,
      agentId,
    );
    const canonicalQuestionsPath = paths.canonicalOpenQuestionsPath(
      issueUrl,
      agentId,
    );
    const hashQuestionsPath = paths.legacyHashOpenQuestionsPath(agentId);
    await mkdir(dirname(canonicalStorePath), { recursive: true });
    await writeFile(canonicalStorePath, JSON.stringify(resumeStore), 'utf8');
    const writeQuestions = async (
      path: string,
      sequence: number,
      questions: string[],
    ) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        [
          'version: 1',
          `sequence: ${sequence}`,
          'openQuestions:',
          ...questions.flatMap((question, index) => [
            `  - id: inq-${index + 1}`,
            `    question: ${JSON.stringify(question)}`,
            '    responseType: text',
            '    source: conductor',
            '    status: open',
            `    askedAt: ${index + 1}`,
          ]),
          '',
        ].join('\n'),
        'utf8',
      );
    };
    await writeQuestions(canonicalQuestionsPath, 1, ['canonical question']);
    await writeQuestions(hashQuestionsPath, 1, ['legacy hash question']);

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
    try {
      await pool.register(agentId, { pollIntervalMs: 60_000, debounceMs: 0 });
      await expect(pool.pollOnce(agentId)).resolves.toBe(0);
      await writeQuestions(
        hashQuestionsPath,
        2,
        ['legacy hash question', 'new legacy hash question'],
      );
      await expect(pool.pollOnce(agentId)).resolves.toBe(0);
      await writeQuestions(
        canonicalQuestionsPath,
        2,
        ['canonical question', 'new canonical question'],
      );
      await expect(pool.pollOnce(agentId)).resolves.toBe(1);
      const reports = [0, 1]
        .flatMap(() =>
          dispatchQueue.takeBatch(
            { continuationConsumed: false },
            Date.now(),
          )?.events ?? [],
        )
        .filter((event) => event.type === 'report')
        .map((event) => event.type === 'report' ? event.text : '');
      expect(reports).toEqual(
        expect.arrayContaining([expect.stringContaining('new canonical question')]),
      );
      expect(reports.join('\n')).not.toContain('legacy hash question');
    } finally {
      pool.close();
    }
  });

  it('restores unacknowledged reports after restart and removes only acknowledged reports', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-retry-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    await writeResumeStore('session-retry', 1);
    await writeOfflineSnapshots('session-retry', {
      sequence: 1,
      questions: [
        {
          id: 'inq-1',
          question: 'Retry after cancellation?',
          responseType: 'text',
          source: 'conductor',
          status: 'open',
          askedAt: 10,
        },
      ],
      statusLine: 'waiting',
      reportedAt: 20,
    });

    const firstQueue = createOperatorDispatchQueue();
    const firstPool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: firstQueue,
    });
    await firstPool.register('session-retry', {
      pollIntervalMs: 60_000,
      debounceMs: 0,
    });
    expect(await firstPool.pollOnce('session-retry')).toBe(1);
    expect(firstQueue.pendingEventCount).toBe(1);
    await writeOfflineSnapshots('session-retry', {
      sequence: 2,
      questions: [
        {
          id: 'inq-1',
          question: 'Retry after cancellation?',
          responseType: 'text',
          source: 'conductor',
          status: 'open',
          askedAt: 10,
        },
        {
          id: 'inq-2',
          question: 'New report to retry?',
          responseType: 'text',
          source: 'conductor',
          status: 'open',
          askedAt: 11,
        },
      ],
      statusLine: 'waiting',
      reportedAt: 20,
    });
    expect(await firstPool.pollOnce('session-retry')).toBe(1);
    const firstAttempt = firstQueue.takeBatch(
      { continuationConsumed: false },
      Date.now(),
    )!;
    expect(firstAttempt.events).toHaveLength(2);
    expect(firstAttempt.events.map((event) =>
      event.type === 'report' ? event.reportType : event.type,
    )).toEqual(['session_state', 'open_question']);
    expect(firstAttempt.events[1]?.text).toContain('New report to retry?');
    const firstReportIds = firstAttempt.events.map((event) =>
      event.type === 'report' ? event.reportId : undefined,
    );
    expect(firstReportIds.every(Boolean)).toBe(true);
    expect(firstQueue.pendingEventCount).toBe(0);
    firstPool.close();

    const resumedQueue = createOperatorDispatchQueue();
    const resumedPool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: resumedQueue,
    });
    try {
      expect(resumedQueue.pendingEventCount).toBe(2);
      const retry = resumedQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(retry.events.map((event) =>
        event.type === 'report' ? event.reportId : undefined,
      )).toEqual(firstReportIds);

      const remainingReportId = firstReportIds[1]!;
      await resumedPool.acknowledge([retry.events[0]!]);
      const stored = JSON.parse(
        await readFile(currentWatchStatePath(repoRoot), 'utf8'),
      ) as { pendingReports: Array<{ reportId: string }> };
      expect(stored.pendingReports).toHaveLength(1);
      expect(stored.pendingReports[0]?.reportId).toBe(remainingReportId);
    } finally {
      resumedPool.close();
    }

    const finalQueue = createOperatorDispatchQueue();
    const finalPool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: finalQueue,
    });
    try {
      expect(finalQueue.pendingEventCount).toBe(1);
      const remaining = finalQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(remaining.events[0]?.reportId).toBe(firstReportIds[1]);
      await finalPool.acknowledge(remaining.events);
      expect(
        JSON.parse(
          await readFile(currentWatchStatePath(repoRoot), 'utf8'),
        ).pendingReports,
      ).toEqual([]);
    } finally {
      finalPool.close();
    }
  });

  it('uses the first snapshot as a silent baseline for existing open questions', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-baseline-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    let snapshot: SessionObservationSnapshot = {
      sequence: 1,
      openQuestions: [
        {
          id: 'inq-1',
          question: 'Already waiting?',
          responseType: 'text',
          source: 'conductor',
          status: 'open',
          askedAt: 10,
        },
      ],
    };
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => snapshot,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());
    await writeResumeStore('session-baseline', 1, liveServer.socketPath);

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
    try {
      await pool.register('session-baseline', {
        pollIntervalMs: 60_000,
        debounceMs: 0,
      });
      expect(await pool.pollOnce('session-baseline')).toBe(0);
      expect(dispatchQueue.pendingEventCount).toBe(0);

      snapshot = {
        sequence: 2,
        openQuestions: [
          ...snapshot.openQuestions,
          {
            id: 'inq-2',
            question: 'Added after watch started?',
            responseType: 'yes_no',
            source: 'conductor',
            status: 'open',
            askedAt: 20,
          },
        ],
      };
      expect(await pool.pollOnce('session-baseline')).toBe(1);
      expect(dispatchQueue.pendingEventCount).toBe(1);
      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events).toHaveLength(1);
      expect(batch.events[0]?.type).toBe('report');
      if (batch.events[0]?.type === 'report') {
        expect(batch.events[0].reportType).toBe('open_question');
        expect(batch.events[0].text).toContain('Added after watch started?');
        expect(batch.events[0].text).not.toContain('Already waiting?');
      }
    } finally {
      pool.close();
    }
  });

  it('hands off a persisted pending batch to an active peer after the producer exits before enqueue', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-handoff-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const agentId = 'handoff-session';
    const issueUrl = 'https://github.com/example/repo/issues/103';
    let observation: SessionObservationSnapshot = {
      sequence: 1,
      openQuestions: [],
      sessionState: {
        current: { statusLine: 'baseline', reportedAt: 20 },
        history: [],
      },
    };
    const server = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => observation,
    });
    closeServers.push(() => server.close());
    await writeResumeStore(agentId, 1, server.socketPath, issueUrl);

    const peerQueue = createOperatorDispatchQueue();
    const peerPool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: peerQueue,
    });
    const statePath = currentWatchStatePath(repoRoot);
    const stateOnDisk = async () =>
      JSON.parse(await readFile(statePath, 'utf8')) as {
        cursors: Record<string, { sequence: number }>;
        pendingReports: Array<{
          reportId: string;
          reportType: string;
          conductorAgentId: string;
        }>;
      };
    let producer: ReturnType<typeof startWatchPollProcess> | undefined;
    try {
      await peerPool.register(agentId, {
        pollIntervalMs: 60_000,
        debounceMs: 0,
      });
      expect(await peerPool.pollOnce(agentId)).toBe(1);
      const baseline = peerQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      await peerPool.acknowledge(baseline.events);
      expect((await stateOnDisk()).pendingReports).toEqual([]);

      observation = {
        sequence: 2,
        openQuestions: [
          {
            id: 'inq-2',
            question: 'First persisted update?',
            responseType: 'text',
            source: 'conductor',
            status: 'open',
            askedAt: 21,
          },
          {
            id: 'inq-3',
            question: 'Second persisted update?',
            responseType: 'text',
            source: 'conductor',
            status: 'open',
            askedAt: 22,
          },
        ],
        sessionState: {
          current: { statusLine: 'updated', reportedAt: 21 },
          history: [],
        },
      };

      producer = startWatchPollProcess(
        join(homeRoot, '.ensemble'),
        agentId,
        'crash-after-persist',
      );
      await producer.ready;
      producer.poll();
      await producer.persistedBeforeEnqueue;
      await expect(producer.exit).rejects.toThrow(/code 73/u);

      const persisted = await stateOnDisk();
      expect(persisted.cursors[agentId]?.sequence).toBe(2);
      expect(persisted.pendingReports.map((report) => report.reportType)).toEqual([
        'open_question',
        'open_question',
        'session_state',
      ]);
      const persistedIds = persisted.pendingReports.map((report) => report.reportId);
      expect(new Set(persistedIds).size).toBe(3);
      expect(peerQueue.pendingEventCount).toBe(0);

      peerQueue.setHold(true);
      // This is the next normal poll by the already-running peer. Its disk
      // refresh must recover the saved IDs even though its cursor has advanced.
      expect(await peerPool.pollOnce(agentId)).toBe(0);
      expect(peerQueue.heldEventCount).toBe(3);
      expect(peerQueue.pendingEventCount).toBe(0);
      await peerPool.refreshPendingReports?.();
      await peerPool.refreshPendingReports?.();
      expect(peerQueue.heldEventCount).toBe(3);

      peerQueue.setHold(false);
      const failedAttempt = peerQueue.takeBatch(
        { continuationConsumed: false },
        Date.now() + 1_000,
      )!;
      expect(failedAttempt.events.map((event) =>
        event.type === 'report' ? event.reportId : undefined,
      )).toEqual(persistedIds);
      expect(failedAttempt.events.map((event) =>
        event.type === 'report' ? event.text : '',
      )).toEqual([
        expect.stringContaining('First persisted update?'),
        expect.stringContaining('Second persisted update?'),
        expect.stringContaining('updated'),
      ]);

      for (const event of failedAttempt.events) peerQueue.requeue(event, 5_000);
      await peerPool.refreshPendingReports?.();
      expect(peerQueue.pendingEventCount).toBe(3);
      expect(
        peerQueue.takeBatch(
          { continuationConsumed: false },
          Date.now() + 1_000,
        ),
      ).toBeUndefined();

      const retry = peerQueue.takeBatch(
        { continuationConsumed: false },
        Date.now() + 6_000,
      )!;
      expect(retry.events.map((event) =>
        event.type === 'report' ? event.reportId : undefined,
      )).toEqual(persistedIds);

      const stateLock = new DatabaseSync(
        join(
          homeRoot,
          '.ensemble',
          'operator-agents',
          'default',
          'watch',
          'watch-state-lock.sqlite',
        ),
      );
      stateLock.exec('BEGIN IMMEDIATE');
      try {
        await expect(peerPool.acknowledge(retry.events)).rejects.toThrow(
          /Could not acquire operator watch state profile lock/u,
        );
      } finally {
        stateLock.exec('ROLLBACK');
        stateLock.close();
      }
      expect((await stateOnDisk()).pendingReports.map((report) => report.reportId))
        .toEqual(persistedIds);
      // The completed send is still in-flight locally. The pool does not put
      // it back on the normal dispatch queue, which would send it again.
      expect(peerQueue.pendingEventCount).toBe(0);
      await peerPool.refreshPendingReports?.();
      expect(
        peerQueue.takeBatch(
          { continuationConsumed: false },
          Date.now() + 1_000,
        ),
      ).toBeUndefined();

      // Retry the same ack after the profile lock is released. It is
      // idempotent and removes the durable report without another send.
      await peerPool.acknowledge(retry.events);
      await peerPool.acknowledge(retry.events);
      expect(peerQueue.pendingEventCount).toBe(0);
      expect((await stateOnDisk()).pendingReports).toEqual([]);
    } finally {
      peerPool.close();
      if (producer && producer.child.exitCode === null) {
        producer.child.kill();
      }
    }
  });

  it('serializes concurrent process polls and preserves each cursor and pending report', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-concurrent-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const sessions = [
      {
        id: 'concurrent-session-one',
        issueUrl: 'https://github.com/example/repo/issues/101',
        questionId: 'inq-1',
      },
      {
        id: 'concurrent-session-two',
        issueUrl: 'https://github.com/example/repo/issues/102',
        questionId: 'inq-1',
      },
    ];
    const observations = new Map(
      sessions.map((session) => [
        session.id,
        {
          sequence: 1,
          openQuestions: [],
          sessionState: {
            current: { statusLine: 'waiting', reportedAt: 20 },
            history: [],
          },
        } satisfies SessionObservationSnapshot,
      ]),
    );
    for (const session of sessions) {
      const server = await startOpenQuestionControlServer({
        listOpenQuestions: () => [],
        observeSession: async () => {
          // Make independent processes overlap after they have loaded their
          // initial state snapshot, reproducing the stale-snapshot write race.
          await new Promise((resolve) => setTimeout(resolve, 100));
          return observations.get(session.id)!;
        },
      });
      closeServers.push(() => server.close());
      await writeResumeStore(
        session.id,
        1,
        server.socketPath,
        session.issueUrl,
      );
    }

    const initialQueue = createOperatorDispatchQueue();
    const initialPool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: initialQueue,
    });
    const resumedPools: Array<Awaited<ReturnType<typeof createOperatorWatchPool>>> = [];
    const statePath = currentWatchStatePath(repoRoot);
    try {
      for (const session of sessions) {
        await initialPool.register(session.id, {
          pollIntervalMs: 60_000,
          debounceMs: 0,
        });
      }

      const afterRegistration = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as { watches: Record<string, unknown> };
      expect(Object.keys(afterRegistration.watches).sort()).toEqual(
        sessions.map((session) => session.id).sort(),
      );

      for (const session of sessions) {
        await initialPool.pollOnce(session.id);
      }
      const afterBaseline = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as {
        cursors: Record<string, { sequence: number }>;
        pendingReports: Array<{ conductorAgentId: string }>;
      };
      expect(
        sessions.map((session) => afterBaseline.cursors[session.id]?.sequence),
      ).toEqual([1, 1]);
      expect(
        afterBaseline.pendingReports.map((report) => report.conductorAgentId).sort(),
      ).toEqual(sessions.map((session) => session.id).sort());
      let baseline = initialQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      );
      while (baseline) {
        await initialPool.acknowledge(baseline.events);
        baseline = initialQueue.takeBatch(
          { continuationConsumed: false },
          Date.now(),
        );
      }

      for (const session of sessions) {
        observations.set(session.id, {
          sequence: 2,
          openQuestions: [
            {
              id: session.questionId,
              question: `${session.id} update`,
              responseType: 'text',
              source: 'conductor',
              status: 'open',
              askedAt: 21,
            },
          ],
          sessionState: {
            current: { statusLine: 'waiting', reportedAt: 20 },
            history: [],
          },
        });
      }
      initialPool.close();

      const userEnsembleRoot = join(homeRoot, '.ensemble');
      const pollProcesses = sessions.map((session) =>
        startWatchPollProcess(userEnsembleRoot, session.id),
      );
      try {
        await Promise.all(pollProcesses.map((process) => process.ready));
        expect(
          new Set(pollProcesses.map((process) => process.child.pid)).size,
        ).toBe(2);
        // Both OS processes start from the same pre-poll snapshot. The delayed
        // observation keeps the first transaction open while the second waits;
        // the second poll must reload state after acquiring the profile lock.
        for (const process of pollProcesses) process.poll();
        expect(await Promise.all(pollProcesses.map((process) => process.result))).toEqual([
          1,
          1,
        ]);
        await Promise.all(pollProcesses.map((process) => process.exit));
      } finally {
        for (const process of pollProcesses) {
          if (process.child.exitCode === null && process.child.connected) {
            process.child.kill();
          }
        }
      }

      const beforeRestart = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as {
        cursors: Record<string, { sequence: number }>;
        pendingReports: Array<{
          reportId: string;
          conductorAgentId: string;
        }>;
      };
      expect({
        cursorSequences: sessions.map(
          (session) => beforeRestart.cursors[session.id]?.sequence,
        ),
        pendingReportSessions: beforeRestart.pendingReports
          .map((report) => report.conductorAgentId)
          .sort(),
      }).toEqual({
        cursorSequences: [2, 2],
        pendingReportSessions: sessions.map((session) => session.id).sort(),
      });

      const resumedQueue = createOperatorDispatchQueue();
      const resumedPool = await createOperatorWatchPool({
        repoRoot,
        dispatchQueue: resumedQueue,
      });
      resumedPools.push(resumedPool);
      const replayed = [0, 1]
        .flatMap(() =>
          resumedQueue.takeBatch(
            { continuationConsumed: false },
            Date.now(),
          )?.events ?? [],
        )
        .filter((event) => event.type === 'report');
      const replayedIds = replayed.map((event) =>
        event.type === 'report' ? event.reportId : undefined,
      );
      expect(replayedIds.sort()).toEqual(
        beforeRestart.pendingReports.map((report) => report.reportId).sort(),
      );
      const acknowledgedReportId =
        replayed[0]?.type === 'report' ? replayed[0].reportId : undefined;
      expect(acknowledgedReportId).toBeDefined();

      await resumedPool.acknowledge([replayed[0]!]);
      const afterAcknowledgement = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as {
        cursors: Record<string, { sequence: number }>;
        pendingReports: Array<{ reportId: string }>;
      };
      expect(
        afterAcknowledgement.pendingReports.map((report) => report.reportId),
      ).toEqual(
        beforeRestart.pendingReports
          .map((report) => report.reportId)
          .filter((reportId) => reportId !== acknowledgedReportId),
      );
      expect(
        sessions.map((session) => afterAcknowledgement.cursors[session.id]?.sequence),
      ).toEqual([2, 2]);

      const finalQueue = createOperatorDispatchQueue();
      const finalPool = await createOperatorWatchPool({
        repoRoot,
        dispatchQueue: finalQueue,
      });
      resumedPools.push(finalPool);
      expect(finalQueue.pendingEventCount).toBe(1);
      expect(
        finalQueue.takeBatch(
          { continuationConsumed: false },
          Date.now(),
        )?.events.map((event) =>
          event.type === 'report' ? event.reportId : undefined,
        ),
      ).toEqual(afterAcknowledgement.pendingReports.map((report) => report.reportId));
    } finally {
      initialPool.close();
      for (const pool of resumedPools) pool.close();
    }
  });

  it('does not take over a live profile state owner after the lock artifact ages past 120 seconds', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-stale-lock-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const sessions = [
      {
        id: 'stale-lock-session-one',
        issueUrl: 'https://github.com/example/repo/issues/111',
      },
      {
        id: 'stale-lock-session-two',
        issueUrl: 'https://github.com/example/repo/issues/112',
      },
    ];
    const observations = new Map(
      sessions.map((session) => [
        session.id,
        {
          sequence: 1,
          openQuestions: [],
          sessionState: {
            current: { statusLine: 'waiting', reportedAt: 20 },
            history: [],
          },
        } satisfies SessionObservationSnapshot,
      ]),
    );
    let blockOwnerObservation = false;
    let markOwnerObservationStarted!: () => void;
    const ownerObservationStarted = new Promise<void>((resolve) => {
      markOwnerObservationStarted = resolve;
    });
    let releaseOwnerObservation!: () => void;
    const ownerObservationGate = new Promise<void>((resolve) => {
      releaseOwnerObservation = resolve;
    });
    const ownerServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => {
        if (blockOwnerObservation) {
          blockOwnerObservation = false;
          markOwnerObservationStarted();
          await ownerObservationGate;
        }
        return observations.get(sessions[0]!.id)!;
      },
    });
    closeServers.push(() => ownerServer.close());
    const contenderServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => observations.get(sessions[1]!.id)!,
    });
    closeServers.push(() => contenderServer.close());
    await writeResumeStore(
      sessions[0]!.id,
      1,
      ownerServer.socketPath,
      sessions[0]!.issueUrl,
    );
    await writeResumeStore(
      sessions[1]!.id,
      1,
      contenderServer.socketPath,
      sessions[1]!.issueUrl,
    );

    const initialQueue = createOperatorDispatchQueue();
    const initialPool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: initialQueue,
    });
    const processes: ReturnType<typeof startWatchPollProcess>[] = [];
    const statePath = currentWatchStatePath(repoRoot);
    const readState = async () =>
      JSON.parse(await readFile(statePath, 'utf8')) as {
        cursors: Record<string, { sequence: number }>;
        pendingReports: Array<{ reportId: string; conductorAgentId: string }>;
      };
    try {
      for (const session of sessions) {
        await initialPool.register(session.id, {
          pollIntervalMs: 60_000,
          debounceMs: 0,
        });
        await initialPool.pollOnce(session.id);
      }
      let baseline = initialQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      );
      while (baseline) {
        await initialPool.acknowledge(baseline.events);
        baseline = initialQueue.takeBatch(
          { continuationConsumed: false },
          Date.now(),
        );
      }
      const baselineState = await readState();
      expect(
        sessions.map((session) => baselineState.cursors[session.id]?.sequence),
      ).toEqual([1, 1]);
      expect(baselineState.pendingReports).toEqual([]);
      initialPool.close();

      for (const session of sessions) {
        observations.set(session.id, {
          sequence: 2,
          openQuestions: [
            {
              id: 'inq-2',
              question: `${session.id} changed`,
              responseType: 'text',
              source: 'conductor',
              status: 'open',
              askedAt: 21,
            },
          ],
          sessionState: {
            current: { statusLine: 'waiting', reportedAt: 20 },
            history: [],
          },
        });
      }

      const userEnsembleRoot = join(homeRoot, '.ensemble');
      const owner = startWatchPollProcess(userEnsembleRoot, sessions[0]!.id);
      const contender = startWatchPollProcess(userEnsembleRoot, sessions[1]!.id);
      processes.push(owner, contender);
      await Promise.all([owner.ready, contender.ready]);

      blockOwnerObservation = true;
      owner.poll();
      await ownerObservationStarted;

      const profileWatchDirectory = join(
        userEnsembleRoot,
        'operator-agents',
        'default',
        'watch',
      );
      const sqliteLockPath = join(
        profileWatchDirectory,
        'watch-state-lock.sqlite',
      );
      const legacyLeasePath = `${profileWatchDirectory}.lock`;
      let lockArtifactPath = sqliteLockPath;
      try {
        await stat(sqliteLockPath);
      } catch {
        lockArtifactPath = legacyLeasePath;
      }
      const staleTime = new Date(Date.now() - 121_000);
      await utimes(lockArtifactPath, staleTime, staleTime);
      expect((await stat(lockArtifactPath)).mtimeMs).toBeLessThan(
        Date.now() - 120_000,
      );

      const contenderOutcomePromise = contender.result.then(
        (count) => ({ type: 'completed' as const, count }),
        (error: unknown) => ({ type: 'failed' as const, error }),
      );
      contender.poll();
      const contenderOutcome = await contenderOutcomePromise;
      await contender.exit.catch(() => undefined);
      const stateAfterContender = await readState();

      releaseOwnerObservation();
      const ownerOutcome = await owner.result.then(
        (count) => ({ type: 'completed' as const, count }),
        (error: unknown) => ({ type: 'failed' as const, error }),
      );
      await owner.exit.catch(() => undefined);
      const stateAfterOwner = await readState();

      let retriedContenderCount: number | undefined;
      if (contenderOutcome.type === 'failed') {
        const retry = startWatchPollProcess(userEnsembleRoot, sessions[1]!.id);
        processes.push(retry);
        await retry.ready;
        retry.poll();
        retriedContenderCount = await retry.result;
        await retry.exit;
      }
      const finalState = await readState();
      expect({
        contenderOutcome:
          contenderOutcome.type === 'completed'
            ? `completed:${contenderOutcome.count}`
            : `failed:${contenderOutcome.error instanceof Error ? contenderOutcome.error.message : String(contenderOutcome.error)}`,
        sessionTwoCursorBeforeOwnerResumed:
          stateAfterContender.cursors[sessions[1]!.id]?.sequence,
        pendingSessionsBeforeOwnerResumed: stateAfterContender.pendingReports
          .map((report) => report.conductorAgentId)
          .sort(),
        ownerOutcome:
          ownerOutcome.type === 'completed'
            ? `completed:${ownerOutcome.count}`
            : `failed:${ownerOutcome.error instanceof Error ? ownerOutcome.error.message : String(ownerOutcome.error)}`,
        cursorSequences: sessions.map(
          (session) => finalState.cursors[session.id]?.sequence,
        ),
        pendingSessions: finalState.pendingReports
          .map((report) => report.conductorAgentId)
          .sort(),
        pendingReportIds: finalState.pendingReports.map(
          (report) => report.reportId,
        ),
        retriedContenderCount,
      }).toEqual({
        contenderOutcome: expect.stringMatching(
          /^failed:Could not acquire operator watch state profile lock/u,
        ),
        sessionTwoCursorBeforeOwnerResumed: 1,
        pendingSessionsBeforeOwnerResumed: [],
        ownerOutcome: 'completed:1',
        cursorSequences: [2, 2],
        pendingSessions: sessions.map((session) => session.id).sort(),
        pendingReportIds: expect.arrayContaining([
          expect.any(String),
          expect.any(String),
        ]),
        retriedContenderCount: 1,
      });
      expect(new Set(finalState.pendingReports.map((report) => report.reportId)).size)
        .toBe(2);
      expect(stateAfterOwner.pendingReports.map((report) => report.conductorAgentId))
        .toEqual([sessions[0]!.id]);
    } finally {
      releaseOwnerObservation();
      initialPool.close();
      for (const process of processes) {
        if (process.child.exitCode === null && process.child.connected) {
          process.child.kill();
        }
      }
    }
  });

  it('fails initialization for incomplete or malformed persisted watch state', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-invalid-'));
    const validState = {
      version: 1,
      watches: {},
      cursors: {
        'session-one': {
          sequence: 1,
          questionFingerprints: { 'inq-1': 'fingerprint' },
          statusFingerprints: {},
        },
      },
      pendingReports: [],
    };
    const invalidStates = [
      {
        ...validState,
        pendingReports: undefined,
      },
      {
        ...validState,
        pendingReports: null,
      },
      {
        ...validState,
        cursors: {
          'session-one': {
            sequence: 1,
            questionFingerprints: { 'inq-1': 1 },
            statusFingerprints: {},
          },
        },
      },
      {
        ...validState,
        cursors: {
          'session-one': {
            sequence: 1,
            questionFingerprints: {},
            statusFingerprints: { '20': null },
          },
        },
      },
    ];
    const statePath = currentWatchStatePath(repoRoot);
    await mkdir(dirname(statePath), { recursive: true });

    for (const invalidState of invalidStates) {
      await writeFile(statePath, JSON.stringify(invalidState));
      await expect(
        createOperatorWatchPool({
          repoRoot,
          dispatchQueue: createOperatorDispatchQueue(),
        }),
      ).rejects.toThrow('Invalid operator-agent watch state');
    }
  });

  it('rejects duplicate pending report IDs and invalid persisted timing values', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-reports-'));
    const validReport = {
      reportId: 'report-1',
      reportType: 'open_question',
      conductorAgentId: 'session-one',
      issueUrl: 'https://github.com/example/repo/issues/1',
      text: 'A pending report',
      debounceMs: 0,
    };
    const invalidPendingReports = [
      [
        validReport,
        {
          ...validReport,
          conductorAgentId: 'session-two',
          text: 'Another pending report',
        },
      ],
      [{ ...validReport, reportId: '' }],
      [{ ...validReport, debounceMs: 1.5 }],
      [{ ...validReport, debounceMs: -1 }],
      [{ ...validReport, debounceMs: 10_001 }],
      [{ ...validReport, readyAt: 1.5 }],
      [{ ...validReport, readyAt: -1 }],
    ];
    const statePath = currentWatchStatePath(repoRoot);
    await mkdir(dirname(statePath), { recursive: true });

    for (const pendingReports of invalidPendingReports) {
      await writeFile(
        statePath,
        JSON.stringify({
          version: 1,
          watches: {},
          cursors: {},
          pendingReports,
        }),
      );
      await expect(
        createOperatorWatchPool({
          repoRoot,
          dispatchQueue: createOperatorDispatchQueue(),
        }),
      ).rejects.toThrow('Invalid operator-agent watch state');
    }
  });

  it('deduplicates live Registry and YAML observations and reports question transitions once', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-dedup-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    let liveSnapshot: SessionObservationSnapshot = {
      sequence: 0,
      openQuestions: [],
    };
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => liveSnapshot,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());
    await writeResumeStore('live-dedup', 1, liveServer.socketPath);

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
    const writeQuestions = async (
      sequence: number,
      questions: Array<Record<string, unknown>>,
    ) => {
      await writeOfflineSnapshots('live-dedup', {
        sequence,
        questions,
        statusLine: 'waiting',
        reportedAt: 20,
      });
      await rm(
        resolveEnsemblePaths({ repoRoot }).canonicalSessionStatePath(
          DEFAULT_ISSUE_URL,
          'live-dedup',
        ),
        { force: true },
      );
    };
    try {
      await pool.register('live-dedup', {
        pollIntervalMs: 60_000,
        debounceMs: 0,
      });
      expect(await pool.pollOnce('live-dedup')).toBe(0);

      const firstQuestion = {
        id: 'inq-1',
        question: 'Should we proceed?',
        responseType: 'yes_no',
        source: 'conductor',
        status: 'open',
        askedAt: 10,
      };
      liveSnapshot = { sequence: 1, openQuestions: [firstQuestion] };
      expect(await pool.pollOnce('live-dedup')).toBe(1);

      // Once the live UDS goes away, the persisted copy of that same
      // Registry question must not create a second report.
      await writeResumeStore('live-dedup', 2, '/tmp/no-such-ensemble-socket');
      await writeQuestions(1, [firstQuestion]);
      expect(await pool.pollOnce('live-dedup')).toBe(0);

      // A known open question becoming answered is a resolution report.
      // An answered item first observed in YAML is not a new-open report.
      await writeQuestions(2, [
        {
          ...firstQuestion,
          status: 'answered',
          answer: 'Proceed with the staged rollout.',
          assent: 'yes',
          answeredBy: 'operator',
          answeredAt: 25,
        },
        {
          id: 'inq-2',
          question: 'Already answered?',
          responseType: 'text',
          source: 'conductor',
          status: 'answered',
          askedAt: 11,
        },
      ]);
      expect(await pool.pollOnce('live-dedup')).toBe(1);

      await writeQuestions(3, [
        {
          ...firstQuestion,
          status: 'answered',
          answer: 'Proceed with the staged rollout.',
          assent: 'yes',
          answeredBy: 'operator',
          answeredAt: 25,
        },
        {
          id: 'inq-2',
          question: 'Already answered?',
          responseType: 'text',
          source: 'conductor',
          status: 'answered',
          askedAt: 11,
        },
        {
          id: 'inq-3',
          question: 'New while offline?',
          responseType: 'choice',
          source: 'conductor',
          status: 'open',
          askedAt: 12,
        },
      ]);
      expect(await pool.pollOnce('live-dedup')).toBe(1);
      await writeQuestions(4, [
        {
          ...firstQuestion,
          status: 'answered',
          answer: 'Proceed with the staged rollout.',
          assent: 'yes',
          answeredBy: 'operator',
          answeredAt: 25,
        },
        {
          id: 'inq-2',
          question: 'Already answered?',
          responseType: 'text',
          source: 'conductor',
          status: 'answered',
          askedAt: 11,
        },
      ]);
      expect(await pool.pollOnce('live-dedup')).toBe(1);
      expect(dispatchQueue.pendingEventCount).toBe(4);
      const report = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      );
      expect(report?.events.map((event) => event.text)).toEqual([
        expect.stringContaining('Should we proceed?'),
        expect.stringContaining('解決: inq-1'),
        expect.stringContaining('New while offline?'),
        expect.stringContaining('一覧から消失: inq-3'),
      ]);
      expect(report?.events[1]?.text).toContain('Proceed with the staged rollout.');
      expect(report?.events[1]?.text).toContain('賛否: yes');
      expect(report?.events[1]?.text).toContain('answeredBy: operator');
      expect(report?.events[1]?.text).toContain('answeredAt:');
      expect(report?.events[1]?.text).toContain(
        '保存済み SessionResumeStore / YAML',
      );
      expect(report?.events[2]?.text).toContain('新規追加: inq-3');
      expect(report?.events[3]?.text).toContain(
        '回答・回答者: 今回の snapshot では確認できません',
      );
      expect(report?.events[3]?.text).toContain(
        '保存済み SessionResumeStore / YAML',
      );
      const formattedReport = formatOperatorDispatchBatch(report!.events);
      expect(formattedReport).toContain('## Open Question の変化（4 件）');
      expect(formattedReport.indexOf('解決: inq-1')).toBeLessThan(
        formattedReport.indexOf('新規追加: inq-3'),
      );
      expect(formattedReport.indexOf('新規追加: inq-3')).toBeLessThan(
        formattedReport.indexOf('一覧から消失: inq-3'),
      );
      expect(report?.events[1]?.text).not.toContain('新規追加: inq-1');
    } finally {
      pool.close();
    }
  });

  it('reports live open-to-answered, disappearance, and new-open changes in question order', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-lifecycle-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    let snapshot: SessionObservationSnapshot = {
      sequence: 1,
      openQuestions: [
        {
          id: 'inq-1',
          question: 'Which rollout strategy?',
          responseType: 'choice',
          source: 'conductor',
          status: 'open',
          askedAt: 10,
        },
        {
          id: 'inq-2',
          question: 'Which environment?',
          responseType: 'choice',
          source: 'conductor',
          status: 'open',
          askedAt: 11,
        },
      ],
    };
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => snapshot,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());
    await writeResumeStore('session-lifecycle', 1, liveServer.socketPath);

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
    try {
      await pool.register('session-lifecycle', {
        pollIntervalMs: 60_000,
        debounceMs: 0,
      });
      expect(await pool.pollOnce('session-lifecycle')).toBe(0);

      snapshot = {
        sequence: 2,
        openQuestions: [
          {
            id: 'inq-1',
            question: 'Which rollout strategy?',
            responseType: 'choice',
            source: 'conductor',
            status: 'answered',
            askedAt: 10,
            answer: 'Deploy to canary, then all regions.',
            selectedChoice: 'canary',
            answeredBy: 'operator',
            answeredAt: 20,
          },
          {
            id: 'inq-3',
            question: 'Notify the release channel?',
            responseType: 'yes_no',
            source: 'conductor',
            status: 'open',
            askedAt: 30,
          },
        ],
      };
      expect(await pool.pollOnce('session-lifecycle')).toBe(3);
      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events).toHaveLength(3);
      const report = formatOperatorDispatchBatch(batch.events);
      expect(report).toContain('## Open Question の変化（3 件）');
      expect(report).toContain('観測元: 稼働中 UDS');
      expect(report).toContain('質問: Which rollout strategy?');
      expect(report).toContain('回答: Deploy to canary, then all regions.');
      expect(report).toContain('answeredBy: operator');
      expect(report).toContain('選択肢: canary');
      expect(report).toContain('一覧から消失: inq-2');
      expect(report).toContain('新規追加: inq-3');
      expect(report.indexOf('解決: inq-1')).toBeLessThan(
        report.indexOf('一覧から消失: inq-2'),
      );
      expect(report.indexOf('一覧から消失: inq-2')).toBeLessThan(
        report.indexOf('新規追加: inq-3'),
      );
      expect(await pool.pollOnce('session-lifecycle')).toBe(0);
    } finally {
      pool.close();
    }
  });

  it('keeps Open Question text out of watch poll warning logs', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-logs-'));
    await writeResumeStore('session-private', 1);
    const secretBody = 'private-question-body-marker';
    const malformedSnapshotPath =
      resolveEnsemblePaths({ repoRoot }).canonicalOpenQuestionsPath(
        DEFAULT_ISSUE_URL,
        'session-private',
      );
    await mkdir(dirname(malformedSnapshotPath), { recursive: true });
    await writeFile(
      malformedSnapshotPath,
      `version: 1\nsequence: 1\nopenQuestions:\n  - ${secretBody}: [\n`,
    );
    const warnings: string[] = [];
    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: createOperatorDispatchQueue(),
      onError: (message) => warnings.push(message),
    });
    try {
      await pool.register('session-private', {
        pollIntervalMs: 250,
        debounceMs: 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.join('\n')).not.toContain(secretBody);
    } finally {
      pool.close();
    }
  });

  it('registers and removes watches through bounded tools', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-tools-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    await writeResumeStore('session-one', 1);
    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: createOperatorDispatchQueue(),
    });
    try {
      const watch = await pool.register('session-one', {
        pollIntervalMs: 500,
        debounceMs: 1_000,
      });
      expect(
        createRegisterSessionWatchTool(pool).description,
      ).toContain('open-to-answered transitions');
      expect(watch).toMatchObject({
        conductorAgentId: 'session-one',
        pollIntervalMs: 500,
        debounceMs: 1_000,
      });
      await expect(
        pool.register('session-one', { pollIntervalMs: 100 }),
      ).rejects.toThrow('pollIntervalMs must be an integer');
      await expect(pool.unregister('session-one')).resolves.toBe(true);
      expect(pool.list()).toEqual([]);
    } finally {
      pool.close();
    }
  });

  it('listens to new conductor messages with a cursor independent from OQ watch', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-listen-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    let messages = [3, 4].map((sendCount) => ({
      text: `response ${sendCount}`,
      inbound: `inbound ${sendCount}`,
      at: 1_700_000_000_000 + sendCount,
      sendCount,
      dispatchSource: 'operator',
    }));
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => ({ sequence: 2, openQuestions: [] }),
      listConductorMessages: () => messages,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());
    await writeResumeStore('message-listen-one', 1, liveServer.socketPath);

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
    try {
      await pool.register('message-listen-one', {
        pollIntervalMs: 60_000,
        debounceMs: 0,
      });
      await pool.pollOnce('message-listen-one');
      await expect(
        pool.registerConductorMessageListen('message-listen-one'),
      ).resolves.toMatchObject({
        conductorAgentId: 'message-listen-one',
        messageDebounceMs: 10_000,
      });
      await pool.registerConductorMessageListen('message-listen-one', {
        messageDebounceMs: 0,
      });
      await expect(
        pool.registerConductorMessageListen('message-listen-one', {
          messageDebounceMs: 120_000,
        }),
      ).resolves.toMatchObject({ messageDebounceMs: 120_000 });
      await expect(
        pool.registerConductorMessageListen('message-listen-one', {
          messageDebounceMs: 120_001,
        }),
      ).rejects.toThrow('messageDebounceMs must be an integer');
      await pool.registerConductorMessageListen('message-listen-one', {
        messageDebounceMs: 0,
      });
      expect(pool.listConductorMessageListens()).toHaveLength(1);
      expect(dispatchQueue.pendingEventCount).toBe(0);

      const storedPath = currentWatchStatePath(repoRoot);
      const baseline = JSON.parse(await readFile(storedPath, 'utf8')) as {
        cursors: Record<string, { sequence: number }>;
        messageCursors: Record<string, number>;
      };
      expect(baseline.cursors['message-listen-one']?.sequence).toBe(2);
      expect(baseline.messageCursors['message-listen-one']).toBe(4);

      messages = [
        ...messages,
        ...[5, 6].map((sendCount) => ({
          text: `response ${sendCount}`,
          inbound: `inbound ${sendCount}`,
          at: 1_700_000_000_000 + sendCount,
          sendCount,
          dispatchSource: 'worker:reviewer',
        })),
      ];
      await expect(
        pool.pollConductorMessagesOnce('message-listen-one'),
      ).resolves.toBe(2);
      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events.map((event) => event.sendCount)).toEqual([5, 6]);
      expect(formatOperatorDispatchBatch(batch.events)).toContain(
        '### 1/2\n\n対象: https://github.com/example/repo/issues/1 (message-listen-one)\nsendCount: 5',
      );
      const formatted = formatOperatorDispatchBatch(batch.events);
      expect(formatted.indexOf('sendCount: 5')).toBeLessThan(
        formatted.indexOf('sendCount: 6'),
      );
      expect(formatted).toContain('#### inbound\n\ninbound 5');
      expect(formatted).toContain('#### response\n\nresponse 6');

      await pool.acknowledge(batch.events);
      const afterAck = JSON.parse(await readFile(storedPath, 'utf8')) as {
        messageCursors: Record<string, number>;
        pendingReports: unknown[];
      };
      expect(afterAck.messageCursors['message-listen-one']).toBe(6);
      expect(afterAck.pendingReports).toEqual([]);
      await expect(
        pool.unregisterConductorMessageListen('message-listen-one'),
      ).resolves.toBe(true);
      expect(pool.listConductorMessageListens()).toEqual([]);
    } finally {
      pool.close();
    }
  });

  it('uses the configured message debounce for pending watch reports in the same session', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-message-window-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => ({
        sequence: 1,
        openQuestions: [],
        sessionState: {
          current: { statusLine: 'waiting for review', reportedAt: 10 },
          history: [],
        },
      }),
      listConductorMessages: () => [],
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());
    await writeResumeStore('watch-message-window', 1, liveServer.socketPath);

    const dispatchQueue = createOperatorDispatchQueue();
    dispatchQueue.setHold(true);
    const pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      await pool.register('watch-message-window', {
        pollIntervalMs: 60_000,
        debounceMs: 0,
      });
      expect(await pool.pollOnce('watch-message-window')).toBe(1);
      expect(dispatchQueue.heldEventCount).toBe(1);
      await pool.registerConductorMessageListen('watch-message-window', {
        messageDebounceMs: 3_000,
      });
      expect(dispatchQueue.setHold(false)).toEqual({
        heldEventCount: 0,
        releasedEventCount: 1,
      });
      const releaseAt = Date.now();
      expect(
        dispatchQueue.takeBatch(
          { continuationConsumed: false },
          releaseAt + 2_999,
        ),
      ).toBeUndefined();
      expect(
        dispatchQueue.takeBatch(
          { continuationConsumed: false },
          releaseAt + 3_000,
        )?.events[0]?.text,
      ).toContain('waiting for review');
    } finally {
      now.mockRestore();
      pool.close();
    }
  });

  it('recovers from aggregate oversized pages by fetching complete messages in order', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-pages-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const baselineMessage = {
      text: 'baseline',
      inbound: 'baseline inbound',
      at: 1_700_000_000_004,
      sendCount: 4,
    };
    let messages = [baselineMessage];
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      listConductorMessages: () => messages,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());
    await writeResumeStore('message-pages-one', 1, liveServer.socketPath);

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
    try {
      await pool.registerConductorMessageListen('message-pages-one', {
        messageDebounceMs: 0,
      });

      const inbound = 'i'.repeat(300 * 1024);
      messages = [
        baselineMessage,
        ...[5, 6, 7, 8].map((sendCount) => ({
          text: `response ${sendCount}`,
          inbound,
          at: 1_700_000_000_000 + sendCount,
          sendCount,
        })),
      ];

      await expect(
        sendOpenQuestionControlRequest(liveServer.socketPath, {
          method: OPEN_QUESTION_CONTROL_METHODS.conductorMessagesList,
          params: { limit: 1, order: 'asc', after: 4 },
        }),
      ).resolves.toEqual({
        messages: [messages[1]],
        hasMore: true,
      });
      await expect(
        sendOpenQuestionControlRequest(liveServer.socketPath, {
          method: OPEN_QUESTION_CONTROL_METHODS.conductorMessagesList,
          params: { limit: 4, order: 'asc', after: 4 },
        }),
      ).rejects.toMatchObject<Partial<OpenQuestionControlRemoteError>>({
        rpcCode: -32603,
        message: 'Response is too large.',
      });

      await expect(
        pool.pollConductorMessagesOnce('message-pages-one'),
      ).resolves.toBe(4);
      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events.map((event) => event.sendCount)).toEqual([
        5, 6, 7, 8,
      ]);
      expect(batch.events).toHaveLength(4);
      for (const event of batch.events) {
        expect(event.type).toBe('report');
        if (event.type === 'report') {
          expect(event.text).toContain(`#### inbound\n\n${inbound}`);
        }
      }
      const state = JSON.parse(
        await readFile(currentWatchStatePath(repoRoot), 'utf8'),
      ) as {
        messageCursors: Record<string, number>;
        pendingReports: Array<{ sendCount?: number }>;
      };
      expect(state.messageCursors['message-pages-one']).toBe(8);
      expect(state.pendingReports.map((report) => report.sendCount)).toEqual([
        5, 6, 7, 8,
      ]);
      await expect(
        pool.pollConductorMessagesOnce('message-pages-one'),
      ).resolves.toBe(0);
      expect(dispatchQueue.pendingEventCount).toBe(0);
    } finally {
      pool.close();
    }
  });

  it('skips one oversized message and continues notifying later messages in order', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-partial-pages-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const baselineMessage = {
      text: 'baseline',
      inbound: 'baseline inbound',
      at: 1_700_000_000_004,
      sendCount: 4,
    };
    let messages = [baselineMessage];
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      listConductorMessages: () => messages,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());
    await writeResumeStore('message-partial-pages', 1, liveServer.socketPath);

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
    try {
      await pool.registerConductorMessageListen('message-partial-pages', {
        messageDebounceMs: 0,
      });
      const inbound = 'i'.repeat(300 * 1024);
      messages = [
        baselineMessage,
        ...[5, 6].map((sendCount) => ({
          text: `response ${sendCount}`,
          inbound,
          at: 1_700_000_000_000 + sendCount,
          sendCount,
        })),
        {
          text: 'single oversized response',
          inbound: 'x'.repeat(1_048_576),
          at: 1_700_000_000_007,
          sendCount: 7,
        },
        {
          text: 'response 8',
          inbound: 'inbound 8',
          at: 1_700_000_000_008,
          sendCount: 8,
        },
      ];

      await expect(
        pool.pollConductorMessagesOnce('message-partial-pages'),
      ).resolves.toBe(4);

      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events.map((event) => event.sendCount)).toEqual([
        5, 6, 7, 8,
      ]);
      const groupedReport = formatOperatorDispatchBatch(batch.events);
      expect(groupedReport).toContain('sendCount: 7');
      expect(groupedReport.indexOf('sendCount: 7')).toBeLessThan(
        groupedReport.indexOf('sendCount: 8'),
      );
      for (const event of batch.events) {
        if (event.type === 'report') {
          if (event.sendCount === 7) {
            expect(event.text).toContain(
              '1件の発言は単独のUDS responseが1 MiBを超えたため読み取れず',
            );
            expect(event.text).toContain('sendCount: 7');
          } else if (event.sendCount === 5 || event.sendCount === 6) {
            expect(event.text).toContain(`#### inbound\n\n${inbound}`);
          } else {
            expect(event.text).toContain('#### inbound\n\ninbound 8');
          }
        }
      }
      const state = JSON.parse(
        await readFile(currentWatchStatePath(repoRoot), 'utf8'),
      ) as {
        messageCursors: Record<string, number>;
        pendingReports: Array<{ sendCount?: number }>;
      };
      expect(state.messageCursors['message-partial-pages']).toBe(8);
      expect(state.pendingReports.map((report) => report.sendCount)).toEqual([
        5, 6, 7, 8,
      ]);
      await expect(
        pool.pollConductorMessagesOnce('message-partial-pages'),
      ).resolves.toBe(0);

      messages.push({
        text: 'response 9',
        inbound: 'inbound 9',
        at: 1_700_000_000_009,
        sendCount: 9,
      });
      await expect(
        pool.pollConductorMessagesOnce('message-partial-pages'),
      ).resolves.toBe(1);
      const laterBatch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(laterBatch.events.map((event) => event.sendCount)).toEqual([9]);
      expect(laterBatch.events[0]?.text).toContain('inbound 9');
    } finally {
      pool.close();
    }
  });

  it('keeps oversized warnings in production poll order around readable messages', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-multiple-oversized-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const baselineMessage = {
      text: 'baseline',
      inbound: 'baseline inbound',
      at: 1_700_000_000_004,
      sendCount: 4,
    };
    let messages = [baselineMessage];
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      listConductorMessages: () => messages,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());
    await writeResumeStore(
      'message-multiple-oversized',
      1,
      liveServer.socketPath,
    );

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
    try {
      await pool.registerConductorMessageListen('message-multiple-oversized', {
        messageDebounceMs: 0,
      });
      messages = [
        baselineMessage,
        ...[5, 6].map((sendCount) => ({
          text: `oversized response ${sendCount}`,
          inbound: 'x'.repeat(1_048_576),
          at: 1_700_000_000_000 + sendCount,
          sendCount,
        })),
        {
          text: 'response 7',
          inbound: 'inbound 7',
          at: 1_700_000_000_007,
          sendCount: 7,
        },
        {
          text: 'oversized response 8',
          inbound: 'y'.repeat(1_048_576),
          at: 1_700_000_000_008,
          sendCount: 8,
        },
        {
          text: 'response 9',
          inbound: 'inbound 9',
          at: 1_700_000_000_009,
          sendCount: 9,
        },
      ];

      await expect(
        pool.pollConductorMessagesOnce('message-multiple-oversized'),
      ).resolves.toBe(4);
      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events.map((event) => event.sendCount)).toEqual([
        6, 7, 8, 9,
      ]);
      const warningReports = batch.events.filter(
        (event) =>
          event.type === 'report' &&
          event.text.includes('発言は単独のUDS responseが1 MiBを超えたため読み取れず'),
      );
      expect(warningReports).toHaveLength(2);
      expect(warningReports[0]?.reportId).toBeDefined();
      expect(warningReports[0]?.text).toContain('2件');
      expect(warningReports[0]?.text).toContain('sendCount: 5, 6');
      expect(warningReports[1]?.reportId).toBeDefined();
      expect(warningReports[1]?.text).toContain('1件');
      expect(warningReports[1]?.text).toContain('sendCount: 8');
      expect(new Set(warningReports.map((event) => event.reportId)).size).toBe(2);
      const groupedReport = formatOperatorDispatchBatch(batch.events);
      expect((groupedReport.match(/⚠/g) ?? [])).toHaveLength(2);
      const warningFiveSix = groupedReport.indexOf('sendCount: 5, 6');
      const readableSeven = groupedReport.indexOf('inbound 7');
      const warningEight = groupedReport.indexOf('sendCount: 8');
      const readableNine = groupedReport.indexOf('inbound 9');
      expect(warningFiveSix).toBeGreaterThanOrEqual(0);
      expect(readableSeven).toBeGreaterThan(warningFiveSix);
      expect(warningEight).toBeGreaterThan(readableSeven);
      expect(readableNine).toBeGreaterThan(warningEight);
      expect(batch.events[1]?.text).toContain('inbound 7');
      expect(batch.events[3]?.text).toContain('inbound 9');

      const state = JSON.parse(
        await readFile(currentWatchStatePath(repoRoot), 'utf8'),
      ) as {
        messageCursors: Record<string, number>;
        pendingReports: Array<{ reportId: string; sendCount?: number }>;
      };
      expect(state.messageCursors['message-multiple-oversized']).toBe(9);
      expect(state.pendingReports.map((report) => report.sendCount)).toEqual([
        6, 7, 8, 9,
      ]);
      expect(
        new Set(state.pendingReports.map((report) => report.reportId)).size,
      ).toBe(4);
      await pool.acknowledge(batch.events);
      const acknowledgedState = JSON.parse(
        await readFile(currentWatchStatePath(repoRoot), 'utf8'),
      ) as { pendingReports: Array<{ reportId: string }> };
      expect(acknowledgedState.pendingReports).toEqual([]);
      await expect(
        pool.pollConductorMessagesOnce('message-multiple-oversized'),
      ).resolves.toBe(0);
    } finally {
      pool.close();
    }
  });

  it('coalesces oversized warnings across polls in one debounce window', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-warning-window-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const baselineMessage = {
      text: 'baseline',
      inbound: 'baseline inbound',
      at: 1_700_000_000_001,
      sendCount: 1,
    };
    let messages = [baselineMessage];
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      listConductorMessages: () => messages,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());
    await writeResumeStore(
      'message-warning-window',
      1,
      liveServer.socketPath,
    );

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
    vi.useFakeTimers();
    try {
      await pool.registerConductorMessageListen('message-warning-window', {
        messageDebounceMs: 10_000,
      });

      messages = [
        baselineMessage,
        {
          text: 'oversized response 2',
          inbound: 'x'.repeat(1_048_576),
          at: 1_700_000_000_002,
          sendCount: 2,
        },
      ];
      await expect(
        pool.pollConductorMessagesOnce('message-warning-window'),
      ).resolves.toBe(1);
      expect(
        dispatchQueue.takeBatch({ continuationConsumed: false }, Date.now()),
      ).toBeUndefined();

      vi.setSystemTime(Date.now() + 5_000);
      messages = [
        ...messages,
        {
          text: 'oversized response 3',
          inbound: 'y'.repeat(1_048_576),
          at: 1_700_000_000_003,
          sendCount: 3,
        },
        {
          text: 'readable response 4',
          inbound: 'readable inbound 4',
          at: 1_700_000_000_004,
          sendCount: 4,
        },
      ];
      await expect(
        pool.pollConductorMessagesOnce('message-warning-window'),
      ).resolves.toBe(2);
      expect(
        dispatchQueue.takeBatch({ continuationConsumed: false }, Date.now()),
      ).toBeUndefined();

      vi.setSystemTime(Date.now() + 10_000);
      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events.map((event) => event.sendCount)).toEqual([2, 3, 4]);
      const formatted = formatOperatorDispatchBatch(batch.events);
      expect((formatted.match(/⚠/g) ?? [])).toHaveLength(1);
      expect(formatted).toContain('2件');
      expect(formatted).toContain('sendCount: 2, 3');
      expect(formatted).toContain('readable inbound 4');
      const state = JSON.parse(
        await readFile(currentWatchStatePath(repoRoot), 'utf8'),
      ) as {
        messageCursors: Record<string, number>;
        pendingReports: Array<{ sendCount?: number }>;
      };
      expect(state.messageCursors['message-warning-window']).toBe(4);
      expect(state.pendingReports.map((report) => report.sendCount)).toEqual([
        2, 3, 4,
      ]);
    } finally {
      pool.close();
      vi.useRealTimers();
    }
  });

  it('cleans up the listener and timer when its initial baseline poll fails', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-baseline-error-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      listConductorMessages: () => {
        throw new Error('simulated baseline poll failure');
      },
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());
    await writeResumeStore(
      'message-baseline-error',
      1,
      liveServer.socketPath,
    );

    const errors: string[] = [];
    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: createOperatorDispatchQueue(),
      onError: (message) => errors.push(message),
    });
    vi.useFakeTimers();
    try {
      await expect(
        pool.registerConductorMessageListen('message-baseline-error'),
      ).rejects.toMatchObject<Partial<OpenQuestionControlRemoteError>>({
        rpcCode: -32603,
        message: 'Open Question operation failed.',
      });
      expect(pool.listConductorMessageListens()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      const state = JSON.parse(
        await readFile(currentWatchStatePath(repoRoot), 'utf8'),
      ) as {
        messageListeners: Record<string, unknown>;
        messageCursors: Record<string, number>;
      };
      expect(state.messageListeners).toEqual({});
      expect(state.messageCursors).toEqual({});
      await vi.advanceTimersByTimeAsync(2_000);
      expect(errors).toEqual([]);
    } finally {
      pool.close();
      vi.useRealTimers();
    }
  });

  it('uses an oversized-aware silent baseline and then delivers later readable messages', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-oversized-baseline-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    let messages = [5, 6].map((sendCount) => ({
      text: `oversized response ${sendCount}`,
      inbound: 'x'.repeat(1_048_576),
      at: 1_700_000_000_000 + sendCount,
      sendCount,
    }));
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      listConductorMessages: () => messages,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());
    await writeResumeStore(
      'message-oversized-baseline',
      1,
      liveServer.socketPath,
    );

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
    try {
      await expect(
        pool.registerConductorMessageListen('message-oversized-baseline', {
          messageDebounceMs: 0,
        }),
      ).resolves.toMatchObject({
        conductorAgentId: 'message-oversized-baseline',
        messageDebounceMs: 0,
      });
      expect(pool.listConductorMessageListens()).toHaveLength(1);
      expect(dispatchQueue.pendingEventCount).toBe(0);
      const baselineState = JSON.parse(
        await readFile(currentWatchStatePath(repoRoot), 'utf8'),
      ) as { messageCursors: Record<string, number> };
      expect(baselineState.messageCursors['message-oversized-baseline']).toBe(6);

      messages = [
        ...messages,
        {
          text: 'later readable response',
          inbound: 'later readable inbound',
          at: 1_700_000_000_007,
          sendCount: 7,
        },
      ];
      await expect(
        pool.pollConductorMessagesOnce('message-oversized-baseline'),
      ).resolves.toBe(1);
      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events.map((event) => event.sendCount)).toEqual([7]);
      expect(batch.events[0]?.text).toContain('later readable inbound');
      expect(batch.events[0]?.text).not.toContain('sendCount: 5');
      expect(batch.events[0]?.text).not.toContain('sendCount: 6');
      await expect(
        pool.pollConductorMessagesOnce('message-oversized-baseline'),
      ).resolves.toBe(0);
    } finally {
      pool.close();
    }
  });

  it('restores the previous listener config and timer when re-registration polling fails', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-reregister-error-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    let failPolling = false;
    const messages = [{
      text: 'baseline response',
      inbound: 'baseline inbound',
      at: 1_700_000_000_001,
      sendCount: 1,
    }];
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      listConductorMessages: () => {
        if (failPolling) throw new Error('simulated baseline poll failure');
        return messages;
      },
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());
    await writeResumeStore(
      'message-reregister-error',
      1,
      liveServer.socketPath,
    );

    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: createOperatorDispatchQueue(),
    });
    vi.useFakeTimers();
    try {
      const previousConfig = await pool.registerConductorMessageListen(
        'message-reregister-error',
        { messageDebounceMs: 3_000 },
      );
      expect(vi.getTimerCount()).toBe(1);

      failPolling = true;
      await expect(
        pool.registerConductorMessageListen('message-reregister-error', {
          messageDebounceMs: 9_000,
        }),
      ).rejects.toMatchObject<Partial<OpenQuestionControlRemoteError>>({
        rpcCode: -32603,
        message: 'Open Question operation failed.',
      });

      expect(pool.listConductorMessageListens()).toEqual([previousConfig]);
      expect(vi.getTimerCount()).toBe(1);
      const state = JSON.parse(
        await readFile(currentWatchStatePath(repoRoot), 'utf8'),
      ) as {
        messageListeners: Record<string, {
          conductorAgentId: string;
          messageDebounceMs: number;
        }>;
        messageCursors: Record<string, number>;
      };
      expect(state.messageListeners['message-reregister-error']).toEqual(
        previousConfig,
      );
      expect(state.messageCursors['message-reregister-error']).toBe(1);
    } finally {
      pool.close();
      vi.useRealTimers();
    }
  });

  it('does not fall back to saved session YAML when conductor-message UDS is absent', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-offline-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    await writeResumeStore('offline-message-session', 1);
    await writeOfflineSnapshots('offline-message-session', {
      sequence: 1,
      questions: [],
      statusLine: '保存済み状態',
      reportedAt: 2,
    });
    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot, dispatchQueue });
    try {
      await pool.registerConductorMessageListen('offline-message-session', {
        messageDebounceMs: 0,
      });
      await expect(
        pool.pollConductorMessagesOnce('offline-message-session'),
      ).resolves.toBe(0);
      expect(dispatchQueue.pendingEventCount).toBe(0);
      expect(
        JSON.parse(
          await readFile(currentWatchStatePath(repoRoot), 'utf8'),
        ).messageCursors['offline-message-session'],
      ).toBeUndefined();
    } finally {
      pool.close();
    }
  });

  async function writeResumeStore(
    agentId: string,
    updatedAt: number,
    harnessSocketPath?: string,
    issueUrl = 'https://github.com/example/repo/issues/1',
  ) {
    const path = resolveEnsemblePaths({
      repoRoot,
    }).canonicalSessionResumeStorePath(issueUrl, agentId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        conductorAgentId: agentId,
        issueUrl,
        repoRoot,
        ...(harnessSocketPath ? { harnessSocketPath } : {}),
        profile: { workers: [], agents: {} },
        openQuestions: [],
        sequence: 0,
        workers: {},
        updatedAt,
      }),
    );
  }

  async function writeOfflineSnapshots(
    agentId: string,
    input: {
      issueUrl?: string;
      sequence: number;
      questions: Array<Record<string, unknown>>;
      statusLine: string;
      reportedAt: number;
    },
  ) {
    const paths = resolveEnsemblePaths({ repoRoot });
    const openQuestionsPath = paths.canonicalOpenQuestionsPath(
      input.issueUrl ?? DEFAULT_ISSUE_URL,
      agentId,
    );
    const sessionStatePath = paths.canonicalSessionStatePath(
      input.issueUrl ?? DEFAULT_ISSUE_URL,
      agentId,
    );
    await mkdir(dirname(openQuestionsPath), { recursive: true });
    await mkdir(dirname(sessionStatePath), { recursive: true });
    await writeFile(
      openQuestionsPath,
      [
        'version: 1',
        `sequence: ${input.sequence}`,
        ...(input.questions.length === 0
          ? ['openQuestions: []']
          : ['openQuestions:']),
        ...input.questions.flatMap((question) => [
          `  - id: ${question.id}`,
          `    question: ${JSON.stringify(question.question)}`,
          `    responseType: ${question.responseType}`,
          `    source: ${question.source}`,
          `    status: ${question.status}`,
          `    askedAt: ${question.askedAt}`,
          ...(typeof question.answer === 'string'
            ? [`    answer: ${JSON.stringify(question.answer)}`]
            : []),
          ...(typeof question.assent === 'string'
            ? [`    assent: ${question.assent}`]
            : []),
          ...(typeof question.selectedChoice === 'string'
            ? [`    selectedChoice: ${JSON.stringify(question.selectedChoice)}`]
            : []),
          ...(typeof question.answeredBy === 'string'
            ? [`    answeredBy: ${question.answeredBy}`]
            : []),
          ...(typeof question.answeredAt === 'number'
            ? [`    answeredAt: ${question.answeredAt}`]
            : []),
        ]),
        '',
      ].join('\n'),
    );
    await writeFile(
      sessionStatePath,
      `version: 1\nstatusLine: "${input.statusLine}"\nreportedAt: ${input.reportedAt}\n`,
    );
  }
});
