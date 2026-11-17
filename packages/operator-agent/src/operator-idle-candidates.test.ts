import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OPERATOR_AGENT_SCHEDULING } from './operator-agent-config.js';
import { createOperatorDispatchQueue } from './operator-dispatch.js';
import {
  createOperatorIdleCandidateMonitor,
  evaluateOperatorIdleCandidate,
} from './operator-idle-candidates.js';
import type { OperatorIdleCandidateObservation } from './operator-watch-pool.js';

const issueUrl = 'https://github.com/example/repo/issues/42';
const defaults = {
  ...DEFAULT_OPERATOR_AGENT_SCHEDULING,
};

function observation(
  overrides: Partial<OperatorIdleCandidateObservation> = {},
): OperatorIdleCandidateObservation {
  const now = Date.now();
  return {
    conductorAgentId: 'conductor-42',
    issueUrl,
    observationVersion: 1,
    source: 'uds',
    connectivity: 'reachable',
    checkedAt: now,
    pollIntervalMs: 2_000,
    harnessPhase: 'idle',
    harnessModifiedAt: now - defaults.idlePhaseThresholdMs - 1,
    lifecycle: 'unknown',
    openQuestionCount: 0,
    ...overrides,
  };
}

describe('operator idle candidate evaluation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the last harness state update time and allows a live Open Question alongside the candidate', () => {
    const now = 2_000_000;
    expect(
      evaluateOperatorIdleCandidate(
        observation({
          checkedAt: now,
          harnessModifiedAt:
            now - defaults.idlePhaseThresholdMs + 1,
          openQuestionCount: 1,
        }),
        defaults,
        now,
      ),
    ).toBeUndefined();
    const candidate = evaluateOperatorIdleCandidate(
      observation({
        checkedAt: now,
        harnessModifiedAt: now - defaults.idlePhaseThresholdMs,
        openQuestionCount: 1,
      }),
      defaults,
      now,
    );

    expect(candidate).toMatchObject({
      kind: 'idle_phase',
      conductorAgentId: 'conductor-42',
    });
    expect(candidate?.text).toContain('保存 phase: idle');
    expect(
      evaluateOperatorIdleCandidate(
        observation({
          checkedAt: now,
          harnessModifiedAt: now - defaults.idlePhaseThresholdMs,
          openQuestionCount: 1,
        }),
        defaults,
        now,
      )?.fingerprint,
    ).toBe(candidate?.fingerprint);
    expect(
      evaluateOperatorIdleCandidate(
        observation({
          checkedAt: now,
          harnessModifiedAt: now - defaults.idlePhaseThresholdMs - 1,
          openQuestionCount: 1,
        }),
        defaults,
        now,
      )?.fingerprint,
    ).not.toBe(candidate?.fingerprint);
  });

  it('does not flag long processing with a recent status line, but flags a stale last status report for operator review', () => {
    const now = 2_000_000;
    const harnessModifiedAt = now - 50 * 60_000;
    expect(
      evaluateOperatorIdleCandidate(
        observation({
          checkedAt: now,
          harnessPhase: 'running',
          harnessModifiedAt,
          statusLine: {
            text: '正常な長時間処理中',
            reportedAt: now - 5 * 60_000,
          },
        }),
        defaults,
        now,
      ),
    ).toBeUndefined();

    const staleReport = evaluateOperatorIdleCandidate(
      observation({
        checkedAt: now,
        harnessPhase: 'running',
        harnessModifiedAt: now - 5 * 60_000,
        statusLine: {
          text: '再開前の最後の報告',
          reportedAt: now - 120 * 60_000,
        },
      }),
      defaults,
      now,
    );
    expect(staleReport?.kind).toBe('stale_running');
  });

  it('offers a neutral stale-running check only with a current status-line timestamp', () => {
    const now = Date.parse('2026-11-17T00:00:00.000Z');
    const harnessModifiedAt = now - defaults.staleRunningThresholdMs;
    expect(
      evaluateOperatorIdleCandidate(
        observation({
          checkedAt: now,
          harnessPhase: 'running',
          harnessModifiedAt,
          statusLine: {
            text: 'CI の結果を確認中',
            reportedAt: now - defaults.staleRunningThresholdMs + 1,
          },
        }),
        defaults,
        now,
      ),
    ).toBeUndefined();
    const candidate = evaluateOperatorIdleCandidate(
      observation({
        checkedAt: now,
        harnessPhase: 'running',
        harnessModifiedAt,
        statusLine: {
          text: 'CI の結果を確認中',
          reportedAt: harnessModifiedAt,
        },
      }),
      defaults,
      now,
    );

    expect(candidate?.kind).toBe('stale_running');
    expect(candidate?.text).toContain('60 分以上・要確認');
    expect(candidate?.text).toContain('2026-11-16T23:00:00.000Z');
    expect(candidate?.text).toContain('worker の進捗 heartbeat は観測できていません');
    expect(candidate?.text).not.toContain('停止しました');
  });

  it.each([
    ['saved fallback', { source: 'resume_store' as const }],
    ['unreachable UDS', { connectivity: 'unreachable' as const }],
    ['unknown connectivity', { connectivity: 'unknown' as const }],
    ['terminal phase', { harnessPhase: 'close' as const }],
    ['missing harness update timestamp', { harnessModifiedAt: undefined }],
    ['future observation', { checkedAt: Date.now() + 60_000 }],
    ['stale observation', { checkedAt: Date.now() - 20_000 }],
    ['conflicting lifecycle', { lifecycle: 'closed' as const }],
  ])('treats %s evidence as unknown and skips it', (_name, overrides) => {
    const now = Date.now();
    expect(
      evaluateOperatorIdleCandidate(
        observation(overrides),
        defaults,
        now,
      ),
    ).toBeUndefined();
  });

  it('does not generate a candidate during operator conversation and refreshes once when it clears', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T00:00:00.000Z'));
    const dispatchQueue = createOperatorDispatchQueue();
    dispatchQueue.setConversationHold(true);
    let current = observation({
      checkedAt: Date.now(),
      observationVersion: 1,
      harnessModifiedAt: Date.now() - defaults.idlePhaseThresholdMs,
    });
    const enqueueIdleCandidate = vi.fn(async () => undefined);
    const refreshOnGateClear = vi.fn(async () => {
      current = {
        ...current,
        observationVersion: current.observationVersion + 1,
        checkedAt: Date.now(),
      };
    });
    const monitor = createOperatorIdleCandidateMonitor({
      watchPool: {
        list: () => [],
        pollOnce: async () => 0,
        listIdleCandidateObservations: () => [current],
        enqueueIdleCandidate,
      },
      dispatchQueue,
      scheduling: defaults,
      isAgentSendInFlight: () => false,
      refreshOnGateClear,
    });

    try {
      await vi.advanceTimersByTimeAsync(defaults.idleReevaluationIntervalMs);
      expect(enqueueIdleCandidate).not.toHaveBeenCalled();
      dispatchQueue.setConversationHold(false);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(refreshOnGateClear).toHaveBeenCalledTimes(1);
      expect(enqueueIdleCandidate).toHaveBeenCalledTimes(1);
      expect(enqueueIdleCandidate).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'idle_phase',
          shouldAdmit: expect.any(Function),
        }),
      );
    } finally {
      monitor.close();
    }
  });

  it('suppresses candidates across focus switches and refreshes after focus-off', async () => {
    vi.useFakeTimers();
    const dispatchQueue = createOperatorDispatchQueue();
    dispatchQueue.setFocus('session-a');
    let current = observation();
    const enqueueIdleCandidate = vi.fn(async () => undefined);
    const refreshOnGateClear = vi.fn(async () => {
      current = {
        ...current,
        observationVersion: current.observationVersion + 1,
        checkedAt: Date.now(),
      };
    });
    const monitor = createOperatorIdleCandidateMonitor({
      watchPool: {
        list: () => [],
        pollOnce: async () => 0,
        listIdleCandidateObservations: () => [current],
        enqueueIdleCandidate,
      },
      dispatchQueue,
      scheduling: defaults,
      isAgentSendInFlight: () => false,
      refreshOnGateClear,
    });
    try {
      await Promise.resolve();
      dispatchQueue.setFocus('session-b');
      await vi.advanceTimersByTimeAsync(defaults.idleReevaluationIntervalMs);
      expect(enqueueIdleCandidate).not.toHaveBeenCalled();
      dispatchQueue.setFocus(undefined);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(refreshOnGateClear).toHaveBeenCalledTimes(1);
      expect(enqueueIdleCandidate).toHaveBeenCalledTimes(1);
    } finally {
      monitor.close();
    }
  });

  it('does not reuse a pre-gate observation when refresh produces no new observation', async () => {
    const dispatchQueue = createOperatorDispatchQueue();
    dispatchQueue.setConversationHold(true);
    const enqueueIdleCandidate = vi.fn(async () => undefined);
    const monitor = createOperatorIdleCandidateMonitor({
      watchPool: {
        list: () => [],
        pollOnce: async () => 0,
        listIdleCandidateObservations: () => [observation()],
        enqueueIdleCandidate,
      },
      dispatchQueue,
      scheduling: defaults,
      isAgentSendInFlight: () => false,
      refreshOnGateClear: async () => {},
    });

    try {
      dispatchQueue.setConversationHold(false);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(enqueueIdleCandidate).not.toHaveBeenCalled();
    } finally {
      monitor.close();
    }
  });

  it('keeps submitted user input and an in-flight agent send behind the generation gate', async () => {
    const dispatchQueue = createOperatorDispatchQueue();
    expect(dispatchQueue.enqueueUser('Please check this session.')).toBe(true);
    let agentSendInFlight = false;
    let current = observation({ observationVersion: 1 });
    const enqueueIdleCandidate = vi.fn(async () => undefined);
    const refreshOnGateClear = vi.fn(async () => {
      current = {
        ...current,
        observationVersion: current.observationVersion + 1,
        checkedAt: Date.now(),
      };
    });
    const monitor = createOperatorIdleCandidateMonitor({
      watchPool: {
        list: () => [],
        pollOnce: async () => 0,
        listIdleCandidateObservations: () => [current],
        enqueueIdleCandidate,
      },
      dispatchQueue,
      scheduling: defaults,
      isAgentSendInFlight: () => agentSendInFlight,
      refreshOnGateClear,
    });

    try {
      await Promise.resolve();
      expect(enqueueIdleCandidate).not.toHaveBeenCalled();

      const userBatch = dispatchQueue.selectBatch({
        continuationConsumed: false,
      })!;
      expect(userBatch.sourceKey).toBe('user');
      expect(dispatchQueue.commitBatch(userBatch)).toBe(true);
      agentSendInFlight = true;
      monitor.notifyActivityChanged();
      await Promise.resolve();
      await Promise.resolve();
      expect(refreshOnGateClear).toHaveBeenCalledTimes(1);
      expect(enqueueIdleCandidate).not.toHaveBeenCalled();

      agentSendInFlight = false;
      monitor.notifyActivityChanged();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(refreshOnGateClear).toHaveBeenCalledTimes(2);
      expect(enqueueIdleCandidate).toHaveBeenCalledTimes(1);
    } finally {
      monitor.close();
    }
  });

  it('keeps multiple session candidates under shared focus and Open Question selection', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const dispatchQueue = createOperatorDispatchQueue(defaults);
    try {
      dispatchQueue.enqueueReports(
        [
          {
            type: 'report',
            reportType: 'idle_candidate',
            reportId: 'idle-a',
            conductorAgentId: 'session-a',
            issueUrl: 'https://github.com/example/repo/issues/1',
            text: 'idle session A',
            priority: 'idle',
            eligibleAt: 1_000,
          },
          {
            type: 'report',
            reportType: 'open_question',
            reportId: 'question-a',
            conductorAgentId: 'session-a',
            issueUrl: 'https://github.com/example/repo/issues/1',
            text: 'OQ for session A',
          },
          {
            type: 'report',
            reportType: 'idle_candidate',
            reportId: 'idle-b',
            conductorAgentId: 'session-b',
            issueUrl: 'https://github.com/example/repo/issues/2',
            text: 'idle session B',
            priority: 'idle',
            eligibleAt: 1_000,
          },
        ],
        0,
      );

      dispatchQueue.setFocus('session-b', 1_000);
      const focusedB = dispatchQueue.selectBatch(
        { continuationConsumed: false },
        1_000,
      )!;
      expect(focusedB.events.map((event) => event.reportId)).toEqual(['idle-b']);

      dispatchQueue.setFocus('session-a', 1_000);
      const switchedToA = dispatchQueue.selectBatch(
        { continuationConsumed: false },
        1_000,
      )!;
      expect(switchedToA.priority).toBe('open_question');
      expect(switchedToA.events.map((event) => event.reportId)).toEqual([
        'idle-a',
        'question-a',
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it('lets an idle candidate hitchhike in a normal-priority mixed batch', () => {
    const dispatchQueue = createOperatorDispatchQueue();
    dispatchQueue.enqueueReports(
      [
        {
          type: 'report',
          reportType: 'idle_candidate',
          reportId: 'idle-hitchhiker',
          conductorAgentId: 'mixed-session',
          issueUrl,
          text: 'idle candidate',
          priority: 'idle',
          eligibleAt: Date.now(),
        },
        {
          type: 'report',
          reportType: 'session_state',
          reportId: 'normal-member',
          conductorAgentId: 'mixed-session',
          issueUrl,
          text: 'normal report',
          priority: 'normal',
        },
      ],
      0,
    );

    const batch = dispatchQueue.selectBatch({
      continuationConsumed: false,
    })!;
    expect(batch.priority).toBe('normal');
    expect(batch.events.map((event) =>
      event.type === 'report' ? event.reportId : undefined,
    )).toEqual(['idle-hitchhiker', 'normal-member']);
  });

  it('continues candidate admission while a manual report hold is active', async () => {
    const dispatchQueue = createOperatorDispatchQueue();
    dispatchQueue.setHold(true);
    const current = observation();
    const enqueueIdleCandidate = vi.fn(async () => undefined);
    const monitor = createOperatorIdleCandidateMonitor({
      watchPool: {
        list: () => [],
        pollOnce: async () => 0,
        listIdleCandidateObservations: () => [current],
        enqueueIdleCandidate,
      },
      dispatchQueue,
      scheduling: defaults,
      isAgentSendInFlight: () => false,
    });

    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(enqueueIdleCandidate).toHaveBeenCalledTimes(1);
    } finally {
      monitor.close();
    }
  });

  it('keeps continuation ahead of aged idle, then preserves FIFO within the normal band', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const dispatchQueue = createOperatorDispatchQueue({
      ...defaults,
      idleAgingMs: 5_000,
    });
    try {
      dispatchQueue.enqueueReport(
        {
          type: 'report',
          reportType: 'idle_candidate',
          reportId: 'aged-idle',
          conductorAgentId: 'idle-session',
          issueUrl,
          text: 'aged idle candidate',
          priority: 'idle',
          eligibleAt: 0,
        },
        0,
      );
      now.mockReturnValue(1_000);
      dispatchQueue.enqueueReport(
        {
          type: 'report',
          reportType: 'session_state',
          reportId: 'continuation',
          conductorAgentId: 'recent-session',
          issueUrl,
          text: 'continuation report',
        },
        0,
      );
      now.mockReturnValue(2_000);
      dispatchQueue.enqueueReport(
        {
          type: 'report',
          reportType: 'session_state',
          reportId: 'normal-fifo',
          conductorAgentId: 'later-session',
          issueUrl,
          text: 'later normal report',
        },
        0,
      );

      const continuation = dispatchQueue.selectBatch(
        {
          lastDispatchedSourceKey: 'session:recent-session',
          continuationConsumed: false,
        },
        6_000,
      )!;
      expect(continuation.sourceKey).toBe('session:recent-session');
      expect(continuation.usedContinuation).toBe(true);

      const agedIdle = dispatchQueue.selectBatch(
        {
          lastDispatchedSourceKey: continuation.sourceKey,
          continuationConsumed: true,
        },
        6_000,
      )!;
      expect(agedIdle.events.map((event) =>
        event.type === 'report' ? event.reportId : undefined,
      )).toEqual(['aged-idle']);
      expect(agedIdle.priority).toBe('normal');
    } finally {
      now.mockRestore();
    }
  });

  it('adds no selected batch or Open Question wait when an idle candidate is already queued at selection time', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const makeQuestion = () => ({
      type: 'report' as const,
      reportType: 'open_question' as const,
      reportId: 'question',
      conductorAgentId: 'conductor-42',
      issueUrl,
      text: 'operator decision needed',
    });
    try {
      const baselineQueue = createOperatorDispatchQueue(defaults);
      baselineQueue.enqueueReport(makeQuestion(), 0);
      const baselineBatch = baselineQueue.selectBatch(
        { continuationConsumed: false },
        30_000,
      )!;
      const baselineQuestion = baselineBatch.events.find(
        (event) => event.type === 'report' && event.reportId === 'question',
      );
      if (!baselineQuestion || baselineQuestion.type !== 'report') {
        throw new Error('baseline Open Question was not selected');
      }
      const baselineOpenQuestionWaitMs =
        30_000 - baselineQuestion.firstQueuedAt!;

      const integratedQueue = createOperatorDispatchQueue(defaults);
      integratedQueue.enqueueReport(makeQuestion(), 0);
      now.mockReturnValue(10_000);
      integratedQueue.enqueueReport(
        {
          type: 'report',
          reportType: 'idle_candidate',
          reportId: 'idle-candidate',
          conductorAgentId: 'conductor-42',
          issueUrl,
          text: 'idle candidate',
        },
        0,
      );
      const integratedBatch = integratedQueue.selectBatch(
        { continuationConsumed: false },
        30_000,
      )!;
      const integratedQuestion = integratedBatch.events.find(
        (event) => event.type === 'report' && event.reportId === 'question',
      );
      if (!integratedQuestion || integratedQuestion.type !== 'report') {
        throw new Error('integrated Open Question was not selected');
      }
      const integratedOpenQuestionWaitMs =
        30_000 - integratedQuestion.firstQueuedAt!;

      expect({
        baseline: {
          dispatches: 1,
          openQuestionWaitMs: baselineOpenQuestionWaitMs,
          reports: baselineBatch.events.length,
        },
        integrated: {
          dispatches: 1,
          openQuestionWaitMs: integratedOpenQuestionWaitMs,
          reports: integratedBatch.events.length,
          priority: integratedBatch.priority,
        },
      }).toEqual({
        baseline: {
          dispatches: 1,
          openQuestionWaitMs: 30_000,
          reports: 1,
        },
        integrated: {
          dispatches: 1,
          openQuestionWaitMs: 30_000,
          reports: 2,
          priority: 'open_question',
        },
      });
    } finally {
      now.mockRestore();
    }
  });
});
