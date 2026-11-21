import {
  startOpenQuestionControlServer,
  type SessionObservationSnapshot
} from '@agents-ensemble/core';
import { mkdirSync, renameSync, rmdirSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import {
  createOperatorDispatchQueue
} from '../dispatch/operator-dispatch.js';
import {
  operatorWatchStatePath
} from './operator-watch-pool.js';

import { DEFAULT_ISSUE_URL, currentWatchStatePath, setupWatchPoolSuite, startWatchPollProcess } from '../../test/support/watch-pool-suite.js';

setupWatchPoolSuite((context) => {
  const { createOperatorWatchPool, writeResumeStore, writeOfflineSnapshots } = context;


  it('restores unacknowledged reports after restart and removes only acknowledged reports', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-retry-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
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
      repoRoot: context.repoRoot,
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
      repoRoot: context.repoRoot,
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
        await readFile(currentWatchStatePath(context.repoRoot), 'utf8'),
      ) as { pendingReports: Array<{ reportId: string }> };
      expect(stored.pendingReports).toHaveLength(1);
      expect(stored.pendingReports[0]?.reportId).toBe(remainingReportId);
    } finally {
      resumedPool.close();
    }

    const finalQueue = createOperatorDispatchQueue();
    const finalPool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
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
          await readFile(currentWatchStatePath(context.repoRoot), 'utf8'),
        ).pendingReports,
      ).toEqual([]);
    } finally {
      finalPool.close();
    }
  });

  it('uses the first snapshot as a silent baseline for existing open questions', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-baseline-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
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
    context.closeServers.push(() => liveServer.close());
    await writeResumeStore('session-baseline', 1, liveServer.socketPath);

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-handoff-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
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
    context.closeServers.push(() => server.close());
    await writeResumeStore(agentId, 1, server.socketPath, issueUrl);

    const peerQueue = createOperatorDispatchQueue();
    const peerPool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
      dispatchQueue: peerQueue,
    });
    const statePath = currentWatchStatePath(context.repoRoot);
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
        join(context.homeRoot, '.ensemble'),
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
          context.homeRoot,
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

  it('keeps post-commit arrivals in a new ordered batch across restart', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-frozen-batch-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const sessionId = 'frozen-session';
    const issueUrl = DEFAULT_ISSUE_URL;
    await writeResumeStore(sessionId, 1, undefined, issueUrl);
    const statePath = currentWatchStatePath(context.repoRoot);
    await mkdir(dirname(statePath), { recursive: true });
    const queuedAt = Date.now() - 60_000;
    const arrivalOrder = Date.now() * 1_000 + 10_000_000;
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        watches: {},
        cursors: {},
        pendingReports: [
          {
            reportId: 'frozen-open-question',
            reportType: 'open_question',
            conductorAgentId: sessionId,
            issueUrl,
            text: 'question already in the shared queue',
            debounceMs: 0,
            readyAt: queuedAt,
            arrivalOrder,
            firstQueuedAt: queuedAt,
            priority: 'open_question',
          },
        ],
      }),
    );

    const firstQueue = createOperatorDispatchQueue();
    const firstPool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
      dispatchQueue: firstQueue,
    });
    let frozenPayload = '';
    let retryAt = 0;
    let idleReportId = '';
    try {
      const first = firstQueue.selectBatch(
        { continuationConsumed: false },
        queuedAt,
      )!;
      expect(first.events.map((event) => event.reportId)).toEqual([
        'frozen-open-question',
      ]);
      expect(await firstPool.commitBatch(first)).toBe(true);
      frozenPayload = first.payload!;
      const frozenAtCommit = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as {
        pendingReports: Array<{
          reportId: string;
          frozenBatchId?: string;
          frozenPayload?: string;
        }>;
      };
      expect(frozenAtCommit.pendingReports[0]).toMatchObject({
        reportId: 'frozen-open-question',
        frozenBatchId: first.batchId,
        frozenPayload,
      });
      idleReportId = (await firstPool.enqueueIdleCandidate!({
        conductorAgentId: sessionId,
        text: '中立的な idle 確認候補',
        kind: 'idle_phase',
        fingerprint: 'idle-evidence-v1',
        eligibleAt: Date.now(),
      }))!;
      const afterPostCommitEnqueue = JSON.parse(
        await readFile(statePath, 'utf8'),
      ) as {
        pendingReports: Array<{
          reportId: string;
          arrivalOrder: number;
          firstQueuedAt: number;
        }>;
      };
      const postCommitReport = afterPostCommitEnqueue.pendingReports.find(
        (report) => report.reportId === idleReportId,
      )!;
      expect(postCommitReport.firstQueuedAt).toBeGreaterThan(queuedAt);
      expect(postCommitReport.arrivalOrder).toBeGreaterThan(arrivalOrder);

      retryAt = Date.now() + 5_000;
      await firstPool.recordRetry?.(first.events, retryAt);
      const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
        pendingReports: Array<{
          reportId: string;
          readyAt: number;
          frozenBatchId?: string;
          frozenPayload?: string;
          retryReadyAt?: number;
        }>;
      };
      expect(persisted.pendingReports[0]).toMatchObject({
        reportId: 'frozen-open-question',
        readyAt: queuedAt,
        frozenBatchId: first.batchId,
        frozenPayload,
        retryReadyAt: retryAt,
      });
    } finally {
      firstPool.close();
    }

    const resumedQueue = createOperatorDispatchQueue();
    const resumedPool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
      dispatchQueue: resumedQueue,
    });
    try {
      expect(
        resumedQueue.selectBatch(
          { continuationConsumed: false },
          retryAt - 1,
        ),
      ).toBeUndefined();
      const retry = resumedQueue.selectBatch(
        { continuationConsumed: false },
        retryAt,
      )!;
      expect(retry.events.map((event) => event.reportId)).toEqual([
        'frozen-open-question',
      ]);
      expect(retry.payload).toBe(frozenPayload);
      expect(await resumedPool.commitBatch(retry)).toBe(true);
      await resumedPool.acknowledge(retry.events);

      const idleOnly = resumedQueue.selectBatch(
        { continuationConsumed: false },
        retryAt,
      )!;
      expect(idleOnly.events.map((event) => event.reportId)).toEqual([
        idleReportId,
      ]);
      expect(idleOnly.priority).toBe('idle');
      await resumedPool.acknowledge(idleOnly.events);
    } finally {
      resumedPool.close();
    }
  });

  it('records fresh live phase evidence and keeps idle fingerprints through acknowledgement and restart', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-idle-fingerprint-'));
    const sessionId = 'idle-fingerprint-session';
    const harnessModifiedAt = Date.now() - 31 * 60_000;
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => ({
        sequence: 0,
        openQuestions: [],
      }),
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    context.closeServers.push(() => liveServer.close());
    await writeResumeStore(
      sessionId,
      Date.now(),
      liveServer.socketPath,
      DEFAULT_ISSUE_URL,
      {
        harnessPhase: 'idle',
        modifiedAt: harnessModifiedAt,
        lifecycle: 'unknown',
      },
    );

    const queue = createOperatorDispatchQueue();
    let pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: queue });
    let firstReportId = '';
    let retryReadyAt = 0;
    const fingerprint = 'sha256:idle-phase-v1';
    try {
      await pool.register(sessionId, { pollIntervalMs: 60_000, debounceMs: 0 });
      await pool.pollOnce(sessionId);
      expect(pool.listIdleCandidateObservations()).toMatchObject([
        {
          conductorAgentId: sessionId,
          source: 'uds',
          connectivity: 'reachable',
          harnessPhase: 'idle',
          harnessModifiedAt,
        },
      ]);
      firstReportId = (await pool.enqueueIdleCandidate!({
        conductorAgentId: sessionId,
        text: 'idle phase candidate',
        kind: 'idle_phase',
        fingerprint,
        eligibleAt: Date.now(),
      }))!;
      expect(firstReportId).toBeTypeOf('string');
      await expect(
        pool.enqueueIdleCandidate!({
          conductorAgentId: sessionId,
          text: 'same evidence',
          kind: 'idle_phase',
          fingerprint,
          eligibleAt: Date.now(),
        }),
      ).resolves.toBeUndefined();

      const batch = queue.selectBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events.map((event) =>
        event.type === 'report' ? event.reportId : undefined,
      )).toEqual([firstReportId]);
      expect(await pool.commitBatch(batch)).toBe(true);
      retryReadyAt = Date.now() + 5_000;
      await pool.recordRetry?.(batch.events, retryReadyAt);
    } finally {
      pool.close();
    }

    const retryQueue = createOperatorDispatchQueue();
    pool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
      dispatchQueue: retryQueue,
    });
    try {
      await pool.pollOnce(sessionId);
      expect(
        retryQueue.selectBatch({ continuationConsumed: false }, retryReadyAt - 1),
      ).toBeUndefined();
      const retried = retryQueue.selectBatch(
        { continuationConsumed: false },
        retryReadyAt,
      )!;
      expect(retried.events.map((event) =>
        event.type === 'report' ? event.reportId : undefined,
      )).toEqual([firstReportId]);
      expect(retried.batchId).toBeDefined();
      expect(await pool.commitBatch(retried)).toBe(true);
      await pool.acknowledge(retried.events);
      const persisted = JSON.parse(
        await readFile(currentWatchStatePath(context.repoRoot), 'utf8'),
      ) as {
        idleCandidateFingerprints: Record<string, Record<string, string>>;
        pendingReports: unknown[];
      };
      expect(persisted.idleCandidateFingerprints[sessionId]?.idle_phase)
        .toBe(fingerprint);
      expect(persisted.pendingReports).toEqual([]);
      await expect(
        pool.enqueueIdleCandidate!({
          conductorAgentId: sessionId,
          text: 'same evidence after restart',
          kind: 'idle_phase',
          fingerprint: 'sha256:idle-phase-v1',
          eligibleAt: Date.now(),
        }),
      ).resolves.toBeUndefined();
      expect(pool.listIdleCandidateObservations()).toHaveLength(1);
    } finally {
      pool.close();
    }
  });

  it('releases process-local holds on restart and replays a held pending idle candidate', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-idle-held-restart-'));
    const sessionId = 'idle-held-restart-session';
    await writeResumeStore(sessionId, Date.now(), undefined, DEFAULT_ISSUE_URL, {
      harnessPhase: 'idle',
      modifiedAt: Date.now() - 31 * 60_000,
      lifecycle: 'unknown',
    });

    const fingerprint = 'sha256:held-idle-replay-v1';
    const firstQueue = createOperatorDispatchQueue();
    firstQueue.setHold(true);
    firstQueue.setConversationHold(true);
    let pool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
      dispatchQueue: firstQueue,
    });
    let reportId = '';
    try {
      reportId = (await pool.enqueueIdleCandidate!({
        conductorAgentId: sessionId,
        text: 'held idle candidate survives restart',
        kind: 'idle_phase',
        fingerprint,
        eligibleAt: Date.now(),
      }))!;
      expect(reportId).toBeTypeOf('string');
      expect(firstQueue.hold).toBe(true);
      expect(firstQueue.heldEventCount).toBe(1);
      const persisted = JSON.parse(
        await readFile(currentWatchStatePath(context.repoRoot), 'utf8'),
      ) as {
        idleCandidateFingerprints: Record<string, Record<string, string>>;
        pendingReports: Array<{ reportId: string }>;
      };
      expect(persisted.idleCandidateFingerprints[sessionId]?.idle_phase)
        .toBe(fingerprint);
      expect(persisted.pendingReports.map((report) => report.reportId)).toEqual([
        reportId,
      ]);
    } finally {
      pool.close();
    }

    const restartedQueue = createOperatorDispatchQueue();
    expect(restartedQueue.hold).toBe(false);
    pool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
      dispatchQueue: restartedQueue,
    });
    let firstReplayBatchId: string | undefined;
    let firstReplayPayload: string | undefined;
    try {
      expect(restartedQueue.heldEventCount).toBe(0);
      const replay = restartedQueue.selectBatch({
        continuationConsumed: false,
      })!;
      expect(replay.events.map((event) =>
        event.type === 'report' ? event.reportId : undefined,
      )).toEqual([reportId]);
      expect(await pool.commitBatch(replay)).toBe(true);
      firstReplayBatchId = replay.batchId;
      firstReplayPayload = replay.payload;
    } finally {
      pool.close();
    }

    const replayQueue = createOperatorDispatchQueue();
    pool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
      dispatchQueue: replayQueue,
    });
    try {
      const replay = replayQueue.selectBatch({
        continuationConsumed: false,
      })!;
      expect(replay.events.map((event) =>
        event.type === 'report' ? event.reportId : undefined,
      )).toEqual([reportId]);
      expect(replay.batchId).toBe(firstReplayBatchId);
      expect(replay.payload).toBe(firstReplayPayload);
      await pool.acknowledge(replay.events);
      const persisted = JSON.parse(
        await readFile(currentWatchStatePath(context.repoRoot), 'utf8'),
      ) as {
        idleCandidateFingerprints: Record<string, Record<string, string>>;
        pendingReports: unknown[];
      };
      expect(persisted.idleCandidateFingerprints[sessionId]?.idle_phase)
        .toBe(fingerprint);
      expect(persisted.pendingReports).toEqual([]);
    } finally {
      pool.close();
    }
  });

  it('combines a pending live Open Question and idle candidate into one shared send in the normal path', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-idle-oq-batch-'));
    const sessionId = 'idle-oq-session';
    const liveQuestions: SessionObservationSnapshot['openQuestions'] = [];
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => liveQuestions,
      observeSession: async () => ({
        sequence: liveQuestions.length,
        openQuestions: liveQuestions,
      }),
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    context.closeServers.push(() => liveServer.close());
    await writeResumeStore(
      sessionId,
      Date.now(),
      liveServer.socketPath,
      DEFAULT_ISSUE_URL,
      {
        harnessPhase: 'idle',
        modifiedAt: Date.now() - 31 * 60_000,
        lifecycle: 'unknown',
      },
    );
    const queue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: queue });
    try {
      await pool.register(sessionId, { pollIntervalMs: 60_000, debounceMs: 0 });
      await pool.pollOnce(sessionId);
      liveQuestions.push({
        id: 'inq-live',
        question: 'Which option should we use?',
        responseType: 'choice',
        source: 'conductor',
        status: 'open',
        askedAt: Date.now(),
      });
      expect(await pool.pollOnce(sessionId)).toBe(1);
      const idleReportId = await pool.enqueueIdleCandidate!({
        conductorAgentId: sessionId,
        text: 'idle phase candidate',
        kind: 'idle_phase',
        fingerprint: 'idle-oq-evidence',
        eligibleAt: Date.now(),
      });

      const batch = queue.selectBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.priority).toBe('open_question');
      expect(batch.events.map((event) =>
        event.type === 'report' ? event.reportType : undefined,
      )).toEqual(['open_question', 'idle_candidate']);
      expect(batch.events.map((event) =>
        event.type === 'report' ? event.reportId : undefined,
      )).toEqual([expect.any(String), idleReportId]);
      expect(await pool.commitBatch(batch)).toBe(true);
      expect(batch.payload).toContain('Which option should we use?');
      expect(batch.payload).toContain('idle phase candidate');
      await pool.acknowledge(batch.events);
    } finally {
      pool.close();
    }
  });

  it('includes local arrivals during lock wait but leaves unsynchronized peer reports for the next batch', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-commit-cutoff-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const sessionId = 'commit-cutoff-session';
    await writeResumeStore(sessionId, 1, undefined, DEFAULT_ISSUE_URL);

    const dispatchQueue = createOperatorDispatchQueue();
    const userEnsembleRoot = process.env.ENSEMBLE_USER_ROOT!;
    const pool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
      userEnsembleRoot,
      dispatchQueue,
    });
    const lockPath = join(
      userEnsembleRoot,
      'operator-agents',
      'default',
      'watch',
      'watch-state-lock.sqlite',
    );
    const statePath = operatorWatchStatePath(
      userEnsembleRoot,
      'default',
      DEFAULT_ISSUE_URL,
    );
    let stateLock: DatabaseSync | undefined;
    let lockHeld = false;
    try {
      const firstReportId = (await pool.enqueueIdleCandidate!({
        conductorAgentId: sessionId,
        text: 'first candidate',
        kind: 'idle_phase',
        fingerprint: 'idle-first',
        eligibleAt: Date.now(),
      }))!;
      const batch = dispatchQueue.selectBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events.map((event) =>
        event.type === 'report' ? event.reportId : undefined,
      )).toEqual([firstReportId]);

      const durable = JSON.parse(await readFile(statePath, 'utf8'));
      const firstOrder = durable.pendingReports[0].arrivalOrder;
      const firstEligibleAt = durable.pendingReports[0].eligibleAt;
      expect(firstEligibleAt).toBeTypeOf('number');
      const queuedAt = Date.now();
      for (const [index, reportId] of ['local-arrival-during-lock-wait', 'peer-unsynced'].entries()) {
        durable.pendingReports.push({
          reportId,
          reportType: index === 0 ? 'open_question' : 'session_state',
          conductorAgentId: sessionId,
          issueUrl: DEFAULT_ISSUE_URL,
          text: reportId,
          debounceMs: 0,
          readyAt: queuedAt,
          firstQueuedAt: queuedAt,
          arrivalOrder: firstOrder + index + 1,
          priority: index === 0 ? 'open_question' : 'normal',
        });
      }
      await writeFile(statePath, JSON.stringify(durable));
      stateLock = new DatabaseSync(lockPath);
      stateLock.exec('BEGIN IMMEDIATE');
      lockHeld = true;

      // The selected batch remains appendable while the profile lock is held.
      let commitSettled = false;
      const commitPromise = pool.commitBatch(batch).finally(() => {
        commitSettled = true;
      });
      expect(batch.events.map((event) =>
        event.type === 'report' ? event.reportId : undefined,
      )).toEqual([firstReportId]);
      expect(batch.batchId).toBeUndefined();

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(commitSettled).toBe(false);
      dispatchQueue.enqueueReport(
        {
          type: 'report',
          reportType: 'open_question',
          reportId: 'local-arrival-during-lock-wait',
          arrivalOrder: firstOrder + 1,
          conductorAgentId: sessionId,
          issueUrl: DEFAULT_ISSUE_URL,
          text: 'local arrival during lock wait',
        },
        0,
      );
      const staleEligibility = Date.now() - 60 * 60_000;
      const laterCandidatePromise = pool.enqueueIdleCandidate!({
        conductorAgentId: sessionId,
        text: 'arrived during lock wait',
        kind: 'stale_running',
        fingerprint: 'stale-during-lock',
        eligibleAt: staleEligibility,
      });

      const lockReleasedAt = Date.now();
      stateLock.exec('ROLLBACK');
      stateLock.close();
      stateLock = undefined;
      lockHeld = false;

      expect(await commitPromise).toBe(true);
      const laterReportId = (await laterCandidatePromise)!;
      expect(batch.events.map((event) =>
        event.type === 'report' ? event.reportId : undefined,
      )).toEqual([firstReportId, 'local-arrival-during-lock-wait']);
      expect(batch.events.map((event) =>
        event.type === 'report' ? event.reportType : undefined,
      )).toEqual(['idle_candidate', 'open_question']);
      expect(batch.events.map((event) =>
        event.type === 'report' ? event.arrivalOrder : undefined,
      )).toEqual([firstOrder, firstOrder + 1]);
      expect(batch.events[0]).toMatchObject({
        arrivalOrder: firstOrder,
        eligibleAt: firstEligibleAt,
      });
      expect(
        batch.events.filter(
          (event) =>
            event.type === 'report' && event.reportType === 'open_question',
        ),
      ).toHaveLength(1);
      expect(batch.priority).toBe('open_question');
      expect(batch.payload).toContain('first candidate');
      expect(batch.payload).toContain('local arrival during lock wait');
      expect(batch.payload).not.toContain('peer-unsynced');
      expect(batch.payload).not.toContain('arrived during lock wait');

      const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
        pendingReports: Array<{
          reportId: string;
          eligibleAt?: number;
          frozenBatchId?: string;
          frozenPayload?: string;
        }>;
      };
      expect(persisted.pendingReports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reportId: firstReportId,
            frozenBatchId: batch.batchId,
            frozenPayload: batch.payload,
          }),
          expect.objectContaining({
            reportId: 'local-arrival-during-lock-wait',
            frozenBatchId: batch.batchId,
            frozenPayload: batch.payload,
          }),
          expect.objectContaining({ reportId: 'peer-unsynced' }),
          expect.objectContaining({
            reportId: laterReportId,
            eligibleAt: expect.any(Number),
          }),
        ]),
      );
      const laterCandidate = persisted.pendingReports.find(
        (report) => report.reportId === laterReportId,
      )!;
      expect(laterCandidate.eligibleAt).toBeGreaterThanOrEqual(lockReleasedAt);
      expect(laterCandidate.frozenBatchId).toBeUndefined();

      const retryAt = Date.now() + 5 * 60_000;
      await pool.recordRetry?.(batch.events, retryAt);
      pool.close();

      const replayQueue = createOperatorDispatchQueue();
      const replayPool = await createOperatorWatchPool({
        repoRoot: context.repoRoot,
        userEnsembleRoot,
        dispatchQueue: replayQueue,
      });
      try {
        expect(
          replayQueue.selectBatch(
            { continuationConsumed: false },
            retryAt - 1,
          ),
        ).toBeUndefined();
        const retry = replayQueue.selectBatch(
          { continuationConsumed: false },
          retryAt,
        )!;
        expect(retry.events.map((event) =>
          event.type === 'report' ? event.reportId : undefined,
        )).toEqual([firstReportId, 'local-arrival-during-lock-wait']);
        expect(retry.events.map((event) =>
          event.type === 'report' ? event.reportType : undefined,
        )).toEqual(['idle_candidate', 'open_question']);
        expect(retry.events.map((event) =>
          event.type === 'report'
            ? { arrivalOrder: event.arrivalOrder, eligibleAt: event.eligibleAt }
            : undefined,
        )).toEqual([
          { arrivalOrder: firstOrder, eligibleAt: firstEligibleAt },
          { arrivalOrder: firstOrder + 1, eligibleAt: undefined },
        ]);
        expect(retry.events.filter(
          (event) =>
            event.type === 'report' && event.reportType === 'open_question',
        )).toHaveLength(1);
        expect(retry.batchId).toBe(batch.batchId);
        expect(retry.payload).toBe(batch.payload);
        expect(retry.priority).toBe('open_question');
        expect(await replayPool.commitBatch(retry)).toBe(true);
        await replayPool.acknowledge(retry.events);

        const peerBatch = replayQueue.selectBatch(
          { continuationConsumed: false },
          retryAt,
        )!;
        expect(peerBatch.events.map((event) =>
          event.type === 'report' ? event.reportId : undefined,
        )).toEqual(['peer-unsynced', laterReportId]);
        expect(await replayPool.commitBatch(peerBatch)).toBe(true);
        await replayPool.acknowledge(peerBatch.events);
      } finally {
        replayPool.close();
      }

      const afterAck = JSON.parse(await readFile(statePath, 'utf8')) as {
        idleCandidateFingerprints: Record<string, Record<string, string>>;
        pendingReports: Array<{ reportId: string }>;
      };
      expect(afterAck.idleCandidateFingerprints[sessionId]?.idle_phase)
        .toBe('idle-first');
      expect(afterAck.pendingReports).toEqual([]);
    } finally {
      if (lockHeld) stateLock?.exec('ROLLBACK');
      stateLock?.close();
      pool.close();
    }
  });

  it('retains durable arrival order when a peer report is synchronized before a local report', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-peer-order-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const sessionId = 'peer-order';
    await writeResumeStore(sessionId, 1, undefined, DEFAULT_ISSUE_URL);
    const queue = createOperatorDispatchQueue();
    const local = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: queue });
    const peer = await createOperatorWatchPool({
      repoRoot: context.repoRoot, dispatchQueue: createOperatorDispatchQueue(),
    });
    try {
      const enqueue = (pool: typeof local, text: string) => pool.enqueueIdleCandidate!({
        conductorAgentId: sessionId,
        text,
        kind: 'idle_phase',
        fingerprint: `peer-order:${text}`,
        eligibleAt: Date.now(),
      });
      const first = await enqueue(local, 'first local');
      const second = await enqueue(peer, 'peer');
      const third = await enqueue(local, 'later local');
      const batch = queue.selectBatch({ continuationConsumed: false })!;
      expect(batch.events.map((event) => event.type === 'report' ? event.reportId : undefined))
        .toEqual([first, second, third]);
      expect(await local.commitBatch(batch)).toBe(true);
    } finally {
      local.close();
      peer.close();
    }
  });

  it.each(['focus', 'tty', 'question', 'hold'] as const)(
    'rechecks %s after waiting for the profile lock',
    async (change) => {
      context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-reselect-'));
      await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
      await writeResumeStore('reselect-a', 1, undefined, DEFAULT_ISSUE_URL);
      await writeResumeStore('reselect-b', 1, undefined, DEFAULT_ISSUE_URL);
      const queue = createOperatorDispatchQueue();
      const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: queue });
      const lockPath = join(process.env.ENSEMBLE_USER_ROOT!, 'operator-agents',
        'default', 'watch', 'watch-state-lock.sqlite');
      let lock: DatabaseSync | undefined;
      try {
        await pool.enqueueIdleCandidate!({
          conductorAgentId: 'reselect-a',
          text: 'A',
          kind: 'idle_phase',
          fingerprint: 'reselect:a',
          eligibleAt: Date.now(),
        });
        await pool.enqueueIdleCandidate!({
          conductorAgentId: 'reselect-b',
          text: 'B',
          kind: 'idle_phase',
          fingerprint: 'reselect:b',
          eligibleAt: Date.now(),
        });
        const state = { continuationConsumed: false };
        if (change === 'focus') queue.setFocus('reselect-a');
        const batch = queue.selectBatch(state)!;
        expect(batch.sourceKey).toBe('session:reselect-a');
        lock = new DatabaseSync(lockPath);
        lock.exec('BEGIN IMMEDIATE');
        const pendingCommit = pool.commitBatch(batch, state);
        await new Promise((resolve) => setTimeout(resolve, 60));
        if (change === 'focus') {
          queue.enqueueReport({
            type: 'report', reportType: 'session_state', reportId: 'late-a',
            conductorAgentId: 'reselect-a', issueUrl: DEFAULT_ISSUE_URL, text: 'late A',
          }, 60_000);
          queue.setFocus('reselect-b');
        }
        if (change === 'tty') queue.enqueueUser('operator input');
        if (change === 'question') {
          queue.enqueueReport({
            type: 'report', reportType: 'open_question', reportId: 'new-question',
            conductorAgentId: 'reselect-b', issueUrl: DEFAULT_ISSUE_URL, text: 'Question',
          }, 0);
        }
        if (change === 'hold') queue.setHold(true);
        lock.exec('ROLLBACK');
        lock.close();
        lock = undefined;
        expect(await pendingCommit).toBe(false);
        expect(batch.batchId).toBeUndefined();
        const next = queue.selectBatch(state);
        if (change === 'hold') expect(next).toBeUndefined();
        else expect(next?.sourceKey).toBe(change === 'tty' ? 'user' : 'session:reselect-b');
        if (change === 'focus') {
          queue.setFocus('reselect-a');
          expect(queue.selectBatch(state)?.events).toHaveLength(2);
        }
      } finally {
        if (lock) { lock.exec('ROLLBACK'); lock.close(); }
        pool.close();
      }
    },
  );

  it('rolls back the entire local batch when a member cannot be frozen', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-freeze-failure-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const sessionId = 'freeze-failure-session';
    await writeResumeStore(sessionId, 1, undefined, DEFAULT_ISSUE_URL);
    const queue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: queue });
    try {
      const firstId = await pool.enqueueIdleCandidate!({
        conductorAgentId: sessionId,
        text: 'durable first report',
        kind: 'idle_phase',
        fingerprint: 'freeze-failure:first',
        eligibleAt: Date.now(),
      });
      const batch = queue.selectBatch({ continuationConsumed: false })!;
      queue.enqueueReport({
        type: 'report',
        reportType: 'open_question',
        reportId: 'missing-durable-report',
        conductorAgentId: sessionId,
        issueUrl: DEFAULT_ISSUE_URL,
        text: 'not yet durable',
      }, 0);
      await expect(pool.commitBatch(batch)).rejects.toThrow(
        'Pending report missing-durable-report disappeared',
      );
      expect(batch.batchId).toBeUndefined();
      expect(queue.pendingEventCount).toBe(2);
      const disk = JSON.parse(await readFile(currentWatchStatePath(context.repoRoot), 'utf8'));
      expect(disk.pendingReports[0].frozenBatchId).toBeUndefined();
      queue.discardQueuedReports!(['missing-durable-report']);
      const retry = queue.selectBatch({ continuationConsumed: false })!;
      expect(retry.events.map((event) =>
        event.type === 'report' ? event.reportId : undefined,
      )).toEqual([firstId]);
      expect(await pool.commitBatch(retry)).toBe(true);
    } finally {
      pool.close();
    }
  });

  it('restores the local batch if replacing the durable state fails', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-rename-failure-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const sessionId = 'rename-failure';
    await writeResumeStore(sessionId, 1, undefined, DEFAULT_ISSUE_URL);
    const queue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: queue });
    try {
      const reportId = await pool.enqueueIdleCandidate!({
        conductorAgentId: sessionId,
        text: 'persisted report',
        kind: 'idle_phase',
        fingerprint: 'restore-failure',
        eligibleAt: Date.now(),
      });
      const batch = queue.selectBatch({ continuationConsumed: false })!;
      const statePath = currentWatchStatePath(context.repoRoot);
      const backup = `${statePath}.test-backup`;
      const commit = queue.commitBatch.bind(queue);
      queue.commitBatch = (selected, finalize) => commit(selected, () => {
        renameSync(statePath, backup);
        mkdirSync(statePath);
        try {
          finalize?.();
        } finally {
          rmdirSync(statePath);
          renameSync(backup, statePath);
        }
      });
      await expect(pool.commitBatch(batch)).rejects.toThrow();
      expect(batch.batchId).toBeUndefined();
      expect(queue.pendingEventCount).toBe(1);
      const disk = JSON.parse(await readFile(statePath, 'utf8'));
      expect(disk.pendingReports[0]).toMatchObject({ reportId });
      expect(disk.pendingReports[0].frozenBatchId).toBeUndefined();
    } finally {
      pool.close();
    }
  });

  it('replays the frozen manifest after an uncertain lock release', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-release-failure-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const sessionId = 'release-failure';
    await writeResumeStore(sessionId, 1, undefined, DEFAULT_ISSUE_URL);
    const queue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: queue });
    let batchId: string | undefined;
    let payload: string | undefined;
    let reportId: string;
    try {
      reportId = await pool.enqueueIdleCandidate!({
        conductorAgentId: sessionId,
        text: 'frozen before release',
        kind: 'idle_phase',
        fingerprint: 'uncertain-release',
        eligibleAt: Date.now(),
      });
      const batch = queue.selectBatch({ continuationConsumed: false })!;
      const exec = DatabaseSync.prototype.exec;
      const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (sql) {
        if (sql === 'COMMIT') throw new Error('injected lock release failure');
        return exec.call(this, sql);
      });
      try {
        await expect(pool.commitBatch(batch)).rejects.toThrow('injected lock release failure');
      } finally {
        fault.mockRestore();
      }
      batchId = batch.batchId;
      payload = batch.payload;
      expect(batchId).toBeDefined();
      expect(queue.pendingEventCount).toBe(0);
    } finally {
      pool.close();
    }
    const replayQueue = createOperatorDispatchQueue();
    const replayPool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: replayQueue });
    try {
      const replay = replayQueue.selectBatch({ continuationConsumed: false })!;
      expect(replay.events.map((event) => event.type === 'report' ? event.reportId : undefined))
        .toEqual([reportId!]);
      expect(replay.batchId).toBe(batchId);
      expect(replay.payload).toBe(payload);
    } finally {
      replayPool.close();
    }
  });

  it('ignores a legacy queuedAt when initializing a missing firstQueuedAt', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-legacy-queued-at-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const sessionId = 'legacy-queued-at-session';
    const issueUrl = DEFAULT_ISSUE_URL;
    await writeResumeStore(sessionId, 1, undefined, issueUrl);
    const statePath = currentWatchStatePath(context.repoRoot);
    await mkdir(dirname(statePath), { recursive: true });
    const queuedAt = Date.now() - 60 * 60_000;
    const readyAt = Date.now() + 10_000;
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        watches: {},
        cursors: {},
        pendingReports: [
          {
            reportId: 'legacy-report',
            reportType: 'session_state',
            conductorAgentId: sessionId,
            issueUrl,
            text: 'legacy pending report',
            debounceMs: 10_000,
            queuedAt,
            readyAt,
          },
        ],
      }),
    );

    const queue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
      dispatchQueue: queue,
    });
    try {
      expect(queue.selectBatch({ continuationConsumed: false })).toBeUndefined();
      expect(queue.nextReadyAt()).toBe(readyAt);
      expect(
        queue.selectBatch({ continuationConsumed: false }, readyAt - 1),
      ).toBeUndefined();
      expect(
        queue.selectBatch({ continuationConsumed: false }, readyAt)?.events[0],
      ).toMatchObject({
        reportId: 'legacy-report',
        firstQueuedAt: readyAt,
      });
      const laterReportId = (await pool.enqueueIdleCandidate!({
        conductorAgentId: sessionId,
        text: '後から queue した確認候補',
        kind: 'idle_phase',
        fingerprint: 'idle-later',
        eligibleAt: Date.now(),
      }))!;
      expect(
        queue
          .selectBatch({ continuationConsumed: false }, readyAt)
          ?.events.map((event) =>
            event.type === 'report' ? event.reportId : undefined,
          ),
      ).toEqual(['legacy-report', laterReportId]);
    } finally {
      pool.close();
    }
  });

  it('serializes concurrent process polls and preserves each cursor and pending report', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-concurrent-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
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
      context.closeServers.push(() => server.close());
      await writeResumeStore(
        session.id,
        1,
        server.socketPath,
        session.issueUrl,
      );
    }

    const initialQueue = createOperatorDispatchQueue();
    const initialPool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
      dispatchQueue: initialQueue,
    });
    const resumedPools: Array<Awaited<ReturnType<typeof createOperatorWatchPool>>> = [];
    const statePath = currentWatchStatePath(context.repoRoot);
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

      const userEnsembleRoot = join(context.homeRoot, '.ensemble');
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
        repoRoot: context.repoRoot,
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
        repoRoot: context.repoRoot,
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-stale-lock-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
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
    context.closeServers.push(() => ownerServer.close());
    const contenderServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => observations.get(sessions[1]!.id)!,
    });
    context.closeServers.push(() => contenderServer.close());
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
      repoRoot: context.repoRoot,
      dispatchQueue: initialQueue,
    });
    const processes: ReturnType<typeof startWatchPollProcess>[] = [];
    const statePath = currentWatchStatePath(context.repoRoot);
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

      const userEnsembleRoot = join(context.homeRoot, '.ensemble');
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
          /^failed:Could not acquire operator (?:workspace|watch state profile) lock/u,
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
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-invalid-'));
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
    const statePath = currentWatchStatePath(context.repoRoot);
    await mkdir(dirname(statePath), { recursive: true });

    for (const invalidState of invalidStates) {
      await writeFile(statePath, JSON.stringify(invalidState));
      await expect(
        createOperatorWatchPool({
          repoRoot: context.repoRoot,
          dispatchQueue: createOperatorDispatchQueue(),
        }),
      ).rejects.toThrow('Invalid operator-agent watch state');
    }
  });
});
