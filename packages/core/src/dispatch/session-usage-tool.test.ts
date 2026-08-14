import { describe, expect, it, beforeEach } from 'vitest';
import {
  resetSessionUsageRoundCounter,
  SessionUsageTracker,
} from '../usage/session-usage-tracker.js';
import { createSessionUsageTools } from './session-usage-tool.js';

function toolText(result: { content: Array<{ text?: string }> }): string {
  return String(result.content[0]?.text ?? '');
}

describe('createSessionUsageTools', () => {
  beforeEach(() => {
    resetSessionUsageRoundCounter();
  });

  it('get_session_usage returns YAML summary', async () => {
    const tracker = new SessionUsageTracker();
    tracker.recordConductorRound({
      runId: 'run-1',
      status: 'finished',
      usage: {
        inputTokens: 40,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 50,
      },
    });

    const tools = createSessionUsageTools({
      tracker,
      workerNames: ['implementer'],
    });

    const result = await tools.get_session_usage!.execute({});
    expect(toolText(result)).toContain('# get_session_usage');
    expect(toolText(result)).toContain('inputTokens: 40');
    expect(result.structuredContent).toMatchObject({
      totals: { rounds: 1, roundsWithUsage: 1 },
    });
  });

  it('get_session_usage merges conductor cost when provided', async () => {
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

    const tools = createSessionUsageTools({
      tracker,
      workerNames: [],
      getConductorUsageCost: async () => ({
        rawCostCents: 12,
        chargedCents: 10,
      }),
    });

    const result = await tools.get_session_usage!.execute({});
    expect(result.structuredContent).toMatchObject({
      cost: { rawCostCents: 12, chargedCents: 10 },
    });
  });

  it('get_usage returns latest round for a worker', async () => {
    const tracker = new SessionUsageTracker();
    tracker.recordWorkerRound({
      name: 'implementer',
      kind: 'implementer',
      prompt: 'task',
      promptResult: {
        stopReason: 'end_turn',
        responseText: 'done',
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      },
    });

    const tools = createSessionUsageTools({
      tracker,
      workerNames: ['implementer'],
    });

    const result = await tools.get_usage!.execute({ agent: 'implementer' });
    expect(toolText(result)).toContain('agentName: implementer');
    expect(toolText(result)).toContain('source: acp');
  });
});
