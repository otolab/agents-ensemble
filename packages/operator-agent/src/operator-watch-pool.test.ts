import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  createRegisterSessionWatchTool,
  operatorWatchStatePath,
} from './operator-watch-pool.js';

describe('operator watch pool', () => {
  let repoRoot = '';
  let homeRoot = '';
  let closeServers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    homeRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-home-'));
    vi.stubEnv('HOME', homeRoot);
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

  it('migrates legacy project watch state into the user-scoped repository directory', async () => {
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
      expect(pool.list()).toEqual([
        {
          conductorAgentId: 'session-one',
          pollIntervalMs: 60_000,
          debounceMs: 0,
        },
      ]);
      expect(
        JSON.parse(await readFile(operatorWatchStatePath(repoRoot), 'utf8')),
      ).toEqual({
        ...legacyState,
        messageListeners: {},
        messageCursors: {},
      });
      expect(JSON.parse(await readFile(legacyPath, 'utf8'))).toEqual(legacyState);
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
        await readFile(operatorWatchStatePath(repoRoot), 'utf8'),
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

  it('groups several oversized messages into one warning and continues in order', async () => {
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
      ).resolves.toBe(3);
      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events.map((event) => event.sendCount)).toEqual([7, 8, 9]);
      const warningReports = batch.events.filter(
        (event) =>
          event.type === 'report' &&
          event.text.includes('発言は単独のUDS responseが1 MiBを超えたため読み取れず'),
      );
      expect(warningReports).toHaveLength(1);
      expect(warningReports[0]?.text).toContain('3件');
      expect(warningReports[0]?.text).toContain('sendCount: 5, 6, 8');
      const groupedReport = formatOperatorDispatchBatch(batch.events);
      expect((groupedReport.match(/⚠/g) ?? [])).toHaveLength(1);
      expect(groupedReport.indexOf('sendCount: 7')).toBeLessThan(
        groupedReport.indexOf('sendCount: 5, 6, 8'),
      );
      expect(groupedReport.indexOf('sendCount: 5, 6, 8')).toBeLessThan(
        groupedReport.indexOf('sendCount: 9'),
      );
      expect(batch.events[0]?.text).toContain('inbound 7');
      expect(batch.events[2]?.text).toContain('inbound 9');

      const state = JSON.parse(
        await readFile(operatorWatchStatePath(repoRoot), 'utf8'),
      ) as {
        messageCursors: Record<string, number>;
        pendingReports: Array<{ sendCount?: number }>;
      };
      expect(state.messageCursors['message-multiple-oversized']).toBe(9);
      expect(state.pendingReports.map((report) => report.sendCount)).toEqual([
        7, 8, 9,
      ]);
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
        await readFile(operatorWatchStatePath(repoRoot), 'utf8'),
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
        await readFile(operatorWatchStatePath(repoRoot), 'utf8'),
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
        await readFile(operatorWatchStatePath(repoRoot), 'utf8'),
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
        await readFile(operatorWatchStatePath(repoRoot), 'utf8'),
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
      join(sessionDir, 'session-state.yaml'),
      `version: 1\nstatusLine: "${input.statusLine}"\nreportedAt: ${input.reportedAt}\n`,
    );
  }
});
