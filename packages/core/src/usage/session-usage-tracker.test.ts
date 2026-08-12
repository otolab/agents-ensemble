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
      roundKind: 'bootstrap',
      prompt: 'hello world',
      promptResult: {
        stopReason: 'end_turn',
        responseText: 'ok',
      },
    });

    const summary = tracker.getSessionSummary();

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
});
