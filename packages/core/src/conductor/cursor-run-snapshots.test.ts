import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listRuns, getRun } = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock('@cursor/sdk', () => ({
  Agent: { listRuns, getRun },
}));

import { readCursorConductorRunSnapshots } from './cursor-run-snapshots.js';

describe('readCursorConductorRunSnapshots', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reads all pages and preserves run metadata with conversation snapshots', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `run-${index}`,
      agentId: 'conductor-1',
      status: 'finished',
      result: `result-${index}`,
    }));
    listRuns
      .mockResolvedValueOnce({ items: firstPage, nextCursor: 'page-2' })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'run-100',
            agentId: 'conductor-1',
            status: 'running',
          },
        ],
      });
    getRun.mockImplementation(async (id: string) => ({
      id,
      agentId: 'conductor-1',
      requestId: `request-${id}`,
      status: id === 'run-100' ? 'running' : 'finished',
      createdAt: 1_800_000_000_000,
      result: id === 'run-100' ? undefined : `result-${id}`,
      conversation: async () => [
        {
          type: 'agentConversationTurn',
          turn: {
            userMessage: { text: `inbound-${id}` },
            assistantMessage: { text: `response-${id}` },
          },
        },
      ],
    }));

    const result = await readCursorConductorRunSnapshots({
      conductorAgentId: 'conductor-1',
      cwd: '/repo/.ensemble/worktrees/issue-672',
    });

    expect(result.status).toBe('available');
    expect(result.warnings).toEqual([]);
    expect(result.runs).toHaveLength(101);
    expect(result.runs[0]).toEqual({
      metadata: {
        agentId: 'conductor-1',
        id: 'run-0',
        status: 'finished',
        requestId: 'request-run-0',
        createdAt: 1_800_000_000_000,
        result: 'result-run-0',
      },
      conversation: [
        {
          type: 'agentConversationTurn',
          turn: {
            userMessage: { text: 'inbound-run-0' },
            assistantMessage: { text: 'response-run-0' },
          },
        },
      ],
      conversationStatus: 'available',
    });
    expect(result.runs[100]).toMatchObject({
      metadata: {
        id: 'run-100',
        status: 'running',
      },
      conversationStatus: 'available',
    });
    expect(listRuns).toHaveBeenNthCalledWith(1, 'conductor-1', {
      runtime: 'local',
      cwd: '/repo/.ensemble/worktrees/issue-672',
      limit: 100,
    });
    expect(listRuns).toHaveBeenNthCalledWith(2, 'conductor-1', {
      runtime: 'local',
      cwd: '/repo/.ensemble/worktrees/issue-672',
      limit: 100,
      cursor: 'page-2',
    });
  });

  it('keeps listed metadata and reports unavailable run bodies', async () => {
    listRuns.mockResolvedValue({
      items: [
        {
          id: 'run-1',
          agentId: 'conductor-1',
          status: 'finished',
          result: 'listed result',
        },
      ],
    });
    getRun.mockRejectedValue(new Error('private local error'));

    const result = await readCursorConductorRunSnapshots({
      conductorAgentId: 'conductor-1',
      cwd: '/repo',
    });

    expect(result).toEqual({
      status: 'partial',
      runs: [
        {
          metadata: {
            agentId: 'conductor-1',
            id: 'run-1',
            status: 'finished',
            result: 'listed result',
          },
          conversationStatus: 'unavailable',
        },
      ],
      warnings: [
        'Cursor run run-1 was listed, but its saved data could not be read.',
      ],
    });
    expect(JSON.stringify(result)).not.toContain('private local error');
  });

  it('marks a completed empty run listing unavailable', async () => {
    listRuns.mockResolvedValue({ items: [] });

    const result = await readCursorConductorRunSnapshots({
      conductorAgentId: 'conductor-1',
      cwd: '/repo',
    });

    expect(result).toEqual({
      status: 'unavailable',
      runs: [],
      warnings: ['The Cursor provider session has no saved runs.'],
    });
    expect(getRun).not.toHaveBeenCalled();
  });
});
