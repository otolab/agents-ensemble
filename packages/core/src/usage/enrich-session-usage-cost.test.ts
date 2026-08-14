import { describe, expect, it, vi } from 'vitest';
import type { UsageCost } from '@cursor/sdk';
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
  it('merges cost when getter returns UsageCost', async () => {
    const cost: UsageCost = { rawCostCents: 51, chargedCents: 42 };
    const result = await enrichSessionUsageWithCost(EMPTY_SUMMARY, async () => cost);
    expect(result.cost).toEqual(cost);
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
