import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { listRuns, getRun } = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock('@cursor/sdk', () => ({
  Agent: { listRuns, getRun },
}));

import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { Run } from '@cursor/sdk';
import { listConductorProviderHistory } from './conductor-history.js';
import {
  PI_CONDUCTOR_MESSAGE_HISTORY_ENTRY_TYPE,
  PI_SESSION_ROOT,
} from './pi-conductor-agent.js';

describe('listConductorProviderHistory', () => {
  let tempDir = '';

  afterEach(async () => {
    vi.resetAllMocks();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('reads only active Pi branch user/final-response entries after restart', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-pi-history-'));
    const sessionDir = join(tempDir, PI_SESSION_ROOT);
    const manager = SessionManager.create(tempDir, sessionDir, {
      id: 'pi-history-agent',
    });
    const oldTurn = appendPiTurn(manager, {
      inbound: 'abandoned inbound',
      toolOutput: 'ABANDONED_SECRET',
      response: 'abandoned response',
      sendCount: 1,
      dispatchSource: 'operator',
    });

    manager.branch(oldTurn.inboundEntryId);
    const activeTurn = appendPiTurn(manager, {
      inbound: 'current inbound batch',
      toolOutput: 'TOOL_SECRET',
      response: 'final visible answer',
      sendCount: 7,
      dispatchSource: 'worker:reviewer',
      compact: true,
    });

    const result = await listConductorProviderHistory({
      backend: 'pi',
      conductorAgentId: 'pi-history-agent',
      cwd: tempDir,
      query: { limit: 20, order: 'desc' },
    });

    expect(result).toEqual({
      messages: [
        {
          backend: 'pi',
          providerId: activeTurn.responseEntryId,
          at: 1_800_000_000_007,
          text: 'final visible answer',
          inbound: 'current inbound batch',
          sendCount: 7,
          dispatchSource: 'worker:reviewer',
        },
      ],
      hasMore: false,
    });
    expect(JSON.stringify(result)).not.toContain('TOOL_SECRET');
    expect(JSON.stringify(result)).not.toContain('THINKING_SECRET');
    expect(JSON.stringify(result)).not.toContain('COMPACTION_SECRET');
    expect(JSON.stringify(result)).not.toContain('abandoned');

    const entries = manager.getEntries();
    const historyMarker = entries.find(
      (entry) =>
        entry.type === 'custom' &&
        entry.customType === PI_CONDUCTOR_MESSAGE_HISTORY_ENTRY_TYPE &&
        entry.data &&
        typeof entry.data === 'object' &&
        'responseEntryId' in entry.data &&
        entry.data.responseEntryId === activeTurn.responseEntryId,
    );
    expect(historyMarker).toMatchObject({
      type: 'custom',
      data: {
        inboundEntryId: activeTurn.inboundEntryId,
        responseEntryId: activeTurn.responseEntryId,
        sendCount: 7,
        dispatchSource: 'worker:reviewer',
      },
    });
    expect(JSON.stringify(historyMarker?.data)).not.toContain(
      'current inbound batch',
    );
    expect(JSON.stringify(historyMarker?.data)).not.toContain(
      'final visible answer',
    );
    expect(
      manager
        .buildSessionContext()
        .messages.some((message) =>
          JSON.stringify(message).includes(
            PI_CONDUCTOR_MESSAGE_HISTORY_ENTRY_TYPE,
          ),
        ),
    ).toBe(false);
  });

  it('does not backfill pre-feature Pi transcripts without history markers', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-pi-history-legacy-'));
    const sessionDir = join(tempDir, PI_SESSION_ROOT);
    const manager = SessionManager.create(tempDir, sessionDir, {
      id: 'legacy-pi-history-agent',
    });
    manager.appendMessage({
      role: 'user',
      content: 'legacy inbound',
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: 'assistant',
      content: 'legacy response',
      timestamp: Date.now(),
    });

    expect(
      manager
        .getBranch()
        .some(
          (entry) =>
            entry.type === 'custom' &&
            entry.customType === PI_CONDUCTOR_MESSAGE_HISTORY_ENTRY_TYPE,
        ),
    ).toBe(false);

    await expect(
      listConductorProviderHistory({
        backend: 'pi',
        conductorAgentId: 'legacy-pi-history-agent',
        cwd: tempDir,
        query: { limit: 20, order: 'desc' },
      }),
    ).resolves.toEqual({ messages: [], hasMore: false });
  });

  it('uses Cursor run API pagination, excludes bootstrap and unsuccessful runs, and exposes only user/final text', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-cursor-history-'));
    const run1 = cursorRun(
      'cursor-agent',
      'run-1',
      'finished',
      'final 1',
      'inbound 1',
    );
    const run2 = cursorRun(
      'cursor-agent',
      'run-2',
      'error',
      'failed partial',
      'secret prompt',
    );
    const run3 = cursorRun(
      'cursor-agent',
      'run-3',
      'cancelled',
      'cancelled partial',
      'cancel prompt',
    );
    const run4 = cursorRun(
      'cursor-agent',
      'run-4',
      'running',
      undefined,
      'running prompt',
    );
    const run5 = cursorRun(
      'cursor-agent',
      'run-5',
      'finished',
      '  ',
      'empty response prompt',
    );
    const run6 = cursorRun(
      'cursor-agent',
      'run-6',
      'finished',
      'final tool-heavy',
      'formatted inbound 6',
      'TOOL_SECRET',
    );
    listRuns
      .mockResolvedValueOnce({
        items: [
          cursorRun(
            'cursor-agent',
            'bootstrap',
            'finished',
            'bootstrap result',
            'bootstrap prompt',
          ),
          run1,
          run2,
        ],
        nextCursor: 'page-two',
      })
      .mockResolvedValueOnce({
        items: [run3, run4, run5, run6],
      });
    for (const run of [run1, run6]) getRun.mockResolvedValueOnce(run);

    const result = await listConductorProviderHistory({
      backend: 'cursor',
      conductorAgentId: 'cursor-agent',
      cwd: tempDir,
      cursorBootstrapRunId: 'bootstrap',
      query: { limit: 1, order: 'desc' },
    });

    expect(listRuns).toHaveBeenNthCalledWith(1, 'cursor-agent', {
      runtime: 'local',
      cwd: tempDir,
      limit: 100,
    });
    expect(listRuns).toHaveBeenNthCalledWith(2, 'cursor-agent', {
      runtime: 'local',
      cwd: tempDir,
      limit: 100,
      cursor: 'page-two',
    });
    expect(getRun).toHaveBeenCalledTimes(2);
    expect(getRun).toHaveBeenCalledWith('run-6', {
      runtime: 'local',
      cwd: tempDir,
    });
    expect(result).toEqual({
      messages: [
        {
          backend: 'cursor',
          providerId: 'run-6',
          requestId: 'request-run-6',
          at: 1_800_000_000_006,
          text: 'final tool-heavy',
          inbound: 'formatted inbound 6',
        },
      ],
      hasMore: true,
    });
    expect(JSON.stringify(result)).not.toContain('TOOL_SECRET');
    expect(JSON.stringify(result)).not.toContain('thinking');
    expect(JSON.stringify(result)).not.toContain('SYSTEM_SECRET');
    expect(JSON.stringify(result)).not.toContain('SHELL_SECRET');
  });

  it('uses the first Cursor run as the bootstrap fallback for legacy sidecars', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-cursor-legacy-'));
    const first = cursorRun(
      'legacy-agent',
      'old-bootstrap',
      'finished',
      'initial',
      'initial',
    );
    const next = cursorRun(
      'legacy-agent',
      'old-next',
      'finished',
      'next',
      'prompt',
    );
    listRuns.mockResolvedValueOnce({ items: [first, next] });
    getRun.mockResolvedValueOnce(next);

    const result = await listConductorProviderHistory({
      backend: 'cursor',
      conductorAgentId: 'legacy-agent',
      cwd: tempDir,
      query: { limit: 20, order: 'asc' },
    });

    expect(result.messages.map((message) => message.providerId)).toEqual([
      'old-next',
    ]);
    expect(getRun).toHaveBeenCalledOnce();
    expect(getRun).toHaveBeenCalledWith('old-next', {
      runtime: 'local',
      cwd: tempDir,
    });
  });

  it('returns an empty list only when a saved Cursor bootstrap run is readable', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-cursor-bootstrap-only-'));
    listRuns.mockResolvedValueOnce({
      items: [
        cursorRun(
          'bootstrap-only-agent',
          'bootstrap-only',
          'finished',
          'initial response',
          'initial prompt',
        ),
      ],
    });

    await expect(
      listConductorProviderHistory({
        backend: 'cursor',
        conductorAgentId: 'bootstrap-only-agent',
        cwd: tempDir,
        query: { limit: 20, order: 'desc' },
      }),
    ).resolves.toEqual({ messages: [], hasMore: false });
    expect(getRun).not.toHaveBeenCalled();
  });

  it('rejects a run returned for a different Cursor agent before reading its conversation', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-cursor-boundary-'));
    const foreignRun = cursorRun(
      'another-agent',
      'foreign-run',
      'finished',
      'private response',
      'private inbound',
    );
    listRuns.mockResolvedValueOnce({ items: [foreignRun] });
    getRun.mockResolvedValueOnce(foreignRun);

    await expect(
      listConductorProviderHistory({
        backend: 'cursor',
        conductorAgentId: 'requested-agent',
        cwd: tempDir,
        cursorBootstrapRunId: 'bootstrap',
        query: { limit: 20, order: 'desc' },
      }),
    ).rejects.toThrow(
      'Provider history is unavailable for conductor session requested-agent (cursor).',
    );
    expect(foreignRun.conversation).not.toHaveBeenCalled();
  });

  it('caps Cursor history at the latest 100 completed runs and pages with provider IDs', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-cursor-limit-'));
    const runs = Array.from({ length: 105 }, (_, index) =>
      cursorRun(
        'cursor-limit-agent',
        `run-${index}`,
        'finished',
        `response-${index}`,
        `prompt-${index}`,
      ),
    );
    listRuns.mockImplementation(
      async (_agentId: string, options: { cursor?: string }) => {
        if (options.cursor === undefined) {
          return { items: runs.slice(0, 40), nextCursor: '40' };
        }
        if (options.cursor === '40') {
          return { items: runs.slice(40, 80), nextCursor: '80' };
        }
        return { items: runs.slice(80) };
      },
    );
    const runsById = new Map(runs.map((run) => [run.id, run]));
    getRun.mockImplementation(async (id: string) => runsById.get(id));

    const latestPage = await listConductorProviderHistory({
      backend: 'cursor',
      conductorAgentId: 'cursor-limit-agent',
      cwd: tempDir,
      cursorBootstrapRunId: 'run-0',
      query: { limit: 20, order: 'desc' },
    });
    expect(latestPage.messages).toHaveLength(20);
    expect(latestPage.messages[0]?.providerId).toBe('run-104');
    expect(latestPage.messages.at(-1)?.providerId).toBe('run-85');
    expect(latestPage.hasMore).toBe(true);

    const olderPage = await listConductorProviderHistory({
      backend: 'cursor',
      conductorAgentId: 'cursor-limit-agent',
      cwd: tempDir,
      cursorBootstrapRunId: 'run-0',
      query: {
        limit: 20,
        order: 'desc',
        cursor: latestPage.messages.at(-1)!.providerId,
      },
    });
    expect(olderPage.messages.map((message) => message.providerId)).toEqual(
      Array.from({ length: 20 }, (_, index) => `run-${84 - index}`),
    );
    expect(olderPage.hasMore).toBe(true);
  });

  it('reports missing Pi sessions, damaged transcripts, and Cursor store failures as errors', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-history-failure-'));
    await expect(
      listConductorProviderHistory({
        backend: 'pi',
        conductorAgentId: 'missing-pi-agent',
        cwd: tempDir,
        query: { limit: 20, order: 'desc' },
      }),
    ).rejects.toThrow(
      'Provider history is unavailable for conductor session missing-pi-agent (pi).',
    );

    const manager = SessionManager.create(
      tempDir,
      join(tempDir, PI_SESSION_ROOT),
      { id: 'damaged-pi-agent' },
    );
    manager.appendMessage({
      role: 'user',
      content: 'prompt',
      timestamp: Date.now(),
    });
    const file = manager.getSessionFile()!;
    await writeFile(file, '{"type":"session","id":"damaged-pi-agent"}\n{broken\n');
    await expect(
      listConductorProviderHistory({
        backend: 'pi',
        conductorAgentId: 'damaged-pi-agent',
        cwd: tempDir,
        query: { limit: 20, order: 'desc' },
      }),
    ).rejects.toThrow(
      'Provider history is unavailable for conductor session damaged-pi-agent (pi).',
    );

    listRuns.mockRejectedValueOnce(new Error('local store read failed'));
    await expect(
      listConductorProviderHistory({
        backend: 'cursor',
        conductorAgentId: 'unavailable-cursor-agent',
        cwd: tempDir,
        query: { limit: 20, order: 'desc' },
      }),
    ).rejects.toThrow(
      'Provider history is unavailable for conductor session unavailable-cursor-agent (cursor).',
    );

    listRuns.mockResolvedValueOnce({ items: [] });
    await expect(
      listConductorProviderHistory({
        backend: 'cursor',
        conductorAgentId: 'missing-cursor-agent',
        cwd: tempDir,
        query: { limit: 20, order: 'desc' },
      }),
    ).rejects.toThrow(
      'Provider history is unavailable for conductor session missing-cursor-agent (cursor).',
    );

    const unreadableRun = cursorRun(
      'unreadable-cursor-agent',
      'unreadable-run',
      'finished',
      'prompt',
      'response',
    );
    listRuns.mockResolvedValueOnce({ items: [unreadableRun] });
    getRun.mockRejectedValueOnce(new Error('run store read failed'));
    await expect(
      listConductorProviderHistory({
        backend: 'cursor',
        conductorAgentId: 'unreadable-cursor-agent',
        cwd: tempDir,
        cursorBootstrapRunId: 'bootstrap',
        query: { limit: 20, order: 'desc' },
      }),
    ).rejects.toThrow(
      'Provider history is unavailable for conductor session unreadable-cursor-agent (cursor).',
    );

    const conversationFailure = cursorRun(
      'conversation-failure-agent',
      'conversation-failure-run',
      'finished',
      'prompt',
      'response',
    );
    conversationFailure.conversation = vi
      .fn()
      .mockRejectedValue(new Error('conversation read failed'));
    listRuns.mockResolvedValueOnce({ items: [conversationFailure] });
    getRun.mockResolvedValueOnce(conversationFailure);
    await expect(
      listConductorProviderHistory({
        backend: 'cursor',
        conductorAgentId: 'conversation-failure-agent',
        cwd: tempDir,
        cursorBootstrapRunId: 'bootstrap',
        query: { limit: 20, order: 'desc' },
      }),
    ).rejects.toThrow(
      'Provider history is unavailable for conductor session conversation-failure-agent (cursor).',
    );
  });
});

function appendPiTurn(
  manager: SessionManager,
  input: {
    inbound: string;
    toolOutput: string;
    response: string;
    sendCount: number;
    dispatchSource: string;
    compact?: boolean;
  },
): { inboundEntryId: string; responseEntryId: string } {
  const inboundEntryId = manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: input.inbound }],
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'THINKING_SECRET' },
      {
        type: 'toolCall',
        id: `tool-${input.sendCount}`,
        name: 'shell',
        arguments: { command: input.toolOutput },
      },
    ],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'model-1',
    usage: {} as never,
    stopReason: 'toolUse',
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: `tool-${input.sendCount}`,
    toolName: 'shell',
    content: [{ type: 'text', text: input.toolOutput }],
    isError: false,
    timestamp: Date.now(),
  });
  if (input.compact) {
    manager.appendCompaction('COMPACTION_SECRET', inboundEntryId, 100);
  }
  const responseEntryId = manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: input.response }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'model-1',
    usage: {} as never,
    stopReason: 'stop',
    timestamp: Date.now(),
  });
  manager.appendCustomEntry(PI_CONDUCTOR_MESSAGE_HISTORY_ENTRY_TYPE, {
    inboundEntryId,
    responseEntryId,
    completedAt: 1_800_000_000_000 + input.sendCount,
    sendCount: input.sendCount,
    dispatchSource: input.dispatchSource,
  });
  return { inboundEntryId, responseEntryId };
}

function cursorRun(
  agentId: string,
  id: string,
  status: string,
  result: string | undefined,
  inbound: string,
  toolData?: string,
): Run {
  return {
    id,
    requestId: `request-${id}`,
    agentId,
    status,
    result,
    createdAt: 1_800_000_000_000 + Number(id.split('-').at(-1)?.replace(/\D/g, '') || 0),
    conversation: vi.fn().mockResolvedValue([
      {
        type: 'shellConversationTurn',
        turn: {
          shellCommand: { command: 'SHELL_SECRET' },
          shellOutput: { stdout: 'SHELL_SECRET', stderr: '', exitCode: 0 },
        },
      },
      {
        type: 'systemMessage',
        message: { text: 'SYSTEM_SECRET' },
      },
      {
        type: 'agentConversationTurn',
        turn: {
          userMessage: { text: inbound },
          steps: [
            {
              type: 'thinkingMessage',
              message: { text: 'THINKING_SECRET' },
            },
            ...(toolData
              ? [
                  {
                    type: 'toolCall',
                    message: {
                      type: 'shell',
                      args: { command: toolData },
                    },
                  },
                ]
              : []),
          ],
        },
      },
    ]),
  } as unknown as Run;
}
