import { describe, expect, it, beforeEach } from 'vitest';
import {
  resetSessionUsageRoundCounter,
  SessionUsageTracker,
} from './session-usage-tracker.js';

describe('SessionUsageTracker', () => {
  beforeEach(() => {
    resetSessionUsageRoundCounter();
  });

  it('aggregates conductor SDK usage and worker estimated usage', () => {
    const tracker = new SessionUsageTracker({ contextLimitTokens: 1000 });

    tracker.recordConductorRound({
      runId: 'run-1',
      status: 'finished',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
      },
      modelId: 'composer-2.5',
    });

    tracker.recordWorkerRound({
      name: 'implementer',
      kind: 'implementer',
      source: 'harness',
      prompt: 'hello world',
      promptResult: {
        stopReason: 'end_turn',
        responseText: 'ok',
      },
    });

    const summary = tracker.getSessionSummary();

    expect(summary.tokenScope).toBe('recorded-usage-only');
    expect(summary.totals.rounds).toBe(2);
    expect(summary.totals.roundsWithUsage).toBe(2);
    expect(summary.totals.tokens).toMatchObject({
      inputTokens: 103,
      outputTokens: 51,
    });
    expect(summary.byAgent.conductor.rounds).toBe(1);
    expect(summary.byAgent.workers.implementer?.rounds).toBe(1);
    expect(summary.byAgent.workers.implementer?.tokens?.inputTokens).toBeGreaterThan(0);
    expect(summary.context).toMatchObject({
      limit: 1000,
      usedInputTokens: 103,
      percent: 10,
    });
  });

  it('prefers ACP usage when worker prompt reports it', () => {
    const tracker = new SessionUsageTracker();

    tracker.recordWorkerRound({
      name: 'reviewer',
      kind: 'reviewer',
      prompt: 'ignored for usage',
      promptResult: {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30,
        },
      },
    });

    const latest = tracker.getLatestRound({ agent: 'reviewer' });
    expect(latest?.usage).toMatchObject({
      source: 'acp',
      inputTokens: 20,
      outputTokens: 10,
    });
  });

  it('returns null context percent without limit', () => {
    const tracker = new SessionUsageTracker();
    tracker.recordConductorRound({
      runId: 'run-1',
      status: 'finished',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
      },
    });

    expect(tracker.getSessionSummary().context).toMatchObject({
      limit: null,
      percent: null,
      usedInputTokens: 10,
    });
  });

  it('aggregates cache rates by scope using only rounds with cache-read data', () => {
    const tracker = new SessionUsageTracker();
    tracker.recordConductorRound({
      runId: 'run-cache',
      status: 'finished',
      usage: {
        inputTokens: 80,
        outputTokens: 10,
        totalTokens: 90,
        cacheReadTokens: 20,
        cacheWriteTokens: 3,
      },
    });
    tracker.recordConductorRound({
      runId: 'run-no-cache',
      status: 'finished',
      usage: {
        inputTokens: 120,
        outputTokens: 10,
        totalTokens: 130,
      },
    });
    tracker.recordWorkerRound({
      name: 'implementer',
      kind: 'implementer',
      prompt: 'task',
      promptResult: {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 30,
          outputTokens: 5,
          totalTokens: 35,
          cacheReadTokens: 10,
          cacheWriteTokens: 0,
        },
      },
    });
    tracker.recordWorkerRound({
      name: 'reviewer',
      kind: 'reviewer',
      prompt: 'task',
      promptResult: {
        stopReason: 'end_turn',
        usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
      },
    });

    expect(tracker.getSessionSummary().cacheStats).toEqual({
      totals: {
        cacheHitRate: 30 / 140,
        cacheReadTokens: 30,
        cacheWriteTokens: 3,
      },
      byAgent: {
        conductor: {
          cacheHitRate: 20 / 100,
          cacheReadTokens: 20,
          cacheWriteTokens: 3,
        },
        workers: {
          implementer: {
            cacheHitRate: 10 / 40,
            cacheReadTokens: 10,
            cacheWriteTokens: 0,
          },
          reviewer: null,
        },
      },
    });
  });

  it('omits cache summary without cache data and omits a zero-denominator rate', () => {
    const tracker = new SessionUsageTracker();
    tracker.recordConductorRound({
      runId: 'run-no-cache',
      status: 'finished',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    });
    expect(tracker.getSessionSummary()).not.toHaveProperty('cacheStats');

    const zeroDenominator = new SessionUsageTracker();
    zeroDenominator.recordConductorRound({
      runId: 'run-zero',
      status: 'finished',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
      },
    });
    expect(zeroDenominator.getSessionSummary().cacheStats).toEqual({
      totals: { cacheReadTokens: 0 },
      byAgent: { conductor: { cacheReadTokens: 0 }, workers: {} },
    });
  });

  it('includes compaction count only when reliable counting is enabled', () => {
    const unsupportedTracker = new SessionUsageTracker();
    expect(unsupportedTracker.getSessionSummary()).not.toHaveProperty(
      'compactionCount',
    );

    const piTracker = new SessionUsageTracker({ trackCompactions: true });
    expect(piTracker.getSessionSummary().compactionCount).toBe(0);
    piTracker.recordContextCompaction();
    expect(piTracker.getSessionSummary().compactionCount).toBe(1);
  });
});
