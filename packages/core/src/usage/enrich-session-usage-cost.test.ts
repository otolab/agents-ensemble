import { describe, expect, it, vi } from 'vitest';
import type { ConductorUsageCost } from '../conductor/conductor-agent.js';
import {
  enrichSessionUsageWithCost,
} from './enrich-session-usage-cost.js';
import type { SessionUsageSummary } from './types.js';

const EMPTY_SUMMARY: SessionUsageSummary = {
  totals: { rounds: 1, roundsWithUsage: 1, tokens: null },
  byAgent: {
    conductor: { rounds: 1, roundsWithUsage: 0, tokens: null },
    workers: {},
  },
  context: { limit: null, usedInputTokens: 0, percent: null },
  latestRound: null,
};

describe('enrichSessionUsageWithCost', () => {
  it('keeps legacy cost literals assignable to SessionUsageSummary', () => {
    const legacySummary: SessionUsageSummary = {
      ...EMPTY_SUMMARY,
      cost: { rawCostCents: 51, chargedCents: 42 },
    };

    expect(legacySummary.cost).toEqual({
      rawCostCents: 51,
      chargedCents: 42,
    });
  });

  it('merges cost when getter returns ConductorUsageCost', async () => {
    const cost: ConductorUsageCost = { rawCostCents: 51, chargedCents: 42 };
    const result = await enrichSessionUsageWithCost(EMPTY_SUMMARY, async () => cost);
    expect(result.cost).toEqual({
      ...cost,
      scope: 'conductor-only',
    });
  });

  it('returns original summary when getter is omitted', async () => {
    const result = await enrichSessionUsageWithCost(EMPTY_SUMMARY);
    expect(result).toBe(EMPTY_SUMMARY);
  });

  it('returns original summary when getter returns undefined', async () => {
    const result = await enrichSessionUsageWithCost(EMPTY_SUMMARY, async () => undefined);
    expect(result).toEqual(EMPTY_SUMMARY);
  });

  it('returns original summary when getter throws', async () => {
    const result = await enrichSessionUsageWithCost(EMPTY_SUMMARY, async () => {
      throw new Error('billing unavailable');
    });
    expect(result).toEqual(EMPTY_SUMMARY);
  });

  it('swallows getter errors without calling vi', async () => {
    const getCost = vi.fn().mockRejectedValue(new Error('fail'));
    const result = await enrichSessionUsageWithCost(EMPTY_SUMMARY, getCost);
    expect(getCost).toHaveBeenCalledOnce();
    expect(result).toEqual(EMPTY_SUMMARY);
  });
});
