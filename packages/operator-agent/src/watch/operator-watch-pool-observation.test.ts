import {
  findSessionResumeStore,
  resolveEnsemblePaths,
  startOpenQuestionControlServer,
  type SessionObservationSnapshot
} from '@agents-ensemble/core';
import * as operatorRuntime from '@agents-ensemble/core/operator-runtime';
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createListOperatorSessionsTool } from '../tools/list-operator-sessions-tool.js';
import {
  createOperatorDispatchQueue,
  formatOperatorDispatchBatch,
} from '../dispatch/operator-dispatch.js';
import {
  createRegisterRepositoryWatchTool,
  createUnregisterRepositoryWatchTool,
  createUnregisterSessionWatchTool
} from './operator-watch-pool.js';

import { DEFAULT_ISSUE_URL, currentWatchStatePath, setupWatchPoolSuite } from '../../test/support/watch-pool-suite.js';

setupWatchPoolSuite((context) => {
  const { createOperatorWatchPool, writeResumeStore, writeOfflineSnapshots } = context;


  it('does not refresh the watch timestamp after a delayed observation', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'watch-observed-at-'));
    const initial = Date.now();
    let now = initial;
    let observations = 0;
    let delayNextLocate = false;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const findSession = operatorRuntime.findUserSessionResumeStore;
    vi.spyOn(operatorRuntime, 'findUserSessionResumeStore').mockImplementation(async (...args) => {
      if (delayNextLocate) { delayNextLocate = false; now += 11_000; }
      return findSession(...args);
    });
    const server = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => {
        observations++;
        if (observations === 1) { delayNextLocate = true; return { sequence: 0, openQuestions: [], workStatus: 'working' }; }
        return { sequence: 0, openQuestions: [], workStatus: 'waiting' };
      },
      answerOpenQuestion: async () => { throw new Error('unused'); },
    });
    context.closeServers.push(() => server.close());
    await writeResumeStore('delayed', 1, server.socketPath);
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: createOperatorDispatchQueue() });
    try {
      await pool.register('delayed', { pollIntervalMs: 60_000, debounceMs: 0 });
      await pool.pollOnce('delayed');
      expect(pool.getLiveStatus('delayed')).toMatchObject({ checkedAt: initial, snapshot: { workStatus: 'working' } });
      const tool = createListOperatorSessionsTool(context.repoRoot, (id) => pool.getLiveStatus(id));
      const result = JSON.parse((await tool.execute({ includeGithub: false, workStatus: 'waiting' })).content[0]!.text);
      expect(result.sessions).toMatchObject([{ conductorAgentId: 'delayed', workStatus: { status: 'waiting', source: 'uds', observedAt: initial + 11_000 } }]);
      expect(observations).toBe(2);
      const old = JSON.parse((await tool.execute({ includeGithub: false, workStatus: 'working' })).content[0]!.text);
      expect(old.total).toBe(0);
    } finally { pool.close(); vi.restoreAllMocks(); }
  });

  it('watches multiple sessions through live UDS and persists cursors without replay', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
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
    context.closeServers.push(() => liveServer.close());
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
      repoRoot: context.repoRoot,
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
        await readFile(currentWatchStatePath(context.repoRoot), 'utf8'),
      ) as { cursors: Record<string, { sequence: number }> };
      expect(stored.cursors['live-one']?.sequence).toBe(2);
      expect(stored.cursors['offline-two']?.sequence).toBe(2);
      pool.close();

      const resumedQueue = createOperatorDispatchQueue();
      const resumedPool = await createOperatorWatchPool({
        repoRoot: context.repoRoot,
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-question-count-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
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
    context.closeServers.push(() => liveServer.close());
    const issueUrl = 'https://github.com/example/repo/issues/72';
    const sessionId = 'question-count-session';
    await writeResumeStore(sessionId, 1, liveServer.socketPath, issueUrl);
    const dispatchQueue = createOperatorDispatchQueue();
    let pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
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
      pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
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
        { userEnsembleRoot: join(context.homeRoot, '.ensemble') },
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

      const statePath = currentWatchStatePath(context.repoRoot);
      const savedState = JSON.parse(await readFile(statePath, 'utf8')) as {
        cursors: Record<
          string,
          { questionCountObservation: Record<string, unknown> }
        >;
      };
      delete savedState.cursors[sessionId]!.questionCountObservation.metric;
      await writeFile(statePath, `${JSON.stringify(savedState)}\n`, 'utf8');

      pool.close();
      pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-held-answer-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
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
    context.closeServers.push(() => liveServer.close());
    await writeResumeStore('held-answer-session', 1, liveServer.socketPath);

    const dispatchQueue = createOperatorDispatchQueue();
    dispatchQueue.setConversationHold(true);
    dispatchQueue.setHold(true);
    const pool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
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
          await readFile(currentWatchStatePath(context.repoRoot), 'utf8'),
        ).pendingReports,
      ).toEqual([]);
    } finally {
      pool.close();
    }
  });

  it('discovers, disconnects, and reconnects live sessions without changing manual watches', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-auto-watch-'));
    const server = async () => startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => ({ sequence: 1, openQuestions: [] }),
      answerOpenQuestion: async () => { throw new Error('unused'); },
    });
    const first = await server();
    await writeResumeStore('automatic', 1, first.socketPath);
    await writeResumeStore('manual', 1);
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: createOperatorDispatchQueue() });
    try {
      await pool.register('manual', { pollIntervalMs: 60_000 });
      await pool.scanAutoSessionsOnce();
      await pool.pollOnce('automatic');
      expect(pool.getLiveStatus('automatic')?.connectivity).toBe('reachable');
      expect(pool.getSessionTrackingInfo('automatic', DEFAULT_ISSUE_URL)).toMatchObject({
        watchEnabled: true, watchSource: 'live_auto', watchReason: 'watching',
      });
      expect(pool.list().map((watch) => watch.conductorAgentId)).toEqual(['manual']);
      await first.close();
      await pool.scanAutoSessionsOnce();
      expect(await pool.pollOnce('automatic')).toBe(0);
      expect(pool.getSessionTrackingInfo('automatic', DEFAULT_ISSUE_URL).watchEnabled).toBe(false);
      expect(pool.list().map((watch) => watch.conductorAgentId)).toEqual(['manual']);
      const second = await server();
      try {
        await writeResumeStore('automatic', 2, second.socketPath);
        await pool.scanAutoSessionsOnce();
        await pool.pollOnce('automatic');
        expect(pool.getLiveStatus('automatic')?.connectivity).toBe('reachable');
      } finally {
        await second.close();
      }
    } finally {
      pool.close();
    }
  });

  it('reports unregister results without implying that live automatic discovery stops', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-auto-unregister-'));
    const server = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => ({ sequence: 1, openQuestions: [] }),
      answerOpenQuestion: async () => { throw new Error('unused'); },
    });
    await writeResumeStore('live', 1, server.socketPath);
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: createOperatorDispatchQueue() });
    try {
      const sessionTool = createUnregisterSessionWatchTool(pool);
      const repositoryTool = createUnregisterRepositoryWatchTool(pool);
      const registerRepositoryTool = createRegisterRepositoryWatchTool(pool);
      expect(sessionTool.description).toContain('live automatic discovery is not disabled');
      expect(repositoryTool.description).toContain('independent live automatic discovery are unaffected');
      expect(registerRepositoryTool.description).toContain('repository-driven automatic session watches are limited to 20');
      expect(registerRepositoryTool.description).toContain('independent live automatic discovery and manual session watches are outside that limit');
      await pool.scanAutoSessionsOnce();
      expect((await sessionTool.execute({ conductorAgentId: 'live' })).structuredContent).toMatchObject({ removed: false });
      expect(pool.getSessionTrackingInfo('live', DEFAULT_ISSUE_URL)).toMatchObject({ watchEnabled: true, watchSource: 'live_auto' });
      await pool.register('live');
      expect((await sessionTool.execute({ conductorAgentId: 'live' })).structuredContent).toMatchObject({ removed: true });
      await pool.scanAutoSessionsOnce();
      expect(pool.getSessionTrackingInfo('live', DEFAULT_ISSUE_URL)).toMatchObject({ watchEnabled: true, watchSource: 'live_auto' });
      await registerRepositoryTool.execute({ githubRepo: 'example/repo' });
      expect((await repositoryTool.execute({ githubRepo: 'example/repo' })).structuredContent).toMatchObject({ removed: true });
      await pool.scanAutoSessionsOnce();
      expect(pool.getSessionTrackingInfo('live', DEFAULT_ISSUE_URL)).toMatchObject({ watchEnabled: true, watchSource: 'live_auto' });
    } finally {
      pool.close();
      await server.close();
    }
  });

  it('limits automatic discovery to the intersection of profile and repository filters', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-auto-scope-'));
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => ({ sequence: 1, openQuestions: [] }),
      answerOpenQuestion: async () => { throw new Error('unused'); },
    });
    try {
      await writeResumeStore('allowed', 1, liveServer.socketPath, 'https://github.com/example/repo/issues/1');
      await writeResumeStore('excluded', 1, liveServer.socketPath, 'https://github.com/example/other/issues/2');
      const pool = await createOperatorWatchPool({
        repoRoot: context.repoRoot,
        dispatchQueue: createOperatorDispatchQueue(),
        profileIncludes: ['example/*'],
        repoFilters: ['example/repo'],
      });
      try {
        await pool.scanAutoSessionsOnce();
        expect(pool.getLiveStatus('allowed')?.connectivity).toBe('reachable');
        expect(pool.getLiveStatus('excluded')).toBeUndefined();
        pool.close();
        await pool.scanAutoSessionsOnce();
        expect(pool.getLiveStatus('excluded')).toBeUndefined();
      } finally {
        pool.close();
      }
    } finally {
      await liveServer.close();
    }
  });

  it('does not attach a session when closed during an automatic probe', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-auto-close-'));
    let release!: () => void;
    let observed!: () => void;
    const observationStarted = new Promise<void>((resolve) => { observed = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => {
        observed();
        await blocked;
        return { sequence: 1, openQuestions: [] };
      },
      answerOpenQuestion: async () => { throw new Error('unused'); },
    });
    await writeResumeStore('closing', 1, liveServer.socketPath);
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: createOperatorDispatchQueue() });
    try {
      const scan = pool.scanAutoSessionsOnce();
      await observationStarted;
      pool.close();
      release();
      await scan;
      expect(pool.getLiveStatus('closing')).toBeUndefined();
      expect(pool.list()).toEqual([]);
    } finally {
      release();
      pool.close();
      await liveServer.close();
    }
  });

  it('keeps manual ownership when automatic discovery disconnects the same session', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-auto-manual-'));
    let observations = 0;
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => { observations += 1; return { sequence: 1, openQuestions: [] }; },
      answerOpenQuestion: async () => { throw new Error('unused'); },
    });
    await writeResumeStore('shared', 1, liveServer.socketPath);
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: createOperatorDispatchQueue() });
    try {
      await pool.register('shared', { pollIntervalMs: 60_000, debounceMs: 123 });
      await pool.scanAutoSessionsOnce();
      expect(pool.list()).toEqual([{ conductorAgentId: 'shared', pollIntervalMs: 60_000, debounceMs: 123 }]);
      expect(observations).toBe(1);
      await liveServer.close();
      await pool.scanAutoSessionsOnce();
      expect(pool.list()).toEqual([{ conductorAgentId: 'shared', pollIntervalMs: 60_000, debounceMs: 123 }]);
    } finally {
      pool.close();
    }
  });

  it('does not automatically attach ambiguous conductor IDs across issues', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-auto-ambiguous-'));
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => ({ sequence: 1, openQuestions: [] }),
      answerOpenQuestion: async () => { throw new Error('unused'); },
    });
    try {
      await writeResumeStore('ambiguous', 1, liveServer.socketPath, 'https://github.com/example/repo/issues/1');
      await writeResumeStore('ambiguous', 2, liveServer.socketPath, 'https://github.com/example/other/issues/2');
      const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: createOperatorDispatchQueue() });
      try {
        await pool.scanAutoSessionsOnce();
        expect(pool.getLiveStatus('ambiguous')).toBeUndefined();
        expect(await pool.pollOnce('ambiguous')).toBe(0);
      } finally {
        pool.close();
      }
    } finally {
      await liveServer.close();
    }
  });

  it('retains an automatic watch when a later probe times out', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-auto-timeout-'));
    let wait = false;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => {
        if (wait) await blocked;
        return { sequence: 1, openQuestions: [] };
      },
      answerOpenQuestion: async () => { throw new Error('unused'); },
    });
    await writeResumeStore('slow', 1, liveServer.socketPath);
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: createOperatorDispatchQueue() });
    try {
      await pool.scanAutoSessionsOnce();
      expect(pool.getLiveStatus('slow')?.connectivity).toBe('reachable');
      wait = true;
      const scan = pool.scanAutoSessionsOnce();
      setTimeout(() => { wait = false; release(); }, 1_200);
      await scan;
      expect(pool.getLiveStatus('slow')?.connectivity).toBe('reachable');
    } finally {
      release();
      pool.close();
      await liveServer.close();
    }
  });

  it('watches through the canonical slug socket without reading a path-hash duplicate', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-duplicate-'));
    const agentId = 'duplicate-live-session';
    const issueUrl = 'https://github.com/example/live-socket/issues/607';
    const paths = resolveEnsemblePaths({ repoRoot: context.repoRoot });
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
    context.closeServers.push(() => liveServer.close());

    const hashPath = join(paths.legacyHashSessionsDir, `${agentId}.json`);
    const slugPath = paths.canonicalSessionResumeStorePath(issueUrl, agentId);
    const hashStore = {
      version: 1,
      conductorAgentId: agentId,
      issueUrl,
      repoRoot: context.repoRoot,
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
      repoRoot: context.repoRoot,
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
        priority: 'open_question',
      });
      expect(batch?.events[0]?.type === 'report' && batch.events[0].text).toContain(
        'A later question from the live harness?',
      );
    } finally {
      pool.close();
    }
  });

  it('uses canonical slug YAML for snapshot watch fallback when duplicate hash YAML is stale', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-slug-yaml-'));
    const agentId = 'duplicate-offline-session';
    const issueUrl = 'https://github.com/example/offline-yaml/issues/608';
    const paths = resolveEnsemblePaths({ repoRoot: context.repoRoot });
    const resumeStore = {
      version: 1,
      conductorAgentId: agentId,
      issueUrl,
      repoRoot: context.repoRoot,
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
      findSessionResumeStore(context.repoRoot, agentId),
    ).resolves.toMatchObject({
      resumeStore: { issueUrl, conductorAgentId: agentId },
      location: 'canonical-slug',
    });
    const dispatchQueue = createOperatorDispatchQueue();
    const diagnostics: string[] = [];
    const pool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-location-yaml-'));
    const paths = resolveEnsemblePaths({ repoRoot: context.repoRoot });
    const issueUrl = 'https://github.com/example/canonical-snapshots/issues/607';
    const agentId = 'canonical-snapshots';
    const resumeStore = {
      version: 1,
      conductorAgentId: agentId,
      issueUrl,
      repoRoot: context.repoRoot,
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
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
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
});
