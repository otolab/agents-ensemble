import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPEN_QUESTION_CONTROL_METHODS,
  OpenQuestionControlRemoteError,
  sendOpenQuestionControlRequest,
  startOpenQuestionControlServer,
  type SessionObservationSnapshot,
} from '@agents-ensemble/core';
import {
  createOperatorDispatchQueue,
  formatOperatorDispatchBatch,
} from './operator-dispatch.js';
import {
  createOperatorWatchPool,
  operatorWatchStatePath,
} from './operator-watch-pool.js';

describe('operator watch pool', () => {
  let repoRoot = '';
  let closeServers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closeServers) await close();
    closeServers = [];
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    repoRoot = '';
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
      expect(dispatchQueue.pendingEventCount).toBe(2);

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
      expect(await pool.pollOnce('live-one')).toBe(1);
      expect(await pool.pollOnce('offline-two')).toBe(1);
      expect(dispatchQueue.pendingEventCount).toBe(4);

      const firstBatch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      );
      expect(firstBatch?.sourceKey).toBe('open_question:live-one');
      expect(firstBatch?.events[0]?.text).toContain('New live question?');
      expect(dispatchQueue.pendingEventCount).toBe(3);
      await pool.acknowledge(firstBatch!.events);

      expect(await pool.pollOnce('live-one')).toBe(0);
      expect(await pool.pollOnce('offline-two')).toBe(0);
      const stored = JSON.parse(
        await readFile(operatorWatchStatePath(repoRoot), 'utf8'),
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
        expect(resumedQueue.pendingEventCount).toBe(3);
      } finally {
        resumedPool.close();
      }
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
    expect(firstAttempt.events[0]?.type).toBe('report');
    if (firstAttempt.events[0]?.type === 'report') {
      expect(firstAttempt.events[0].reportType).toBe('open_question');
      expect(firstAttempt.events[0].text).toContain('New report to retry?');
    }
    const firstReportId = firstAttempt.events[0]!.reportId;
    expect(firstReportId).toBeTruthy();
    expect(firstQueue.pendingEventCount).toBe(1);
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
      expect(retry.events[0]?.reportId).toBe(firstReportId);

      await resumedPool.acknowledge(retry.events);
      const stored = JSON.parse(
        await readFile(operatorWatchStatePath(repoRoot), 'utf8'),
      ) as { pendingReports: Array<{ reportId: string }> };
      expect(stored.pendingReports).toHaveLength(1);
      expect(stored.pendingReports[0]?.reportId).not.toBe(firstReportId);
    } finally {
      resumedPool.close();
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
    const statePath = operatorWatchStatePath(repoRoot);
    await mkdir(join(repoRoot, '.ensemble', 'operator-agent'), {
      recursive: true,
    });

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

  it('rejects duplicate pending report IDs and invalid persisted debounce values', async () => {
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
    ];
    const statePath = operatorWatchStatePath(repoRoot);
    await mkdir(join(repoRoot, '.ensemble', 'operator-agent'), {
      recursive: true,
    });

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

  it('deduplicates live Registry and YAML observations and reports only new open questions', async () => {
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
        join(
          repoRoot,
          '.ensemble',
          'sessions',
          'live-dedup',
          'session-state.yaml',
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

      // A status/body update is not a new question. An answered item first
      // observed in YAML is not an open-question notification either.
      await writeQuestions(2, [
        { ...firstQuestion, status: 'answered', question: 'Updated body' },
        {
          id: 'inq-2',
          question: 'Already answered?',
          responseType: 'text',
          source: 'conductor',
          status: 'answered',
          askedAt: 11,
        },
      ]);
      expect(await pool.pollOnce('live-dedup')).toBe(0);

      await writeQuestions(3, [
        { ...firstQuestion, status: 'answered' },
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
      expect(dispatchQueue.pendingEventCount).toBe(2);
      const report = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      );
      expect(report?.events.map((event) => event.text)).toEqual([
        expect.stringContaining('Should we proceed?'),
        expect.stringContaining('New while offline?'),
      ]);
    } finally {
      pool.close();
    }
  });

  it('keeps Open Question text out of watch poll warning logs', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-logs-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    await writeResumeStore('session-private', 1);
    const secretBody = 'private-question-body-marker';
    const sessionDir = join(repoRoot, '.ensemble', 'sessions', 'session-private');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'open-questions.yaml'),
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

      const storedPath = operatorWatchStatePath(repoRoot);
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
        '### 1/2\n\n対象: https://github.com/example/repo/issues/message-listen-one (message-listen-one)\nsendCount: 5',
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
        await readFile(operatorWatchStatePath(repoRoot), 'utf8'),
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

  it('queues pages collected before a single oversized message without skipping the blocker', async () => {
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
      ).rejects.toMatchObject<Partial<OpenQuestionControlRemoteError>>({
        rpcCode: -32603,
        message: 'Response is too large.',
      });

      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events.map((event) => event.sendCount)).toEqual([5, 6]);
      for (const event of batch.events) {
        if (event.type === 'report') {
          expect(event.text).toContain(`#### inbound\n\n${inbound}`);
        }
      }
      const state = JSON.parse(
        await readFile(operatorWatchStatePath(repoRoot), 'utf8'),
      ) as {
        messageCursors: Record<string, number>;
        pendingReports: Array<{ sendCount?: number }>;
      };
      expect(state.messageCursors['message-partial-pages']).toBe(6);
      expect(state.pendingReports.map((report) => report.sendCount)).toEqual([
        5, 6,
      ]);
    } finally {
      pool.close();
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
          await readFile(operatorWatchStatePath(repoRoot), 'utf8'),
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
  ) {
    await writeFile(
      join(repoRoot, '.ensemble', 'sessions', `${agentId}.json`),
      JSON.stringify({
        version: 1,
        conductorAgentId: agentId,
        issueUrl: `https://github.com/example/repo/issues/${agentId}`,
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
      sequence: number;
      questions: Array<Record<string, unknown>>;
      statusLine: string;
      reportedAt: number;
    },
  ) {
    const sessionDir = join(repoRoot, '.ensemble', 'sessions', agentId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'open-questions.yaml'),
      [
        'version: 1',
        `sequence: ${input.sequence}`,
        'openQuestions:',
        ...input.questions.flatMap((question) => [
          `  - id: ${question.id}`,
          `    question: "${question.question}"`,
          `    responseType: ${question.responseType}`,
          `    source: ${question.source}`,
          `    status: ${question.status}`,
          `    askedAt: ${question.askedAt}`,
        ]),
        '',
      ].join('\n'),
    );
    await writeFile(
      join(sessionDir, 'session-state.yaml'),
      `version: 1\nstatusLine: "${input.statusLine}"\nreportedAt: ${input.reportedAt}\n`,
    );
  }
});
