import {
  resolveEnsemblePaths
} from '@agents-ensemble/core';
import { listUserLocatedSessionResumeStoresPage } from '@agents-ensemble/core/operator-runtime';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import {
  createOperatorDispatchQueue
} from '../dispatch/operator-dispatch.js';
import {
  createRegisterRepositoryWatchTool,
  createUnregisterRepositoryWatchTool,
  operatorWatchStatePath
} from './operator-watch-pool.js';

import { DEFAULT_ISSUE_URL, currentWatchStatePath, setupWatchPoolSuite } from '../../test/support/watch-pool-suite.js';

setupWatchPoolSuite((context) => {
  const { createOperatorWatchPool, writeResumeStore, writeOfflineSnapshots } = context;


  it('resolves canonical watch storage from a valid profile and Issue identity', () => {
    const userRoot = join(context.homeRoot, '.ensemble');
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-repository-watch-'));
    const existingIssue = 'https://github.com/example/repo/issues/1';
    const manualIssue = 'https://github.com/example/repo/issues/2';
    const newIssue = 'https://github.com/example/repo/issues/3';
    await writeResumeStore('baseline-run', 900, undefined, existingIssue);
    await writeResumeStore('manual-run', 800, undefined, manualIssue);
    const dispatchQueue = createOperatorDispatchQueue();
    let pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
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
        repoRoot: context.repoRoot,
      }).canonicalSessionResumeStorePath(newIssue, 'new-run');
      await writeFile(newRunPath, '{ invalid json');
      await expect(pool.scanRepositoriesOnce()).rejects.toThrow();
      expect(
        pool.getSessionTrackingInfo('new-run', newIssue).repositoryScan,
      ).toMatchObject({ status: 'stale', error: 'scan_failed' });
      await writeResumeStore('new-run', 1, undefined, newIssue);
      await expect(pool.scanRepositoriesOnce()).resolves.toBe(0);

      pool.close();
      pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-repository-watch-cap-'));
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
      repoRoot: context.repoRoot,
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-repository-watch-registration-limit-'));
    const dispatchQueue = createOperatorDispatchQueue();
    let pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
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
      pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-repository-watch-page-boundary-'));
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
      repoRoot: context.repoRoot,
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-legacy-'));
    const legacyPath = join(
      context.repoRoot,
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
      repoRoot: context.repoRoot,
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-slug-state-'));
    const agentId = '607';
    const userRoot = join(context.homeRoot, '.ensemble');
    const paths = resolveEnsemblePaths({ repoRoot: context.repoRoot });
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
      context.repoRoot,
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
      repoRoot: context.repoRoot,
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-state-migrate-'));
    const paths = resolveEnsemblePaths({ repoRoot: context.repoRoot });
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
        repoRoot: context.repoRoot,
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
      join(context.homeRoot, '.ensemble'),
      'operator-agent',
      paths.repoKey,
      'watch-state.json',
    );
    const slugStatePath = operatorWatchStatePath(
      join(context.homeRoot, '.ensemble'),
      'default',
      issueUrl,
    );
    await mkdir(dirname(hashStatePath), { recursive: true });
    await writeFile(hashStatePath, JSON.stringify(state), 'utf8');

    const pool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
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
    const userRoot = join(context.homeRoot, '.ensemble');
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-unassigned-'));
    const issueUrl = DEFAULT_ISSUE_URL;
    const userRoot = join(context.homeRoot, '.ensemble');
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
      repoRoot: context.repoRoot,
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
      repoRoot: context.repoRoot,
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-late-store-'));
    const dispatchQueue = createOperatorDispatchQueue();
    const warnings: string[] = [];
    const pool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
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
        await readFile(currentWatchStatePath(context.repoRoot), 'utf8'),
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-changed-issue-'));
    const oldIssueUrl = DEFAULT_ISSUE_URL;
    const newIssueUrl = 'https://github.com/other/repo/issues/10';
    const userRoot = join(context.homeRoot, '.ensemble');
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
      repoRoot: context.repoRoot,
      dispatchQueue,
      onError: (message) => warnings.push(message),
    });
    try {
      expect(dispatchQueue.pendingEventCount).toBe(1);
      const oldStorePath = resolveEnsemblePaths({
        repoRoot: context.repoRoot,
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
});
