import {
  resolveEnsemblePaths,
  startOpenQuestionControlServer,
  type SessionObservationSnapshot
} from '@agents-ensemble/core';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createSendOperatorMessageTool } from '../tools/open-question-control-tools.js';
import {
  createOperatorDispatchQueue,
  formatOperatorDispatchBatch,
} from '../dispatch/operator-dispatch.js';
import { retryOperatorWatchAcknowledgement } from './operator-watch-ack.js';
import {
  createRegisterSessionWatchTool
} from './operator-watch-pool.js';
import { withOperatorWorkspaceLock } from '../workspace/operator-workspace-lock.js';

import { DEFAULT_ISSUE_URL, currentWatchStatePath, setupWatchPoolSuite } from '../../test/support/watch-pool-suite.js';

setupWatchPoolSuite((context) => {
  const { createOperatorWatchPool, writeResumeStore, writeOfflineSnapshots } = context;


  it('rejects duplicate pending report IDs and invalid persisted timing values', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-reports-'));
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
    const statePath = currentWatchStatePath(context.repoRoot);
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
          repoRoot: context.repoRoot,
          dispatchQueue: createOperatorDispatchQueue(),
        }),
      ).rejects.toThrow('Invalid operator-agent watch state');
    }
  });

  it('deduplicates live Registry and YAML observations and reports question transitions once', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-dedup-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
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
    context.closeServers.push(() => liveServer.close());
    await writeResumeStore('live-dedup', 1, liveServer.socketPath);

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
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
        resolveEnsemblePaths({ repoRoot: context.repoRoot }).canonicalSessionStatePath(
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-lifecycle-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
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
    context.closeServers.push(() => liveServer.close());
    await writeResumeStore('session-lifecycle', 1, liveServer.socketPath);

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-logs-'));
    await writeResumeStore('session-private', 1);
    const secretBody = 'private-question-body-marker';
    const malformedSnapshotPath =
      resolveEnsemblePaths({ repoRoot: context.repoRoot }).canonicalOpenQuestionsPath(
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
      repoRoot: context.repoRoot,
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

  it('recovers timer polling and report delivery after workspace lock timeouts', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'watch-workspace-timeout-'));
    await writeResumeStore('timeout-session', 1);
    const errors: string[] = [];
    const queue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({
      repoRoot: context.repoRoot, dispatchQueue: queue, onError: (message) => errors.push(message),
    });
    let release!: () => void;
    let held: Promise<void> | undefined;
    try {
      await pool.register('timeout-session', { pollIntervalMs: 250, debounceMs: 0 });
      const reportId = await pool.enqueueIdleCandidate!({
        conductorAgentId: 'timeout-session', text: 'pending report',
        kind: 'idle_phase', fingerprint: 'timeout-test', eligibleAt: Date.now(),
      });
      const batch = queue.selectBatch({ continuationConsumed: false }, Date.now())!;
      expect(batch.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ reportId }),
      ]));
      const workspace = await realpath(join(context.homeRoot, '.ensemble', 'operator-agents', 'default'));
      let entered!: () => void;
      const acquired = new Promise<void>((resolve) => { entered = resolve; });
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      held = withOperatorWorkspaceLock(workspace, async () => { entered(); await barrier; });
      await acquired;
      await vi.waitFor(() => expect(errors.some((message) =>
        message.includes('Failed to poll watched session timeout-session'))).toBe(true),
      { timeout: 5000 });
      await expect(pool.commitBatch(batch)).rejects.toThrow('Could not acquire operator workspace lock');
      release();
      await held;
      held = undefined;
      await vi.waitFor(() => expect(pool.getLiveStatus('timeout-session')).toBeDefined(), { timeout: 5000 });
      const retry = queue.selectBatch({ continuationConsumed: false }, Date.now())!;
      expect(retry.events).toEqual(expect.arrayContaining([expect.objectContaining({ reportId })]));
      expect(await pool.commitBatch(retry)).toBe(true);

      let enteredAck!: () => void;
      const ackAcquired = new Promise<void>((resolve) => { enteredAck = resolve; });
      const ackBarrier = new Promise<void>((resolve) => { release = resolve; });
      held = withOperatorWorkspaceLock(workspace, async () => { enteredAck(); await ackBarrier; });
      await ackAcquired;
      const result = await retryOperatorWatchAcknowledgement(
        () => pool.acknowledge(retry.events),
        async () => { release(); await held; held = undefined; return false; },
      );
      expect(result).toMatchObject({ status: 'acknowledged', attempts: 2, retries: 1 });
      const persisted = JSON.parse(await readFile(currentWatchStatePath(context.repoRoot), 'utf8')) as { pendingReports: unknown[] };
      expect(persisted.pendingReports).toEqual([]);
    } finally {
      if (held) { release(); await held; }
      pool.close();
    }
  }, 15000);

  it('registers and removes watches through bounded tools', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-tools-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    await writeResumeStore('session-one', 1);
    const pool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
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

  it('prepares or reuses a listener before sending and reports an immediate response once', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-send-listen-'));
    const messages: Array<{ text: string; inbound: string; at: number; sendCount: number }> = [];
    const send = vi.fn(({ text }: { text: string }) => {
      messages.push({ text: 'immediate response', inbound: text, at: Date.now(), sendCount: messages.length + 1 });
      return true;
    });
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      listConductorMessages: () => messages,
      sendOperatorMessage: send,
      answerOpenQuestion: async () => { throw new Error('unused'); },
    });
    context.closeServers.push(() => liveServer.close());
    await writeResumeStore('send-listen', 1, liveServer.socketPath);
    const queue = createOperatorDispatchQueue();
    queue.setFocus('another-session');
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: queue });
    const tool = createSendOperatorMessageTool(context.repoRoot, undefined, (id) => pool.ensureConductorMessageListen(id));
    try {
      const first = await tool.execute({ conductorAgentId: 'send-listen', text: 'first', listen: true });
      expect(first.structuredContent).toMatchObject({ queued: true, listen: 'created', conductorAgentId: 'send-listen' });
      expect(queue.focusSessionId).toBe('another-session');
      expect(await pool.pollConductorMessagesOnce('send-listen')).toBe(1);
      await pool.registerConductorMessageListen('send-listen', { messageDebounceMs: 321 });
      const path = currentWatchStatePath(context.repoRoot);
      const before = JSON.parse(await readFile(path, 'utf8'));
      const second = await tool.execute({ conductorAgentId: 'send-listen', text: 'second', listen: true });
      expect(second.structuredContent).toMatchObject({ queued: true, listen: 'reused' });
      const after = JSON.parse(await readFile(path, 'utf8'));
      expect(after.messageListeners).toEqual(before.messageListeners);
      expect(after.messageListeners['send-listen'].messageDebounceMs).toBe(321);
      expect(after.messageCursors).toEqual(before.messageCursors);
      expect(await pool.pollConductorMessagesOnce('send-listen')).toBe(1);
      const final = JSON.parse(await readFile(path, 'utf8'));
      expect(final.pendingReports.map((report: { sendCount: number }) => report.sendCount)).toEqual([1, 2]);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      pool.close();
    }
  });
});
