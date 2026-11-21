import {
  OPEN_QUESTION_CONTROL_METHODS,
  OpenQuestionControlRemoteError,
  sendOpenQuestionControlRequest,
  startOpenQuestionControlServer
} from '@agents-ensemble/core';
import {
  mkdir,
  mkdtemp,
  readFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createSendOperatorMessageTool } from './open-question-control-tools.js';
import {
  createOperatorDispatchQueue,
  formatOperatorDispatchBatch,
} from './operator-dispatch.js';

import { currentWatchStatePath, setupWatchPoolSuite } from '../test/support/watch-pool-suite.js';

setupWatchPoolSuite((context) => {
  const { createOperatorWatchPool, writeResumeStore, writeOfflineSnapshots } = context;


  it('does not send when listener preparation fails', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-send-listen-fail-'));
    const send = vi.fn().mockReturnValue(true);
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      sendOperatorMessage: send,
      answerOpenQuestion: async () => { throw new Error('unused'); },
    });
    context.closeServers.push(() => liveServer.close());
    await writeResumeStore('send-listen-fail', 1, liveServer.socketPath);
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: createOperatorDispatchQueue() });
    const tool = createSendOperatorMessageTool(context.repoRoot, undefined, (id) => pool.ensureConductorMessageListen(id));
    try {
      await expect(tool.execute({ conductorAgentId: 'send-listen-fail', text: 'never sent', listen: true }))
        .rejects.toThrow(/preparation failed; message was not sent/);
      expect(send).not.toHaveBeenCalled();
      expect(pool.listConductorMessageListens()).toEqual([]);
    } finally {
      pool.close();
    }
  });

  it('listens to new conductor messages with a cursor independent from OQ watch', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-listen-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    let messages = [3, 4].map((sendCount) => ({
      text: `response ${sendCount}`,
      inbound: `inbound ${sendCount}`,
      at: 1_700_000_000_000 + sendCount,
      sendCount,
      dispatchSource: 'operator',
    }));
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => ({ sequence: 2, openQuestions: [] }),
      listConductorMessages: () => messages,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    context.closeServers.push(() => liveServer.close());
    await writeResumeStore('message-listen-one', 1, liveServer.socketPath);

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
    try {
      await pool.register('message-listen-one', {
        pollIntervalMs: 60_000,
        debounceMs: 0,
      });
      await pool.pollOnce('message-listen-one');
      await expect(
        pool.registerConductorMessageListen('message-listen-one'),
      ).resolves.toMatchObject({
        conductorAgentId: 'message-listen-one',
        messageDebounceMs: 10_000,
      });
      await pool.registerConductorMessageListen('message-listen-one', {
        messageDebounceMs: 0,
      });
      await expect(
        pool.registerConductorMessageListen('message-listen-one', {
          messageDebounceMs: 120_000,
        }),
      ).resolves.toMatchObject({ messageDebounceMs: 120_000 });
      await expect(
        pool.registerConductorMessageListen('message-listen-one', {
          messageDebounceMs: 120_001,
        }),
      ).rejects.toThrow('messageDebounceMs must be an integer');
      await pool.registerConductorMessageListen('message-listen-one', {
        messageDebounceMs: 0,
      });
      expect(pool.listConductorMessageListens()).toHaveLength(1);
      expect(dispatchQueue.pendingEventCount).toBe(0);

      const storedPath = currentWatchStatePath(context.repoRoot);
      const baseline = JSON.parse(await readFile(storedPath, 'utf8')) as {
        cursors: Record<string, { sequence: number }>;
        messageCursors: Record<string, number>;
      };
      expect(baseline.cursors['message-listen-one']?.sequence).toBe(2);
      expect(baseline.messageCursors['message-listen-one']).toBe(4);

      messages = [
        ...messages,
        ...[5, 6].map((sendCount) => ({
          text: `response ${sendCount}`,
          inbound: `inbound ${sendCount}`,
          at: 1_700_000_000_000 + sendCount,
          sendCount,
          dispatchSource: 'worker:reviewer',
        })),
      ];
      await expect(
        pool.pollConductorMessagesOnce('message-listen-one'),
      ).resolves.toBe(2);
      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events.map((event) => event.sendCount)).toEqual([5, 6]);
      expect(formatOperatorDispatchBatch(batch.events)).toContain(
        '### 1/2\n\n対象: https://github.com/example/repo/issues/1 (message-listen-one)\nsendCount: 5',
      );
      const formatted = formatOperatorDispatchBatch(batch.events);
      expect(formatted.indexOf('sendCount: 5')).toBeLessThan(
        formatted.indexOf('sendCount: 6'),
      );
      expect(formatted).toContain('#### inbound\n\ninbound 5');
      expect(formatted).toContain('#### response\n\nresponse 6');

      await pool.acknowledge(batch.events);
      const afterAck = JSON.parse(await readFile(storedPath, 'utf8')) as {
        messageCursors: Record<string, number>;
        pendingReports: unknown[];
      };
      expect(afterAck.messageCursors['message-listen-one']).toBe(6);
      expect(afterAck.pendingReports).toEqual([]);
      await expect(
        pool.unregisterConductorMessageListen('message-listen-one'),
      ).resolves.toBe(true);
      expect(pool.listConductorMessageListens()).toEqual([]);
    } finally {
      pool.close();
    }
  });

  it('uses the configured message debounce for pending watch reports in the same session', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-message-window-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => ({
        sequence: 1,
        openQuestions: [],
        sessionState: {
          current: { statusLine: 'waiting for review', reportedAt: 10 },
          history: [],
        },
      }),
      listConductorMessages: () => [],
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    context.closeServers.push(() => liveServer.close());
    await writeResumeStore('watch-message-window', 1, liveServer.socketPath);

    const dispatchQueue = createOperatorDispatchQueue();
    dispatchQueue.setHold(true);
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      await pool.register('watch-message-window', {
        pollIntervalMs: 60_000,
        debounceMs: 1_000,
      });
      expect(await pool.pollOnce('watch-message-window')).toBe(1);
      expect(dispatchQueue.heldEventCount).toBe(1);
      await pool.registerConductorMessageListen('watch-message-window', {
        messageDebounceMs: 3_000,
      });
      expect(dispatchQueue.setHold(false)).toEqual({
        heldEventCount: 0,
        releasedEventCount: 1,
      });
      const releaseAt = Date.now();
      expect(
        dispatchQueue.takeBatch(
          { continuationConsumed: false },
          releaseAt + 2_999,
        ),
      ).toBeUndefined();
      expect(
        dispatchQueue.takeBatch(
          { continuationConsumed: false },
          releaseAt + 3_000,
        )?.events[0]?.text,
      ).toContain('waiting for review');
    } finally {
      now.mockRestore();
      pool.close();
    }
  });

  it('retains a ready held watch batch after message append and restart', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-ready-replay-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    let messages: Array<{ text: string; inbound: string; at: number; sendCount: number; dispatchSource: string }> = [];
    const server = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => ({
        sequence: 1,
        openQuestions: [],
        sessionState: { current: { statusLine: 'watch first', reportedAt: 1 }, history: [] },
      }),
      listConductorMessages: () => messages,
      answerOpenQuestion: async () => { throw new Error('unused'); },
    });
    context.closeServers.push(() => server.close());
    await writeResumeStore('ready-replay', 1, server.socketPath);
    const queue = createOperatorDispatchQueue();
    queue.setHold(true);
    queue.setConversationHold(true);
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: queue });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      await pool.registerConductorMessageListen('ready-replay', { messageDebounceMs: 10_000 });
      await pool.register('ready-replay', { pollIntervalMs: 60_000, debounceMs: 0 });
      expect(await pool.pollOnce('ready-replay')).toBe(1);
      now.mockReturnValue(12_000);
      messages = [{ text: 'message later', inbound: 'input', at: 12_000, sendCount: 1, dispatchSource: 'operator' }];
      expect(await pool.pollConductorMessagesOnce('ready-replay')).toBe(1);
      queue.setHold(false);
      expect(queue.selectBatch({ continuationConsumed: false })).toBeUndefined();
      queue.setConversationHold(false);
      const batch = queue.selectBatch({ continuationConsumed: false })!;
      expect(batch.events.map((event) => event.type === 'report' ? event.reportType : 'user'))
        .toEqual(['session_state', 'conductor_message']);
      expect(batch.events[0]).toMatchObject({ batchReadyAt: 11_000 });

      pool.close();
      const replayQueue = createOperatorDispatchQueue();
      const replayPool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: replayQueue });
      try {
        const replay = replayQueue.selectBatch({ continuationConsumed: false })!;
        expect(replay.events.map((event) => event.type === 'report' ? event.reportType : 'user'))
          .toEqual(['session_state', 'conductor_message']);
        expect(replay.events[0]).toMatchObject({ batchReadyAt: 11_000 });
        expect(await replayPool.commitBatch(replay)).toBe(true);
        await replayPool.recordRetry!(replay.events, 17_000);
      } finally {
        replayPool.close();
      }
      const retryQueue = createOperatorDispatchQueue();
      const retryPool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue: retryQueue });
      try {
        expect(retryQueue.selectBatch({ continuationConsumed: false }, 16_999)).toBeUndefined();
        expect(retryQueue.selectBatch({ continuationConsumed: false }, 17_000)?.events)
          .toHaveLength(2);
      } finally {
        retryPool.close();
      }
    } finally {
      now.mockRestore();
      pool.close();
    }
  });

  it('recovers from aggregate oversized pages by fetching complete messages in order', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-pages-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const baselineMessage = {
      text: 'baseline',
      inbound: 'baseline inbound',
      at: 1_700_000_000_004,
      sendCount: 4,
    };
    let messages = [baselineMessage];
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      listConductorMessages: () => messages,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    context.closeServers.push(() => liveServer.close());
    await writeResumeStore('message-pages-one', 1, liveServer.socketPath);

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
    try {
      await pool.registerConductorMessageListen('message-pages-one', {
        messageDebounceMs: 0,
      });

      const inbound = 'i'.repeat(300 * 1024);
      messages = [
        baselineMessage,
        ...[5, 6, 7, 8].map((sendCount) => ({
          text: `response ${sendCount}`,
          inbound,
          at: 1_700_000_000_000 + sendCount,
          sendCount,
        })),
      ];

      await expect(
        sendOpenQuestionControlRequest(liveServer.socketPath, {
          method: OPEN_QUESTION_CONTROL_METHODS.conductorMessagesList,
          params: { limit: 1, order: 'asc', after: 4 },
        }),
      ).resolves.toEqual({
        messages: [messages[1]],
        hasMore: true,
      });
      await expect(
        sendOpenQuestionControlRequest(liveServer.socketPath, {
          method: OPEN_QUESTION_CONTROL_METHODS.conductorMessagesList,
          params: { limit: 4, order: 'asc', after: 4 },
        }),
      ).rejects.toMatchObject<Partial<OpenQuestionControlRemoteError>>({
        rpcCode: -32603,
        message: 'Response is too large.',
      });

      await expect(
        pool.pollConductorMessagesOnce('message-pages-one'),
      ).resolves.toBe(4);
      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events.map((event) => event.sendCount)).toEqual([
        5, 6, 7, 8,
      ]);
      expect(batch.events).toHaveLength(4);
      for (const event of batch.events) {
        expect(event.type).toBe('report');
        if (event.type === 'report') {
          expect(event.text).toContain(`#### inbound\n\n${inbound}`);
        }
      }
      const state = JSON.parse(
        await readFile(currentWatchStatePath(context.repoRoot), 'utf8'),
      ) as {
        messageCursors: Record<string, number>;
        pendingReports: Array<{ sendCount?: number }>;
      };
      expect(state.messageCursors['message-pages-one']).toBe(8);
      expect(state.pendingReports.map((report) => report.sendCount)).toEqual([
        5, 6, 7, 8,
      ]);
      await expect(
        pool.pollConductorMessagesOnce('message-pages-one'),
      ).resolves.toBe(0);
      expect(dispatchQueue.pendingEventCount).toBe(0);
    } finally {
      pool.close();
    }
  });

  it('skips one oversized message and continues notifying later messages in order', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-partial-pages-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const baselineMessage = {
      text: 'baseline',
      inbound: 'baseline inbound',
      at: 1_700_000_000_004,
      sendCount: 4,
    };
    let messages = [baselineMessage];
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      listConductorMessages: () => messages,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    context.closeServers.push(() => liveServer.close());
    await writeResumeStore('message-partial-pages', 1, liveServer.socketPath);

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
    try {
      await pool.registerConductorMessageListen('message-partial-pages', {
        messageDebounceMs: 0,
      });
      const inbound = 'i'.repeat(300 * 1024);
      messages = [
        baselineMessage,
        ...[5, 6].map((sendCount) => ({
          text: `response ${sendCount}`,
          inbound,
          at: 1_700_000_000_000 + sendCount,
          sendCount,
        })),
        {
          text: 'single oversized response',
          inbound: 'x'.repeat(1_048_576),
          at: 1_700_000_000_007,
          sendCount: 7,
        },
        {
          text: 'response 8',
          inbound: 'inbound 8',
          at: 1_700_000_000_008,
          sendCount: 8,
        },
      ];

      await expect(
        pool.pollConductorMessagesOnce('message-partial-pages'),
      ).resolves.toBe(4);

      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events.map((event) => event.sendCount)).toEqual([
        5, 6, 7, 8,
      ]);
      const groupedReport = formatOperatorDispatchBatch(batch.events);
      expect(groupedReport).toContain('sendCount: 7');
      expect(groupedReport.indexOf('sendCount: 7')).toBeLessThan(
        groupedReport.indexOf('sendCount: 8'),
      );
      for (const event of batch.events) {
        if (event.type === 'report') {
          if (event.sendCount === 7) {
            expect(event.text).toContain(
              '1件の発言は単独のUDS responseが1 MiBを超えたため読み取れず',
            );
            expect(event.text).toContain('sendCount: 7');
          } else if (event.sendCount === 5 || event.sendCount === 6) {
            expect(event.text).toContain(`#### inbound\n\n${inbound}`);
          } else {
            expect(event.text).toContain('#### inbound\n\ninbound 8');
          }
        }
      }
      const state = JSON.parse(
        await readFile(currentWatchStatePath(context.repoRoot), 'utf8'),
      ) as {
        messageCursors: Record<string, number>;
        pendingReports: Array<{ sendCount?: number }>;
      };
      expect(state.messageCursors['message-partial-pages']).toBe(8);
      expect(state.pendingReports.map((report) => report.sendCount)).toEqual([
        5, 6, 7, 8,
      ]);
      await expect(
        pool.pollConductorMessagesOnce('message-partial-pages'),
      ).resolves.toBe(0);

      messages.push({
        text: 'response 9',
        inbound: 'inbound 9',
        at: 1_700_000_000_009,
        sendCount: 9,
      });
      await expect(
        pool.pollConductorMessagesOnce('message-partial-pages'),
      ).resolves.toBe(1);
      const laterBatch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(laterBatch.events.map((event) => event.sendCount)).toEqual([9]);
      expect(laterBatch.events[0]?.text).toContain('inbound 9');
    } finally {
      pool.close();
    }
  });

  it('keeps oversized warnings in production poll order around readable messages', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-multiple-oversized-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const baselineMessage = {
      text: 'baseline',
      inbound: 'baseline inbound',
      at: 1_700_000_000_004,
      sendCount: 4,
    };
    let messages = [baselineMessage];
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      listConductorMessages: () => messages,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    context.closeServers.push(() => liveServer.close());
    await writeResumeStore(
      'message-multiple-oversized',
      1,
      liveServer.socketPath,
    );

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
    try {
      await pool.registerConductorMessageListen('message-multiple-oversized', {
        messageDebounceMs: 0,
      });
      messages = [
        baselineMessage,
        ...[5, 6].map((sendCount) => ({
          text: `oversized response ${sendCount}`,
          inbound: 'x'.repeat(1_048_576),
          at: 1_700_000_000_000 + sendCount,
          sendCount,
        })),
        {
          text: 'response 7',
          inbound: 'inbound 7',
          at: 1_700_000_000_007,
          sendCount: 7,
        },
        {
          text: 'oversized response 8',
          inbound: 'y'.repeat(1_048_576),
          at: 1_700_000_000_008,
          sendCount: 8,
        },
        {
          text: 'response 9',
          inbound: 'inbound 9',
          at: 1_700_000_000_009,
          sendCount: 9,
        },
      ];

      await expect(
        pool.pollConductorMessagesOnce('message-multiple-oversized'),
      ).resolves.toBe(4);
      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events.map((event) => event.sendCount)).toEqual([
        6, 7, 8, 9,
      ]);
      const warningReports = batch.events.filter(
        (event) =>
          event.type === 'report' &&
          event.text.includes('発言は単独のUDS responseが1 MiBを超えたため読み取れず'),
      );
      expect(warningReports).toHaveLength(2);
      expect(warningReports[0]?.reportId).toBeDefined();
      expect(warningReports[0]?.text).toContain('2件');
      expect(warningReports[0]?.text).toContain('sendCount: 5, 6');
      expect(warningReports[1]?.reportId).toBeDefined();
      expect(warningReports[1]?.text).toContain('1件');
      expect(warningReports[1]?.text).toContain('sendCount: 8');
      expect(new Set(warningReports.map((event) => event.reportId)).size).toBe(2);
      const groupedReport = formatOperatorDispatchBatch(batch.events);
      expect((groupedReport.match(/⚠/g) ?? [])).toHaveLength(2);
      const warningFiveSix = groupedReport.indexOf('sendCount: 5, 6');
      const readableSeven = groupedReport.indexOf('inbound 7');
      const warningEight = groupedReport.indexOf('sendCount: 8');
      const readableNine = groupedReport.indexOf('inbound 9');
      expect(warningFiveSix).toBeGreaterThanOrEqual(0);
      expect(readableSeven).toBeGreaterThan(warningFiveSix);
      expect(warningEight).toBeGreaterThan(readableSeven);
      expect(readableNine).toBeGreaterThan(warningEight);
      expect(batch.events[1]?.text).toContain('inbound 7');
      expect(batch.events[3]?.text).toContain('inbound 9');

      const state = JSON.parse(
        await readFile(currentWatchStatePath(context.repoRoot), 'utf8'),
      ) as {
        messageCursors: Record<string, number>;
        pendingReports: Array<{ reportId: string; sendCount?: number }>;
      };
      expect(state.messageCursors['message-multiple-oversized']).toBe(9);
      expect(state.pendingReports.map((report) => report.sendCount)).toEqual([
        6, 7, 8, 9,
      ]);
      expect(
        new Set(state.pendingReports.map((report) => report.reportId)).size,
      ).toBe(4);
      await pool.acknowledge(batch.events);
      const acknowledgedState = JSON.parse(
        await readFile(currentWatchStatePath(context.repoRoot), 'utf8'),
      ) as { pendingReports: Array<{ reportId: string }> };
      expect(acknowledgedState.pendingReports).toEqual([]);
      await expect(
        pool.pollConductorMessagesOnce('message-multiple-oversized'),
      ).resolves.toBe(0);
    } finally {
      pool.close();
    }
  });

  it('coalesces oversized warnings across polls in one debounce window', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-warning-window-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const baselineMessage = {
      text: 'baseline',
      inbound: 'baseline inbound',
      at: 1_700_000_000_001,
      sendCount: 1,
    };
    let messages = [baselineMessage];
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      listConductorMessages: () => messages,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    context.closeServers.push(() => liveServer.close());
    await writeResumeStore(
      'message-warning-window',
      1,
      liveServer.socketPath,
    );

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
    vi.useFakeTimers();
    try {
      await pool.registerConductorMessageListen('message-warning-window', {
        messageDebounceMs: 10_000,
      });

      messages = [
        baselineMessage,
        {
          text: 'oversized response 2',
          inbound: 'x'.repeat(1_048_576),
          at: 1_700_000_000_002,
          sendCount: 2,
        },
      ];
      await expect(
        pool.pollConductorMessagesOnce('message-warning-window'),
      ).resolves.toBe(1);
      expect(
        dispatchQueue.takeBatch({ continuationConsumed: false }, Date.now()),
      ).toBeUndefined();

      vi.setSystemTime(Date.now() + 5_000);
      messages = [
        ...messages,
        {
          text: 'oversized response 3',
          inbound: 'y'.repeat(1_048_576),
          at: 1_700_000_000_003,
          sendCount: 3,
        },
        {
          text: 'readable response 4',
          inbound: 'readable inbound 4',
          at: 1_700_000_000_004,
          sendCount: 4,
        },
      ];
      await expect(
        pool.pollConductorMessagesOnce('message-warning-window'),
      ).resolves.toBe(2);
      expect(
        dispatchQueue.takeBatch({ continuationConsumed: false }, Date.now()),
      ).toBeUndefined();

      vi.setSystemTime(Date.now() + 10_000);
      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events.map((event) => event.sendCount)).toEqual([2, 3, 4]);
      const formatted = formatOperatorDispatchBatch(batch.events);
      expect((formatted.match(/⚠/g) ?? [])).toHaveLength(1);
      expect(formatted).toContain('2件');
      expect(formatted).toContain('sendCount: 2, 3');
      expect(formatted).toContain('readable inbound 4');
      const state = JSON.parse(
        await readFile(currentWatchStatePath(context.repoRoot), 'utf8'),
      ) as {
        messageCursors: Record<string, number>;
        pendingReports: Array<{ sendCount?: number }>;
      };
      expect(state.messageCursors['message-warning-window']).toBe(4);
      expect(state.pendingReports.map((report) => report.sendCount)).toEqual([
        2, 3, 4,
      ]);
    } finally {
      pool.close();
      vi.useRealTimers();
    }
  });

  it('cleans up the listener and timer when its initial baseline poll fails', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-baseline-error-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      listConductorMessages: () => {
        throw new Error('simulated baseline poll failure');
      },
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    context.closeServers.push(() => liveServer.close());
    await writeResumeStore(
      'message-baseline-error',
      1,
      liveServer.socketPath,
    );

    const errors: string[] = [];
    const pool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
      dispatchQueue: createOperatorDispatchQueue(),
      onError: (message) => errors.push(message),
    });
    vi.useFakeTimers();
    try {
      await expect(
        pool.registerConductorMessageListen('message-baseline-error'),
      ).rejects.toMatchObject<Partial<OpenQuestionControlRemoteError>>({
        rpcCode: -32603,
        message: 'Open Question operation failed.',
      });
      expect(pool.listConductorMessageListens()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      const state = JSON.parse(
        await readFile(currentWatchStatePath(context.repoRoot), 'utf8'),
      ) as {
        messageListeners: Record<string, unknown>;
        messageCursors: Record<string, number>;
      };
      expect(state.messageListeners).toEqual({});
      expect(state.messageCursors).toEqual({});
      await vi.advanceTimersByTimeAsync(2_000);
      expect(errors).toEqual([]);
    } finally {
      pool.close();
      vi.useRealTimers();
    }
  });

  it('uses an oversized-aware silent baseline and then delivers later readable messages', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-oversized-baseline-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    let messages = [5, 6].map((sendCount) => ({
      text: `oversized response ${sendCount}`,
      inbound: 'x'.repeat(1_048_576),
      at: 1_700_000_000_000 + sendCount,
      sendCount,
    }));
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      listConductorMessages: () => messages,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    context.closeServers.push(() => liveServer.close());
    await writeResumeStore(
      'message-oversized-baseline',
      1,
      liveServer.socketPath,
    );

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
    try {
      await expect(
        pool.registerConductorMessageListen('message-oversized-baseline', {
          messageDebounceMs: 0,
        }),
      ).resolves.toMatchObject({
        conductorAgentId: 'message-oversized-baseline',
        messageDebounceMs: 0,
      });
      expect(pool.listConductorMessageListens()).toHaveLength(1);
      expect(dispatchQueue.pendingEventCount).toBe(0);
      const baselineState = JSON.parse(
        await readFile(currentWatchStatePath(context.repoRoot), 'utf8'),
      ) as { messageCursors: Record<string, number> };
      expect(baselineState.messageCursors['message-oversized-baseline']).toBe(6);

      messages = [
        ...messages,
        {
          text: 'later readable response',
          inbound: 'later readable inbound',
          at: 1_700_000_000_007,
          sendCount: 7,
        },
      ];
      await expect(
        pool.pollConductorMessagesOnce('message-oversized-baseline'),
      ).resolves.toBe(1);
      const batch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(batch.events.map((event) => event.sendCount)).toEqual([7]);
      expect(batch.events[0]?.text).toContain('later readable inbound');
      expect(batch.events[0]?.text).not.toContain('sendCount: 5');
      expect(batch.events[0]?.text).not.toContain('sendCount: 6');
      await expect(
        pool.pollConductorMessagesOnce('message-oversized-baseline'),
      ).resolves.toBe(0);
    } finally {
      pool.close();
    }
  });

  it('restores the previous listener config and timer when re-registration polling fails', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-reregister-error-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    let failPolling = false;
    const messages = [{
      text: 'baseline response',
      inbound: 'baseline inbound',
      at: 1_700_000_000_001,
      sendCount: 1,
    }];
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      listConductorMessages: () => {
        if (failPolling) throw new Error('simulated baseline poll failure');
        return messages;
      },
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    context.closeServers.push(() => liveServer.close());
    await writeResumeStore(
      'message-reregister-error',
      1,
      liveServer.socketPath,
    );

    const pool = await createOperatorWatchPool({
      repoRoot: context.repoRoot,
      dispatchQueue: createOperatorDispatchQueue(),
    });
    vi.useFakeTimers();
    try {
      const previousConfig = await pool.registerConductorMessageListen(
        'message-reregister-error',
        { messageDebounceMs: 3_000 },
      );
      expect(vi.getTimerCount()).toBe(1);

      failPolling = true;
      await expect(
        pool.registerConductorMessageListen('message-reregister-error', {
          messageDebounceMs: 9_000,
        }),
      ).rejects.toMatchObject<Partial<OpenQuestionControlRemoteError>>({
        rpcCode: -32603,
        message: 'Open Question operation failed.',
      });

      expect(pool.listConductorMessageListens()).toEqual([previousConfig]);
      expect(vi.getTimerCount()).toBe(1);
      const state = JSON.parse(
        await readFile(currentWatchStatePath(context.repoRoot), 'utf8'),
      ) as {
        messageListeners: Record<string, {
          conductorAgentId: string;
          messageDebounceMs: number;
        }>;
        messageCursors: Record<string, number>;
      };
      expect(state.messageListeners['message-reregister-error']).toEqual(
        previousConfig,
      );
      expect(state.messageCursors['message-reregister-error']).toBe(1);
    } finally {
      pool.close();
      vi.useRealTimers();
    }
  });

  it('does not fall back to saved session YAML when conductor-message UDS is absent', async () => {
    context.repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-message-offline-'));
    await mkdir(join(context.repoRoot, '.ensemble', 'sessions'), { recursive: true });
    await writeResumeStore('offline-message-session', 1);
    await writeOfflineSnapshots('offline-message-session', {
      sequence: 1,
      questions: [],
      statusLine: '保存済み状態',
      reportedAt: 2,
    });
    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({ repoRoot: context.repoRoot, dispatchQueue });
    try {
      await pool.registerConductorMessageListen('offline-message-session', {
        messageDebounceMs: 0,
      });
      await expect(
        pool.pollConductorMessagesOnce('offline-message-session'),
      ).resolves.toBe(0);
      expect(dispatchQueue.pendingEventCount).toBe(0);
      expect(
        JSON.parse(
          await readFile(currentWatchStatePath(context.repoRoot), 'utf8'),
        ).messageCursors['offline-message-session'],
      ).toBeUndefined();
    } finally {
      pool.close();
    }
  });
});
