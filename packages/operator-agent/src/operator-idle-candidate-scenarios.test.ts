import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OPERATOR_AGENT_SCHEDULING,
} from './operator-agent-config.js';
import {
  createOperatorDispatchQueue,
  type OperatorDispatchBatch,
  type OperatorDispatchEvent,
  type OperatorDispatchQueue,
  type OperatorDispatchState,
} from './operator-dispatch.js';
import { evaluateOperatorIdleCandidate } from './operator-idle-candidates.js';
import type { OperatorIdleCandidateObservation } from './operator-watch-pool.js';

const issueUrl = 'https://github.com/example/repo/issues/745';
const startAt = Date.parse('2026-11-17T00:00:00.000Z');
const scheduling = {
  ...DEFAULT_OPERATOR_AGENT_SCHEDULING,
};

interface SyntheticSend {
  at: number;
  batchId?: string;
  sourceKey: string;
  reportIds: string[];
  reportTypes: string[];
  succeeded: boolean;
}

interface SyntheticMetrics {
  dispatchAttempts: number;
  reportBatches: number;
  fakeSendTurns: number;
  importantNotificationWaitMs: number;
}

function createScenarioHarness(
  setNow: (at: number) => void,
  scenarioScheduling = scheduling,
) {
  setNow(startAt);
  let queue: OperatorDispatchQueue =
    createOperatorDispatchQueue(scenarioScheduling);
  const state: OperatorDispatchState = { continuationConsumed: false };
  const sends: SyntheticSend[] = [];
  const reportBatchIds = new Set<string>();
  let dispatchAttempts = 0;

  const agentSend = vi.fn(
    async (batch: OperatorDispatchBatch, at: number, succeeded: boolean) => {
      const reports = batch.events.filter(
        (event): event is Extract<OperatorDispatchEvent, { type: 'report' }> =>
          event.type === 'report',
      );
      if (batch.batchId) reportBatchIds.add(batch.batchId);
      sends.push({
        at,
        batchId: batch.batchId,
        sourceKey: batch.sourceKey,
        reportIds: reports.flatMap((event) =>
          event.reportId ? [event.reportId] : [],
        ),
        reportTypes: reports.map((event) => event.reportType),
        succeeded,
      });
    },
  );

  async function dispatchSelected(
    batch: OperatorDispatchBatch,
    at: number,
    succeeded = true,
  ): Promise<OperatorDispatchBatch> {
    setNow(at);
    if (!queue.commitBatch(batch)) {
      throw new Error(`could not commit selected batch ${batch.sourceKey}`);
    }
    dispatchAttempts += 1;
    await agentSend(batch, at, succeeded);
    state.lastDispatchedSourceKey = batch.sourceKey;
    state.continuationConsumed = false;
    return batch;
  }

  async function dispatchAt(
    at: number,
    succeeded = true,
  ): Promise<OperatorDispatchBatch | undefined> {
    setNow(at);
    const batch = queue.selectBatch(state, at);
    if (!batch) return undefined;
    return dispatchSelected(batch, at, succeeded);
  }

  function metrics(
    importantReportId: string,
    importantArrivalAt: number,
  ): SyntheticMetrics {
    const successfulSend = sends.find(
      (send) => send.succeeded && send.reportIds.includes(importantReportId),
    );
    if (!successfulSend) {
      throw new Error(`important report ${importantReportId} was not sent`);
    }
    return {
      dispatchAttempts,
      reportBatches: reportBatchIds.size,
      fakeSendTurns: agentSend.mock.calls.length,
      importantNotificationWaitMs: successfulSend.at - importantArrivalAt,
    };
  }

  function restartWithFrozenReports(
    reports: readonly Extract<
      OperatorDispatchEvent,
      { type: 'report' }
    >[],
    retryReadyAt: number,
  ): void {
    queue = createOperatorDispatchQueue(scheduling);
    queue.reconcileReports?.(
      reports.map((event) => ({
        event: { ...event, retryReadyAt },
        readyAt: retryReadyAt,
      })),
    );
  }

  return {
    get queue() {
      return queue;
    },
    sends,
    agentSend,
    dispatchAt,
    dispatchSelected,
    metrics,
    restartWithFrozenReports,
  };
}

function enqueueReport(
  queue: OperatorDispatchQueue,
  input: {
    reportId: string;
    reportType: Extract<OperatorDispatchEvent, { type: 'report' }>['reportType'];
    sessionId: string;
    priority?: 'open_question' | 'normal' | 'idle';
  },
): void {
  queue.enqueueReport(
    {
      type: 'report',
      reportId: input.reportId,
      reportType: input.reportType,
      conductorAgentId: input.sessionId,
      issueUrl,
      text: input.reportId,
      ...(input.priority ? { priority: input.priority } : {}),
    },
    0,
  );
}

function enqueueIdleCandidate(
  queue: OperatorDispatchQueue,
  reportId: string,
  sessionId: string,
): void {
  enqueueReport(queue, {
    reportId,
    reportType: 'idle_candidate',
    sessionId,
    priority: 'idle',
  });
}

function makeObservation(
  overrides: Partial<OperatorIdleCandidateObservation> = {},
): OperatorIdleCandidateObservation {
  return {
    conductorAgentId: 'long-running-session',
    issueUrl,
    observationVersion: 1,
    source: 'uds',
    connectivity: 'reachable',
    checkedAt: startAt,
    pollIntervalMs: 60_000,
    harnessPhase: 'running',
    harnessModifiedAt: startAt - 50 * 60_000,
    lifecycle: 'unknown',
    openQuestionCount: 0,
    ...overrides,
  };
}

function useFakeClock() {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(startAt);
  return {
    set(at: number) {
      clock.mockReturnValue(at);
    },
    restore() {
      clock.mockRestore();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('synthetic idle-candidate dispatch comparisons', () => {
  it('compares multiple sessions and same-session hitchhiking', async () => {
    const clock = useFakeClock();
    try {
      const run = async (integrated: boolean) => {
        const harness = createScenarioHarness(clock.set);
        enqueueReport(harness.queue, {
          reportId: 'normal-session-b',
          reportType: 'session_state',
          sessionId: 'session-b',
        });
        if (integrated) {
          enqueueIdleCandidate(harness.queue, 'idle-session-b', 'session-b');
        }
        enqueueReport(harness.queue, {
          reportId: 'oq-session-a',
          reportType: 'open_question',
          sessionId: 'session-a',
        });

        await harness.dispatchAt(startAt);
        await harness.dispatchAt(startAt);
        const metrics = harness.metrics('oq-session-a', startAt);
        const sessionB = harness.sends.find((send) =>
          send.reportIds.includes('normal-session-b'),
        );
        return { metrics, sessionB };
      };

      const baseline = await run(false);
      const integrated = await run(true);
      expect(baseline.metrics).toEqual({
        dispatchAttempts: 2,
        reportBatches: 2,
        fakeSendTurns: 2,
        importantNotificationWaitMs: 0,
      });
      expect(integrated.metrics).toEqual(baseline.metrics);
      expect(integrated.sessionB?.reportIds).toEqual([
        'normal-session-b',
        'idle-session-b',
      ]);
    } finally {
      clock.restore();
    }
  });

  it('adds no dispatch when a long-running session still has fresh status evidence', async () => {
    const clock = useFakeClock();
    try {
      const candidate = evaluateOperatorIdleCandidate(
        makeObservation({
          statusLine: {
            text: '正常な長時間処理中',
            reportedAt: startAt - 5 * 60_000,
          },
        }),
        scheduling,
        startAt,
      );
      expect(candidate).toBeUndefined();

      const run = async () => {
        const harness = createScenarioHarness(clock.set);
        enqueueReport(harness.queue, {
          reportId: 'oq-during-long-work',
          reportType: 'open_question',
          sessionId: 'important-session',
        });
        if (candidate) {
          enqueueIdleCandidate(
            harness.queue,
            'unexpected-long-work-candidate',
            candidate.conductorAgentId,
          );
        }
        await harness.dispatchAt(startAt);
        return harness.metrics('oq-during-long-work', startAt);
      };

      const baseline = await run();
      const integrated = await run();
      expect(baseline).toEqual({
        dispatchAttempts: 1,
        reportBatches: 1,
        fakeSendTurns: 1,
        importantNotificationWaitMs: 0,
      });
      expect(integrated).toEqual(baseline);
    } finally {
      clock.restore();
    }
  });

  it('keeps the Open Question wait unchanged across an observable user-input gate', async () => {
    const clock = useFakeClock();
    try {
      const run = async (integrated: boolean) => {
        const harness = createScenarioHarness(clock.set);
        harness.queue.enqueueUser('operator input');
        enqueueReport(harness.queue, {
          reportId: 'oq-after-user-input',
          reportType: 'open_question',
          sessionId: 'waiting-session',
        });
        await harness.dispatchAt(startAt);

        const userInputClearedAt = startAt + 1_000;
        if (integrated) {
          enqueueIdleCandidate(
            harness.queue,
            'idle-after-user-input',
            'waiting-session',
          );
        }
        await harness.dispatchAt(userInputClearedAt);
        const mixed = harness.sends.find((send) =>
          send.reportIds.includes('oq-after-user-input'),
        );
        return {
          metrics: harness.metrics('oq-after-user-input', startAt),
          mixed,
        };
      };

      const baseline = await run(false);
      const integrated = await run(true);
      expect(baseline.metrics).toEqual({
        dispatchAttempts: 2,
        reportBatches: 1,
        fakeSendTurns: 2,
        importantNotificationWaitMs: 1_000,
      });
      expect(integrated.metrics).toEqual(baseline.metrics);
      expect(integrated.mixed?.reportIds).toEqual([
        'oq-after-user-input',
        'idle-after-user-input',
      ]);
    } finally {
      clock.restore();
    }
  });

  it('keeps OQ wait unchanged through focus switching and admits only after focus clears', async () => {
    const clock = useFakeClock();
    try {
      const run = async (integrated: boolean) => {
        const harness = createScenarioHarness(clock.set);
        harness.queue.setFocus('focus-session', startAt);
        enqueueReport(harness.queue, {
          reportId: 'focus-session-report',
          reportType: 'session_state',
          sessionId: 'focus-session',
        });
        enqueueReport(harness.queue, {
          reportId: 'oq-focused-after-switch',
          reportType: 'open_question',
          sessionId: 'question-session',
        });
        expect(harness.queue.focusSessionId).toBe('focus-session');
        expect(harness.queue.pendingEventCount).toBe(2);
        const selected = harness.queue.selectBatch(
          { continuationConsumed: false },
          startAt,
        );
        expect(selected).toBeDefined();
        const first = await harness.dispatchSelected(selected!, startAt);
        expect(first?.sourceKey).toBe('session:focus-session');

        harness.queue.setFocus('question-session', startAt + 1_000);
        if (integrated) {
          // A focus switch is still a closed generation gate.
          expect(harness.sends.some((send) =>
            send.reportIds.includes('idle-after-focus'),
          )).toBe(false);
        }
        harness.queue.setFocus(undefined, startAt + 2_000);
        if (integrated) {
          enqueueIdleCandidate(
            harness.queue,
            'idle-after-focus',
            'question-session',
          );
        }
        const second = await harness.dispatchAt(startAt + 2_000);
        return {
          metrics: harness.metrics('oq-focused-after-switch', startAt),
          mixed: harness.sends.find((send) =>
            send.reportIds.includes('oq-focused-after-switch'),
          ),
          dispatchedSources: [first?.sourceKey, second?.sourceKey],
        };
      };

      const baseline = await run(false);
      const integrated = await run(true);
      expect(baseline.metrics).toEqual({
        dispatchAttempts: 2,
        reportBatches: 2,
        fakeSendTurns: 2,
        importantNotificationWaitMs: 2_000,
      });
      expect(integrated.dispatchedSources).toEqual([
        'session:focus-session',
        'session:question-session',
      ]);
      expect(integrated.metrics).toEqual(baseline.metrics);
      expect(integrated.mixed?.reportIds).toEqual([
        'oq-focused-after-switch',
        'idle-after-focus',
      ]);
    } finally {
      clock.restore();
    }
  });

  it('shows that manual hold delays important reports equally and adds no candidate turn', async () => {
    const clock = useFakeClock();
    try {
      const releaseAt = startAt + 5 * 60_000;
      const run = async (integrated: boolean) => {
        const harness = createScenarioHarness(clock.set);
        harness.queue.setHold(true);
        enqueueReport(harness.queue, {
          reportId: 'oq-during-manual-hold',
          reportType: 'open_question',
          sessionId: 'held-session',
        });
        if (integrated) {
          enqueueIdleCandidate(
            harness.queue,
            'idle-during-manual-hold',
            'held-session',
          );
        }
        clock.set(releaseAt);
        harness.queue.setHold(false);
        const mixed = await harness.dispatchAt(releaseAt);
        return {
          metrics: harness.metrics('oq-during-manual-hold', startAt),
          mixed,
        };
      };

      const baseline = await run(false);
      const integrated = await run(true);
      expect(baseline.metrics).toEqual({
        dispatchAttempts: 1,
        reportBatches: 1,
        fakeSendTurns: 1,
        importantNotificationWaitMs: 5 * 60_000,
      });
      expect(integrated.metrics).toEqual(baseline.metrics);
      expect(integrated.mixed?.priority).toBe('open_question');
      expect(integrated.mixed?.events).toHaveLength(2);
    } finally {
      clock.restore();
    }
  });

  it('replays a frozen OQ batch through retry, restart, and ack retry without an extra turn', async () => {
    const clock = useFakeClock();
    try {
      const run = async (integrated: boolean) => {
        const harness = createScenarioHarness(clock.set);
        enqueueReport(harness.queue, {
          reportId: 'oq-across-restart',
          reportType: 'open_question',
          sessionId: 'retry-session',
        });
        if (integrated) {
          enqueueIdleCandidate(
            harness.queue,
            'idle-across-restart',
            'retry-session',
          );
        }

        const firstAttempt = await harness.dispatchAt(startAt, false);
        expect(firstAttempt).toBeDefined();
        const frozenId = firstAttempt!.batchId;
        const frozenPayload = firstAttempt!.payload;
        const retryReadyAt = startAt + 5_000;
        for (const event of firstAttempt!.events) {
          if (event.type === 'report') {
            harness.queue.requeue(event, retryReadyAt - startAt);
          }
        }
        harness.restartWithFrozenReports(
          firstAttempt!.events.filter(
            (event): event is Extract<
              OperatorDispatchEvent,
              { type: 'report' }
            > => event.type === 'report',
          ),
          retryReadyAt,
        );

        expect(await harness.dispatchAt(retryReadyAt - 1)).toBeUndefined();
        const replay = await harness.dispatchAt(retryReadyAt);
        expect(replay?.batchId).toBe(frozenId);
        expect(replay?.payload).toBe(frozenPayload);

        let ackAttempts = 0;
        const acknowledge = vi.fn(async () => ++ackAttempts > 1);
        expect(await acknowledge()).toBe(false);
        expect(await acknowledge()).toBe(true);
        expect(acknowledge).toHaveBeenCalledTimes(2);

        return {
          metrics: harness.metrics('oq-across-restart', startAt),
          replay,
          sends: harness.sends,
        };
      };

      const baseline = await run(false);
      const integrated = await run(true);
      expect(baseline.metrics).toEqual({
        dispatchAttempts: 2,
        reportBatches: 1,
        fakeSendTurns: 2,
        importantNotificationWaitMs: 5_000,
      });
      expect(integrated.metrics).toEqual(baseline.metrics);
      expect(integrated.sends[0]?.reportIds).toContain('oq-across-restart');
      expect(integrated.sends[1]?.reportIds).toContain('oq-across-restart');
      expect(integrated.sends[1]?.reportIds).toContain('idle-across-restart');
      expect(integrated.sends[1]?.batchId).toBe(integrated.sends[0]?.batchId);
    } finally {
      clock.restore();
    }
  });

  it('compares local append at commit with an unsynchronized peer report left for the next batch', async () => {
    const clock = useFakeClock();
    try {
      const run = async (integrated: boolean) => {
        const harness = createScenarioHarness(clock.set);
        if (integrated) {
          enqueueIdleCandidate(
            harness.queue,
            'idle-before-commit',
            'commit-session',
          );
        }
        enqueueReport(harness.queue, {
          reportId: 'local-session-report',
          reportType: 'session_state',
          sessionId: 'commit-session',
        });

        const selected = harness.queue.selectBatch(
          { continuationConsumed: false },
          startAt,
        )!;
        clock.set(startAt + 50);
        enqueueReport(harness.queue, {
          reportId: 'local-oq-before-commit',
          reportType: 'open_question',
          sessionId: 'commit-session',
        });
        const first = await harness.dispatchSelected(selected, startAt + 100);

        // The peer report is durable elsewhere but has not been synchronized
        // into this process-local queue at the successful commit boundary.
        clock.set(startAt + 200);
        enqueueReport(harness.queue, {
          reportId: 'peer-unsynchronized',
          reportType: 'session_state',
          sessionId: 'commit-session',
        });
        const peer = await harness.dispatchAt(startAt + 200);
        return {
          metrics: harness.metrics(
            'local-oq-before-commit',
            startAt + 50,
          ),
          first,
          peer,
          sends: harness.sends,
        };
      };

      const baseline = await run(false);
      const integrated = await run(true);
      expect(baseline.metrics).toEqual({
        dispatchAttempts: 2,
        reportBatches: 2,
        fakeSendTurns: 2,
        importantNotificationWaitMs: 50,
      });
      expect(integrated.metrics).toEqual(baseline.metrics);
      expect(baseline.first.priority).toBe('open_question');
      expect(integrated.first.priority).toBe('open_question');
      expect(
        integrated.first.events.filter(
          (event) =>
            event.type === 'report' &&
            event.reportType === 'open_question',
        ),
      ).toHaveLength(1);
      expect(integrated.first.events.map((event) =>
        event.type === 'report' ? event.reportId : undefined,
      )).toEqual([
        'idle-before-commit',
        'local-session-report',
        'local-oq-before-commit',
      ]);
      expect(integrated.sends[0]?.reportIds).not.toContain(
        'peer-unsynchronized',
      );
      expect(integrated.peer?.events.map((event) =>
        event.type === 'report' ? event.reportId : undefined,
      )).toEqual(['peer-unsynchronized']);
    } finally {
      clock.restore();
    }
  });

  it('measures the extra turn for a separate stale-running candidate without delaying the OQ', async () => {
    const clock = useFakeClock();
    try {
      const stale = evaluateOperatorIdleCandidate(
        makeObservation({
          statusLine: {
            text: '最終更新から長時間経過',
            reportedAt: startAt - scheduling.staleRunningThresholdMs,
          },
        }),
        scheduling,
        startAt,
      );
      expect(stale?.kind).toBe('stale_running');

      const run = async (integrated: boolean) => {
        const harness = createScenarioHarness(clock.set);
        if (integrated && stale) {
          enqueueIdleCandidate(
            harness.queue,
            'stale-running-candidate',
            stale.conductorAgentId,
          );
        }
        enqueueReport(harness.queue, {
          reportId: 'oq-before-stale-candidate',
          reportType: 'open_question',
          sessionId: 'important-session',
        });
        await harness.dispatchAt(startAt);
        if (integrated) await harness.dispatchAt(startAt);
        return {
          metrics: harness.metrics('oq-before-stale-candidate', startAt),
          candidateSend: harness.sends.find((send) =>
            send.reportIds.includes('stale-running-candidate'),
          ),
        };
      };

      const baseline = await run(false);
      const integrated = await run(true);
      expect(baseline.metrics).toEqual({
        dispatchAttempts: 1,
        reportBatches: 1,
        fakeSendTurns: 1,
        importantNotificationWaitMs: 0,
      });
      expect(integrated.metrics).toEqual({
        dispatchAttempts: 2,
        reportBatches: 2,
        fakeSendTurns: 2,
        importantNotificationWaitMs: 0,
      });
      expect(integrated.candidateSend?.reportIds).toEqual([
        'stale-running-candidate',
      ]);
    } finally {
      clock.restore();
    }
  });

  it('promotes aged idle in FIFO order during continuing normal arrivals without delaying an OQ', async () => {
    const clock = useFakeClock();
    const comparisonScheduling = {
      ...scheduling,
      batchMaxWaitMs: 0,
      idleAgingMs: 5 * 60_000,
    };
    try {
      const run = async (integrated: boolean) => {
        const harness = createScenarioHarness(
          clock.set,
          comparisonScheduling,
        );
        if (integrated) {
          enqueueIdleCandidate(
            harness.queue,
            'aged-idle-first',
            'idle-first-session',
          );
          enqueueIdleCandidate(
            harness.queue,
            'aged-idle-second',
            'idle-second-session',
          );
        }

        for (let minute = 1; minute < 5; minute += 1) {
          const at = startAt + minute * 60_000;
          enqueueReport(harness.queue, {
            reportId: `normal-${minute}`,
            reportType: 'session_state',
            sessionId: `normal-session-${minute}`,
          });
          await harness.dispatchAt(at);
        }

        const arrivalAt = startAt + 5 * 60_000;
        enqueueReport(harness.queue, {
          reportId: 'normal-five',
          reportType: 'session_state',
          sessionId: 'normal-session-five',
        });
        enqueueReport(harness.queue, {
          reportId: 'important-oq-after-aging',
          reportType: 'open_question',
          sessionId: 'important-session',
          priority: 'open_question',
        });
        while (await harness.dispatchAt(arrivalAt)) {
          // Drain each selected session batch at this fixed fake-clock time.
        }

        return {
          metrics: harness.metrics('important-oq-after-aging', arrivalAt),
          sends: harness.sends,
        };
      };

      const baseline = await run(false);
      const integrated = await run(true);
      expect(baseline.metrics).toEqual({
        dispatchAttempts: 6,
        reportBatches: 6,
        fakeSendTurns: 6,
        importantNotificationWaitMs: 0,
      });
      expect(integrated.metrics).toEqual({
        dispatchAttempts: 8,
        reportBatches: 8,
        fakeSendTurns: 8,
        importantNotificationWaitMs: 0,
      });
      expect(
        integrated.sends.slice(4).map((send) => send.reportIds[0]),
      ).toEqual([
        'important-oq-after-aging',
        'aged-idle-first',
        'aged-idle-second',
        'normal-five',
      ]);
    } finally {
      clock.restore();
    }
  });
});
