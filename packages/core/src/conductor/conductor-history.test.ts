import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import { ENSEMBLE_USER_ROOT_ENV } from '../resolve-user-ensemble-root.js';

const { listRuns, getRun } = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock('@cursor/sdk', () => ({
  Agent: { listRuns, getRun },
}));

import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { Run } from '@cursor/sdk';
import {
  listConductorProviderHistory,
  type ConductorProviderHistorySanitizer,
} from './conductor-history.js';
import {
  PI_CONDUCTOR_MESSAGE_HISTORY_ENTRY_TYPE,
  PI_SESSION_ROOT,
} from './pi-conductor-agent.js';

describe('listConductorProviderHistory', () => {
  let tempDir = '';
  let previousUserRoot: string | undefined;
  let changedUserRoot = false;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    if (changedUserRoot) {
      if (previousUserRoot === undefined) {
        delete process.env[ENSEMBLE_USER_ROOT_ENV];
      } else {
        process.env[ENSEMBLE_USER_ROOT_ENV] = previousUserRoot;
      }
      previousUserRoot = undefined;
      changedUserRoot = false;
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  function setUserRoot(userRoot: string): void {
    if (!changedUserRoot) {
      previousUserRoot = process.env[ENSEMBLE_USER_ROOT_ENV];
      changedUserRoot = true;
    }
    process.env[ENSEMBLE_USER_ROOT_ENV] = userRoot;
  }

  it('reads only active Pi branch user/final-response entries after restart', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-pi-history-'));
    setUserRoot(join(tempDir, 'user-ensemble'));
    const sessionDir = resolveEnsemblePaths({ repoRoot: tempDir }).piSessionsDir;
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
      repoRoot: tempDir,
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

  it('prefers repoRoot user sessions for worktree cwd and opens them with that cwd', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-pi-history-worktree-'));
    const repoRoot = join(tempDir, 'repository');
    const conductorCwd = join(
      repoRoot,
      '.ensemble',
      'worktrees',
      'issue-671',
    );
    setUserRoot(join(tempDir, 'user-ensemble'));
    const paths = resolveEnsemblePaths({ repoRoot });
    const userManager = SessionManager.create(
      conductorCwd,
      paths.piSessionsDir,
      { id: 'pi-worktree-history-agent' },
    );
    const userTurn = appendPiTurn(userManager, {
      inbound: 'repo-root user transcript',
      toolOutput: 'USER_TOOL_SECRET',
      response: 'repo-root response',
      sendCount: 1,
      dispatchSource: 'operator',
    });
    const legacyManager = SessionManager.create(
      conductorCwd,
      paths.legacyPiSessionsDirForCwd(conductorCwd),
      { id: 'pi-worktree-history-agent' },
    );
    appendPiTurn(legacyManager, {
      inbound: 'legacy transcript',
      toolOutput: 'LEGACY_TOOL_SECRET',
      response: 'legacy response',
      sendCount: 2,
      dispatchSource: 'operator',
    });
    const openSpy = vi.spyOn(SessionManager, 'open');

    const result = await listConductorProviderHistory({
      backend: 'pi',
      conductorAgentId: 'pi-worktree-history-agent',
      cwd: conductorCwd,
      repoRoot,
      query: { limit: 20, order: 'desc' },
    });

    expect(result.messages).toMatchObject([
      {
        providerId: userTurn.responseEntryId,
        inbound: 'repo-root user transcript',
        text: 'repo-root response',
      },
    ]);
    expect(openSpy).toHaveBeenCalledWith(
      userManager.getSessionFile(),
      paths.piSessionsDir,
      conductorCwd,
    );
    expect(JSON.stringify(result)).not.toContain('legacy transcript');
  });

  it('falls back to the legacy project session directory under conductor cwd', async () => {
    tempDir = await mkdtemp(
      join(tmpdir(), 'ensemble-pi-history-legacy-fallback-'),
    );
    const repoRoot = join(tempDir, 'repository');
    const conductorCwd = join(
      repoRoot,
      '.ensemble',
      'worktrees',
      'issue-671',
    );
    setUserRoot(join(tempDir, 'user-ensemble'));
    const paths = resolveEnsemblePaths({ repoRoot });
    const manager = SessionManager.create(
      conductorCwd,
      paths.legacyPiSessionsDirForCwd(conductorCwd),
      { id: 'pi-legacy-fallback-agent' },
    );
    appendPiTurn(manager, {
      inbound: 'legacy project transcript',
      toolOutput: 'LEGACY_TOOL_SECRET',
      response: 'legacy project response',
      sendCount: 1,
      dispatchSource: 'operator',
    });

    const result = await listConductorProviderHistory({
      backend: 'pi',
      conductorAgentId: 'pi-legacy-fallback-agent',
      cwd: conductorCwd,
      repoRoot,
      query: { limit: 20, order: 'desc' },
    });

    expect(result.messages).toMatchObject([
      {
        inbound: 'legacy project transcript',
        text: 'legacy project response',
      },
    ]);
  });

  it('keeps the default result raw and sanitizes only returned text fields when requested', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ensemble-pi-history-sanitizer-'));
    const sessionDir = join(tempDir, PI_SESSION_ROOT);
    const manager = SessionManager.create(tempDir, sessionDir, {
      id: 'pi-history-sanitizer-agent',
    });
    appendPiTurn(manager, {
      inbound: 'older inbound secret-old',
      toolOutput: 'OLDER_TOOL_SECRET',
      response: 'older response secret-old',
      sendCount: 1,
      dispatchSource: 'operator',
    });
    appendPiTurn(manager, {
      inbound: 'current inbound secret-current',
      toolOutput: 'CURRENT_TOOL_SECRET',
      response: 'current response secret-current',
      sendCount: 2,
      dispatchSource: 'worker:implementer',
    });

    const input = {
      backend: 'pi' as const,
      conductorAgentId: 'pi-history-sanitizer-agent',
      cwd: tempDir,
      query: { limit: 1, order: 'desc' as const },
    };
    const raw = await listConductorProviderHistory(input);
    const sanitizer: ConductorProviderHistorySanitizer = vi.fn(
      async (value: string, field: 'inbound' | 'text') =>
        `${field}: ${value.replace(/secret-[a-z]+/gu, '[redacted]')}`,
    );

    const sanitized = await listConductorProviderHistory({
      ...input,
      sanitizer,
    });

    expect(sanitized).toEqual({
      messages: [
        {
          ...raw.messages[0],
          inbound: 'inbound: current inbound [redacted]',
          text: 'text: current response [redacted]',
        },
      ],
      hasMore: true,
    });
    expect(sanitizer).toHaveBeenNthCalledWith(
      1,
      'current inbound secret-current',
      'inbound',
    );
    expect(sanitizer).toHaveBeenNthCalledWith(
      2,
      'current response secret-current',
      'text',
    );
    expect(sanitizer).toHaveBeenCalledTimes(2);
    expect(raw.messages[0]).toMatchObject({
      inbound: 'current inbound secret-current',
      text: 'current response secret-current',
    });
    expect(JSON.stringify(sanitized)).not.toContain('secret-current');
    expect(JSON.stringify(sanitized)).not.toContain('OLDER_TOOL_SECRET');
  });

  it('does not return provider text when the requested sanitizer fails', async () => {
    tempDir = await mkdtemp(
      join(tmpdir(), 'ensemble-pi-history-sanitizer-error-'),
    );
    const manager = SessionManager.create(
      tempDir,
      join(tempDir, PI_SESSION_ROOT),
      { id: 'pi-history-sanitizer-error-agent' },
    );
    appendPiTurn(manager, {
      inbound: 'inbound sanitizer-error-secret',
      toolOutput: 'TOOL_SECRET',
      response: 'response sanitizer-error-secret',
      sendCount: 1,
      dispatchSource: 'operator',
    });

    const error = await listConductorProviderHistory({
      backend: 'pi',
      conductorAgentId: 'pi-history-sanitizer-error-agent',
      cwd: tempDir,
      query: { limit: 20, order: 'desc' },
      sanitizer: async () => {
        throw new Error('SANITIZER_SECRET');
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Provider history sanitizer failed for conductor session pi-history-sanitizer-error-agent (pi).',
    );
    expect((error as Error).message).not.toContain('SANITIZER_SECRET');
    expect((error as Error).message).not.toContain('sanitizer-error-secret');

    const invalidReturn = await listConductorProviderHistory({
      backend: 'pi',
      conductorAgentId: 'pi-history-sanitizer-error-agent',
      cwd: tempDir,
      query: { limit: 20, order: 'desc' },
      sanitizer: (() => 42) as unknown as ConductorProviderHistorySanitizer,
    }).catch((caught: unknown) => caught);

    expect(invalidReturn).toBeInstanceOf(Error);
    expect((invalidReturn as Error).message).toBe(
      'Provider history sanitizer failed for conductor session pi-history-sanitizer-error-agent (pi).',
    );
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

    const postUpgradeTurn = appendPiTurn(manager, {
      inbound: 'inbound recorded after upgrade',
      toolOutput: 'POST_UPGRADE_TOOL_SECRET',
      response: 'response recorded after upgrade',
      sendCount: 1,
      dispatchSource: 'operator',
    });
    const result = await listConductorProviderHistory({
      backend: 'pi',
      conductorAgentId: 'legacy-pi-history-agent',
      cwd: tempDir,
      query: { limit: 20, order: 'desc' },
    });

    expect(result).toEqual({
      messages: [
        {
          backend: 'pi',
          providerId: postUpgradeTurn.responseEntryId,
          at: 1_800_000_000_001,
          text: 'response recorded after upgrade',
          inbound: 'inbound recorded after upgrade',
          sendCount: 1,
          dispatchSource: 'operator',
        },
      ],
      hasMore: false,
    });
    expect(JSON.stringify(result)).not.toContain('legacy');
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
