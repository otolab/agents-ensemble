import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENSEMBLE_CONFIG } from '../config/defaults.js';
import * as issueContextModule from '../github/issue-context.js';
import { OpenQuestionRegistry } from '../escalation/open-question.js';
import { PermissionPipeline } from '../permission/permission-pipeline.js';
import { MAX_TURNS_OPEN_QUESTION_TEXT } from '../escalation/enqueue-max-turns-question.js';
import type { ConductorAgent } from './conductor-agent.js';
import type { ConductorAgentHandle } from './conductor-send-reconnect.js';
import { runConductorSessionDriver } from './conductor-session-driver.js';
import { createSetDispatchHoldTool } from '../dispatch/set-dispatch-hold-tool.js';
import {
  bufferDispatchHoldEvents,
  createDispatchHoldState,
  type DispatchHoldChange,
} from './session/dispatch-hold.js';
import { SessionEventQueue } from './session/session-event-queue.js';

const TEST_ISSUE = {
  owner: 'org',
  repo: 'repo',
  number: 1,
  url: 'https://github.com/org/repo/issues/1',
};

const { mockResume } = vi.hoisted(() => ({
  mockResume: vi.fn(),
}));

vi.mock('./conductor-agent.js', () => ({
  ConductorAgent: {
    resume: mockResume,
  },
}));

function createWorkerSessionStub(runningCount = 0) {
  return {
    runtime: { runningCount },
  };
}

function createDriverOptions(input: {
  eventQueue: SessionEventQueue;
  conductor: ConductorAgent;
  openQuestions?: OpenQuestionRegistry;
  maxTurns?: number;
  runningCount?: number;
  stopOnUnansweredInput?: boolean;
}) {
  const workerDispatches: never[] = [];
  const workerFailures: never[] = [];
  const openQuestions = input.openQuestions ?? new OpenQuestionRegistry();
  const conductorHandle: ConductorAgentHandle = { conductor: input.conductor };

  return {
    issueUrl: TEST_ISSUE.url,
    profile: { workers: [] },
    ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
    conductorHandle,
    sendReconnect: {
      conductorOptions: { cwd: '/repo' },
    },
    eventQueue: input.eventQueue,
    workerSession: createWorkerSessionStub(input.runningCount ?? 0),
    permissionPipeline: new PermissionPipeline({}),
    openQuestions,
    shutdownSignal: new AbortController().signal,
    maxTurns: input.maxTurns ?? 5,
    continueOnConductorError: false,
    stopOnUnansweredInput: input.stopOnUnansweredInput ?? false,
    workerDispatches,
    workerFailures,
    onSendComplete: vi.fn(),
  };
}

async function awaitDriverWithTimeout<T>(
  promise: Promise<T>,
  shutdown: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          shutdown.abort();
          reject(new Error('SessionDriver did not stop within the test timeout'));
        }, 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('runConductorSessionDriver', () => {
  beforeEach(() => {
    vi.spyOn(issueContextModule, 'fetchIssueContext').mockResolvedValue({
      issue: TEST_ISSUE,
      title: 'Test',
      body: 'Test issue body for conductor.',
      state: 'OPEN',
      labels: [],
      comments: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockResume.mockReset();
  });

  it('runs initial send then stops when conductor finishes', async () => {
    const onSendStarted = vi.fn();
    const send = vi.fn().mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });
    const conductor = {
      agentId: 'agent-1',
      send,
      close: vi.fn(),
    } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();

    const result = await runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor }),
      onSendStarted,
    });

    expect(onSendStarted).toHaveBeenCalledWith({
      sendCount: 1,
      dispatchSource: 'initial',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]![0])).toContain('作業フローの連鎖');
    expect(String(send.mock.calls[0]![0])).toContain('Test issue body for conductor.');
    expect(result.sendCount).toBe(1);
    expect(result.stopReason).toBe('completed');
  });

  it('continues after conductor send when outbound worker dispatches have no completions yet', async () => {
    let outboundDispatches = 0;
    const onSendComplete = vi.fn();
    const send = vi.fn().mockImplementation(async () => {
      outboundDispatches = 2;
      return {
        runId: 'run-1',
        status: 'finished',
        result: 'dispatched workers',
      };
    });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();

    const resultPromise = runConductorSessionDriver({
      ...createDriverOptions({
        eventQueue,
        conductor,
        runningCount: 0,
      }),
      resetOutboundDispatchesThisSend: () => {
        outboundDispatches = 0;
      },
      getOutboundDispatchesThisSend: () => outboundDispatches,
      onSendComplete,
      shutdownSignal: shutdown.signal,
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledOnce();
    });
    expect(onSendComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        conductorDispatchesThisTurn: 2,
      }),
    );

    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    shutdown.abort();
    const result = await resultPromise;
    expect(result.stopReason).toBe('interrupted');
  });

  it('stops a one-shot session when the SDK run is cancelled', async () => {
    const holdState = createDispatchHoldState();
    holdState.dispatchHold = true;
    holdState.heldEvents.push({
      type: 'worker.completed',
      result: {
        name: 'implementer',
        acpSessionId: 'sess-1',
        status: 'finished',
        result: 'held result',
      },
    });
    const send = vi.fn().mockResolvedValue({
      runId: 'run-1',
      status: 'cancelled',
      result: 'cancelled by SDK',
    });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();

    const resultPromise = runConductorSessionDriver({
      ...createDriverOptions({
        eventQueue,
        conductor,
        maxTurns: 0,
        stopOnUnansweredInput: true,
      }),
      dispatchHoldState: holdState,
      shutdownSignal: shutdown.signal,
    });
    const result = await awaitDriverWithTimeout(resultPromise, shutdown);

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.lastSendResult.status).toBe('cancelled');
    expect(result.stopReason).toBe('cancelled');
    expect(holdState.heldEvents).toHaveLength(1);
  });

  it('does not wait on held events when a one-shot has an unanswered question', async () => {
    const holdState = createDispatchHoldState();
    holdState.dispatchHold = true;
    holdState.heldEvents.push({
      type: 'worker.completed',
      result: {
        name: 'implementer',
        acpSessionId: 'sess-1',
        status: 'finished',
        result: 'held result',
      },
    });
    const openQuestions = new OpenQuestionRegistry();
    openQuestions.enqueue({
      question: 'Should the one-shot session continue?',
      responseType: 'yes_no',
    });
    const send = vi.fn().mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'needs operator',
    });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();

    const resultPromise = runConductorSessionDriver({
      ...createDriverOptions({
        eventQueue,
        conductor,
        openQuestions,
        maxTurns: 0,
        stopOnUnansweredInput: true,
      }),
      dispatchHoldState: holdState,
      shutdownSignal: shutdown.signal,
    });
    const result = await awaitDriverWithTimeout(resultPromise, shutdown);

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('completed');
    expect(holdState).toMatchObject({ dispatchHold: true });
    expect(holdState.heldEvents).toHaveLength(1);
    expect(openQuestions.openCount).toBe(1);
  });

  it('continues consuming events after the issue loop stops when configured', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'finished',
        result: 'done',
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'github update handled',
      });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();
    const onIssueLoopStop = vi.fn();

    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor }),
      shutdownSignal: shutdown.signal,
      continueAfterIssueLoopStop: true,
      onIssueLoopStop,
    });

    await vi.waitFor(() => expect(onIssueLoopStop).toHaveBeenCalledOnce());
    eventQueue.enqueue({
      type: 'github.update',
      items: [
        {
          id: 'ci:1',
          kind: 'ci.completed',
          summary: 'build passed',
        },
      ],
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(onIssueLoopStop).toHaveBeenCalledTimes(2));
    expect(String(send.mock.calls[1]![0])).toContain('## GitHub 更新');
    expect(String(send.mock.calls[1]![0])).toContain('build passed');

    shutdown.abort();
    const result = await driverPromise;
    expect(result.stopReason).toBe('interrupted');
  });

  it('keeps dispatching permission events after a permission-only turn completes', async () => {
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();
    const firstPermission = {
      type: 'permission.pending' as const,
      permission: {
        id: 'permission-first',
        workerId: 'worker-1',
        createdAt: 1,
        request: { toolName: 'Shell', sessionId: 'sess-1' },
      },
    };
    const secondPermission = {
      type: 'permission.pending' as const,
      permission: {
        id: 'permission-second',
        workerId: 'worker-1',
        createdAt: 2,
        request: { toolName: 'Shell', sessionId: 'sess-1' },
      },
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'finished',
        result: 'done',
      })
      .mockImplementationOnce(async () => {
        // The worker can issue its next permission immediately after the
        // conductor finishes resolving the previous one.
        await Promise.resolve();
        eventQueue.enqueue(secondPermission);
        return {
          runId: 'run-2',
          status: 'finished',
          result: 'permission handled',
        };
      })
      .mockResolvedValueOnce({
        runId: 'run-3',
        status: 'finished',
        result: 'second permission handled',
      });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    let postLoopStops = 0;

    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor, runningCount: 0 }),
      shutdownSignal: shutdown.signal,
      continueAfterIssueLoopStop: true,
      onIssueLoopStop: () => {
        postLoopStops += 1;
        if (postLoopStops === 1) {
          eventQueue.enqueue(firstPermission);
        }
      },
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(String(send.mock.calls[1]![0])).toContain('permission-first');
    expect(String(send.mock.calls[2]![0])).toContain('permission-second');
    expect(postLoopStops).toBeGreaterThanOrEqual(3);

    shutdown.abort();
    const result = await driverPromise;
    expect(result.stopReason).toBe('interrupted');
  });

  it('dispatches operator.message before worker.completed when both are queued', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'running',
        result: 'working',
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'running',
        result: 'operator done',
      })
      .mockResolvedValueOnce({
        runId: 'run-3',
        status: 'finished',
        result: 'worker done',
      });

    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();

    const driverPromise = runConductorSessionDriver(
      createDriverOptions({ eventQueue, conductor, maxTurns: 5 }),
    );

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    eventQueue.enqueue({
      type: 'worker.completed',
      result: {
        name: 'worker',
        acpSessionId: 'sess-1',
        status: 'finished',
        result: 'ok',
      },
    });
    eventQueue.enqueue({
      type: 'operator.message',
      text: 'continue please',
    });

    const result = await driverPromise;

    expect(send).toHaveBeenCalledTimes(3);
    expect(String(send.mock.calls[1]![0])).toContain('continue please');
    expect(String(send.mock.calls[2]![0])).toContain('worker.completed');
    expect(result.sendCount).toBe(3);
    expect(result.autonomousTurns).toBe(1);
    expect(result.stopReason).toBe('completed');
  });

  it('dispatches operator.reconnect without sending it to the conductor', async () => {
    const recoveredSend = vi.fn().mockResolvedValue({
      runId: 'run-2',
      status: 'finished',
      result: 'recovered',
    });
    const initialSend = vi.fn().mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'waiting',
    });
    const oldClose = vi.fn();
    const resumedClose = vi.fn();
    const conductor = {
      agentId: 'agent-1',
      send: initialSend,
      close: oldClose,
    } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();
    const onTransportReconnectAttempt = vi.fn();
    const onTransportReconnectComplete = vi.fn();
    mockResume.mockResolvedValue({
      agentId: 'agent-1',
      send: recoveredSend,
      close: resumedClose,
    });

    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor }),
      shutdownSignal: shutdown.signal,
      continueAfterIssueLoopStop: true,
      sendReconnect: {
        conductorOptions: { cwd: '/repo' },
        onTransportReconnectAttempt,
        onTransportReconnectComplete,
      },
    });

    await vi.waitFor(() => expect(initialSend).toHaveBeenCalledOnce());
    eventQueue.enqueue({ type: 'operator.reconnect' });
    await vi.waitFor(() => expect(mockResume).toHaveBeenCalledOnce());

    expect(oldClose).toHaveBeenCalledOnce();
    expect(mockResume).toHaveBeenCalledWith('agent-1', { cwd: '/repo' });
    expect(onTransportReconnectAttempt).toHaveBeenCalledWith({ agentId: 'agent-1' });
    expect(onTransportReconnectComplete).toHaveBeenCalledWith({
      agentId: 'agent-1',
      success: true,
    });
    expect(initialSend).toHaveBeenCalledOnce();

    eventQueue.enqueue({ type: 'operator.message', text: 'continue after reconnect' });
    await vi.waitFor(() => expect(recoveredSend).toHaveBeenCalledOnce());
    expect(recoveredSend).toHaveBeenCalledWith(
      'continue after reconnect',
      expect.any(Object),
    );

    shutdown.abort();
    const result = await driverPromise;
    expect(result.stopReason).toBe('interrupted');
  });

  it('batches multiple operator messages into one conductor send', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'running',
        result: 'working',
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'operator done',
      });

    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();

    const driverPromise = runConductorSessionDriver(
      createDriverOptions({ eventQueue, conductor, maxTurns: 5 }),
    );

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    eventQueue.enqueue({ type: 'operator.message', text: 'line one' });
    eventQueue.enqueue({ type: 'operator.message', text: 'line two' });

    const result = await driverPromise;

    expect(send).toHaveBeenCalledTimes(2);
    expect(String(send.mock.calls[1]![0])).toContain('## オペレータ入力（2 件）');
    expect(String(send.mock.calls[1]![0])).toContain('line one');
    expect(String(send.mock.calls[1]![0])).toContain('line two');
    expect(result.sendCount).toBe(2);
  });

  it('holds trigger events and flushes them as one mixed batch after release', async () => {
    const holdState = createDispatchHoldState();
    const onSendComplete = vi.fn();
    const eventQueue = new SessionEventQueue();
    const holdChanges: Array<{ status: string; hold: boolean; count: number }> = [];
    const recordHoldChange = (change: DispatchHoldChange) => {
      holdChanges.push({
        status: change.status,
        hold: change.hold,
        count: change.heldEventCount,
      });
    };
    const holdTool = createSetDispatchHoldTool({
      state: holdState,
      onChanged: recordHoldChange,
      onBeforeRelease: () =>
        bufferDispatchHoldEvents({
          state: holdState,
          eventQueue,
          onChanged: recordHoldChange,
        }),
    });
    const send = vi
      .fn()
      .mockImplementationOnce(async () => {
        await holdTool.set_dispatch_hold!.execute({ hold: true });
        return {
          runId: 'run-1',
          status: 'running',
          result: 'holding',
        };
      })
      .mockImplementationOnce(async (message: string) => {
        expect(message).toBe('operator can still interrupt');
        await holdTool.set_dispatch_hold!.execute({ hold: false });
        return {
          runId: 'run-2',
          status: 'running',
          result: 'released',
        };
      })
      .mockResolvedValueOnce({
        runId: 'run-3',
        status: 'finished',
        result: 'flushed',
      });

    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor, maxTurns: 5 }),
      dispatchHoldState: holdState,
      onDispatchHoldChanged: recordHoldChange,
      onSendComplete,
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    eventQueue.enqueue({
      type: 'worker.completed',
      result: {
        name: 'implementer',
        acpSessionId: 'sess-1',
        status: 'finished',
        result: 'done',
      },
    });
    eventQueue.enqueue({
      type: 'worker.failed',
      failure: {
        name: 'reviewer',
        kind: 'reviewer',
        error: 'failed',
      },
    });

    await vi.waitFor(() => expect(holdState.heldEvents).toHaveLength(2));
    eventQueue.enqueue({
      type: 'operator.message',
      text: 'operator can still interrupt',
    });

    const result = await driverPromise;

    expect(send).toHaveBeenCalledTimes(3);
    expect(String(send.mock.calls[2]![0])).toContain('## worker 通知（implementer・2 件）');
    expect(String(send.mock.calls[2]![0])).toContain('worker.completed');
    expect(String(send.mock.calls[2]![0])).toContain('worker.failed');
    expect(holdState).toEqual({ dispatchHold: false, heldEvents: [] });
    expect(holdChanges).toEqual([
      { status: 'enabled', hold: true, count: 0 },
      { status: 'updated', hold: true, count: 2 },
      { status: 'released', hold: false, count: 2 },
      { status: 'updated', hold: false, count: 0 },
    ]);
    expect(onSendComplete.mock.calls.map(([info]) => info.autonomousTurns)).toEqual([
      1,
      0,
      1,
    ]);
    expect(onSendComplete.mock.calls[2]?.[0]).toMatchObject({
      workerDispatches: 1,
      workerFailures: 1,
    });
    expect(result.autonomousTurns).toBe(1);
  });

  it('collects queued triggers before an in-flight release and flushes one mixed batch', async () => {
    const holdState = createDispatchHoldState();
    const eventQueue = new SessionEventQueue();
    const holdChanges: DispatchHoldChange[] = [];
    let releaseResult: { structuredContent?: unknown } | undefined;
    const holdTool = createSetDispatchHoldTool({
      state: holdState,
      onChanged: (change) => holdChanges.push(change),
      onBeforeRelease: () =>
        bufferDispatchHoldEvents({
          state: holdState,
          eventQueue,
          onChanged: (change) => holdChanges.push(change),
        }),
    });
    const onSendComplete = vi.fn();
    const send = vi
      .fn()
      .mockImplementationOnce(async () => {
        await holdTool.set_dispatch_hold!.execute({ hold: true });
        eventQueue.enqueue({
          type: 'worker.completed',
          result: {
            name: 'implementer',
            acpSessionId: 'sess-1',
            status: 'finished',
            result: 'done',
          },
        });
        eventQueue.enqueue({
          type: 'worker.failed',
          failure: {
            name: 'reviewer',
            kind: 'reviewer',
            error: 'failed',
          },
        });
        releaseResult = await holdTool.set_dispatch_hold!.execute({ hold: false });
        return {
          runId: 'run-1',
          status: 'running',
          result: 'holding and releasing',
        };
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'flushed',
      });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;

    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor, maxTurns: 5 }),
      dispatchHoldState: holdState,
      onDispatchHoldChanged: (change) => holdChanges.push(change),
      onSendComplete,
    });

    const result = await driverPromise;

    expect(send).toHaveBeenCalledTimes(2);
    expect(String(send.mock.calls[1]![0])).toContain('## worker 通知（implementer・2 件）');
    expect(String(send.mock.calls[1]![0])).toContain('worker.completed');
    expect(String(send.mock.calls[1]![0])).toContain('worker.failed');
    expect(releaseResult?.structuredContent).toEqual({
      dispatchHold: false,
      flushedEventCount: 2,
      sendScheduled: true,
    });
    expect(holdChanges).toEqual([
      { status: 'enabled', hold: true, heldEventCount: 0 },
      { status: 'updated', hold: true, heldEventCount: 2 },
      {
        status: 'released',
        hold: false,
        heldEventCount: 2,
        flushedEventCount: 2,
      },
      { status: 'updated', hold: false, heldEventCount: 0 },
    ]);
    expect(onSendComplete.mock.calls.map(([info]) => info.autonomousTurns)).toEqual([1, 2]);
    expect(onSendComplete.mock.calls[1]?.[0]).toMatchObject({
      workerDispatches: 1,
      workerFailures: 1,
    });
    expect(result.autonomousTurns).toBe(2);
    expect(holdState).toEqual({ dispatchHold: false, heldEvents: [] });
  });

  it('holds permission.pending with trigger events and flushes it after release', async () => {
    const holdState = createDispatchHoldState();
    const holdChanges: DispatchHoldChange[] = [];
    const holdTool = createSetDispatchHoldTool({
      state: holdState,
      onChanged: (change) => holdChanges.push(change),
    });
    const send = vi
      .fn()
      .mockImplementationOnce(async () => {
        await holdTool.set_dispatch_hold!.execute({ hold: true });
        return { runId: 'run-1', status: 'running', result: 'holding' };
      })
      .mockImplementationOnce(async (message: string) => {
        expect(message).toBe('operator can still interrupt');
        await holdTool.set_dispatch_hold!.execute({ hold: false });
        return { runId: 'run-2', status: 'running', result: 'released' };
      })
      .mockResolvedValueOnce({ runId: 'run-3', status: 'finished', result: 'flushed' });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();

    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor, maxTurns: 5 }),
      dispatchHoldState: holdState,
      onDispatchHoldChanged: (change) => holdChanges.push(change),
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    eventQueue.enqueue({
      type: 'worker.completed',
      result: {
        name: 'implementer',
        acpSessionId: 'sess-1',
        status: 'finished',
        result: 'done',
      },
    });
    await vi.waitFor(() => expect(holdState.heldEvents).toHaveLength(1));
    eventQueue.enqueue({
      type: 'permission.pending',
      permission: {
        id: 'permission-1',
        workerId: 'worker-1',
        createdAt: 1,
        request: { toolName: 'Shell', sessionId: 'sess-1' },
      },
    });

    await vi.waitFor(() => expect(holdState.heldEvents).toHaveLength(2));
    expect(send).toHaveBeenCalledTimes(1);
    eventQueue.enqueue({
      type: 'operator.message',
      text: 'operator can still interrupt',
    });

    const result = await driverPromise;

    expect(send).toHaveBeenCalledTimes(3);
    expect(String(send.mock.calls[1]![0])).toBe('operator can still interrupt');
    expect(String(send.mock.calls[2]![0])).toContain('worker.completed');
    expect(String(send.mock.calls[2]![0])).toContain('permission.pending');
    expect(holdChanges).toEqual([
      { status: 'enabled', hold: true, heldEventCount: 0 },
      { status: 'updated', hold: true, heldEventCount: 1 },
      { status: 'updated', hold: true, heldEventCount: 2 },
      {
        status: 'released',
        hold: false,
        heldEventCount: 2,
        flushedEventCount: 2,
      },
      { status: 'updated', hold: false, heldEventCount: 0 },
    ]);
    expect(holdState).toEqual({ dispatchHold: false, heldEvents: [] });
    expect(result.sendCount).toBe(3);
  });

  it('flushes held permission before max-turns-blocked worker events after release', async () => {
    const holdState = createDispatchHoldState();
    const eventQueue = new SessionEventQueue();
    const holdChanges: DispatchHoldChange[] = [];
    let releaseResult: { structuredContent?: unknown } | undefined;
    const holdTool = createSetDispatchHoldTool({
      state: holdState,
      onChanged: (change) => holdChanges.push(change),
      onBeforeRelease: () =>
        bufferDispatchHoldEvents({
          state: holdState,
          eventQueue,
          onChanged: (change) => holdChanges.push(change),
        }),
    });
    const send = vi
      .fn()
      .mockImplementationOnce(async () => {
        await holdTool.set_dispatch_hold!.execute({ hold: true });
        eventQueue.enqueue({
          type: 'worker.completed',
          result: {
            name: 'implementer',
            acpSessionId: 'sess-1',
            status: 'finished',
            result: 'done',
          },
        });
        eventQueue.enqueue({
          type: 'permission.pending',
          permission: {
            id: 'permission-1',
            workerId: 'worker-1',
            createdAt: 1,
            request: { toolName: 'Shell', sessionId: 'sess-1' },
          },
        });
        releaseResult = await holdTool.set_dispatch_hold!.execute({ hold: false });
        return { runId: 'run-1', status: 'running', result: 'holding' };
      })
      .mockImplementationOnce(async (message: string) => {
        expect(message).toContain('permission.pending');
        expect(message).not.toContain('worker.completed');
        return { runId: 'run-2', status: 'running', result: 'permission handled' };
      })
      .mockImplementationOnce(async (message: string) => {
        expect(message).toBe('operator resumes');
        return { runId: 'run-3', status: 'running', result: 'turns reset' };
      })
      .mockImplementationOnce(async (message: string) => {
        expect(message).toContain('worker.completed');
        return { runId: 'run-4', status: 'finished', result: 'worker flushed' };
      });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const openQuestions = new OpenQuestionRegistry();
    const shutdown = new AbortController();

    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor, maxTurns: 1, openQuestions }),
      dispatchHoldState: holdState,
      onDispatchHoldChanged: (change) => holdChanges.push(change),
      shutdownSignal: shutdown.signal,
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
      expect(holdState.heldEvents).toHaveLength(1);
    });
    expect(String(send.mock.calls[1]![0])).toContain('permission.pending');
    expect(String(send.mock.calls[1]![0])).not.toContain('worker.completed');
    expect(releaseResult?.structuredContent).toEqual({
      dispatchHold: false,
      flushedEventCount: 2,
      sendScheduled: true,
    });
    expect(holdChanges).toEqual([
      { status: 'enabled', hold: true, heldEventCount: 0 },
      { status: 'updated', hold: true, heldEventCount: 2 },
      {
        status: 'released',
        hold: false,
        heldEventCount: 2,
        flushedEventCount: 2,
      },
      { status: 'updated', hold: false, heldEventCount: 1 },
    ]);

    const maxTurnsQuestion = openQuestions.listOpen().find(
      (question) => question.source === 'max_turns',
    );
    expect(maxTurnsQuestion).toBeDefined();
    openQuestions.answer(maxTurnsQuestion!.id, {
      answer: 'go ahead',
      answeredBy: 'operator',
    });
    eventQueue.enqueue({ type: 'operator.message', text: 'operator resumes' });
    const result = await driverPromise;

    expect(send).toHaveBeenCalledTimes(4);
    expect(String(send.mock.calls[2]![0])).toBe('operator resumes');
    expect(String(send.mock.calls[3]![0])).toContain('worker.completed');
    expect(holdState).toEqual({ dispatchHold: false, heldEvents: [] });
    expect(holdChanges.at(-1)).toEqual({
      status: 'updated',
      hold: false,
      heldEventCount: 0,
    });
    expect(result.stopReason).toBe('completed');
  });

  it('reports autonomousTurns on each send complete', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'running',
        result: 'working',
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'done',
      });

    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const autonomousTurnsTrace: number[] = [];

    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor, maxTurns: 5 }),
      onSendComplete: (info) => {
        autonomousTurnsTrace.push(info.autonomousTurns);
      },
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    eventQueue.enqueue({
      type: 'operator.message',
      text: 'continue',
    });

    await driverPromise;

    expect(autonomousTurnsTrace).toEqual([1, 0]);
  });

  it('blocks worker.completed at max turns until operator.message', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'running',
        result: 'working',
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'operator resumed',
      });

    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const openQuestions = new OpenQuestionRegistry();

    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor, openQuestions, maxTurns: 1 }),
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    eventQueue.enqueue({
      type: 'worker.completed',
      result: {
        name: 'worker',
        acpSessionId: 'sess-1',
        status: 'finished',
        result: 'late worker',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).toHaveBeenCalledTimes(1);

    const maxTurnsQuestion = openQuestions.listOpen().find(
      (question) => question.source === 'max_turns',
    );
    openQuestions.answer(maxTurnsQuestion!.id, {
      answer: 'go ahead',
      answeredBy: 'operator',
    });
    eventQueue.enqueue({
      type: 'operator.message',
      text: 'go ahead',
    });

    const result = await driverPromise;

    expect(send).toHaveBeenCalledTimes(2);
    expect(String(send.mock.calls[1]![0])).toContain('go ahead');
    expect(result.autonomousTurns).toBe(0);
    expect(result.stopReason).toBe('completed');
  });

  it('dispatches operator.message at max turns after registering max-turns question', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'running',
        result: 'working',
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'operator resumed',
      });

    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const openQuestions = new OpenQuestionRegistry();
    const onOpenQuestionEnqueued = vi.fn();

    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor, openQuestions, maxTurns: 1 }),
      onOpenQuestionEnqueued,
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(onOpenQuestionEnqueued).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'max_turns',
        question: MAX_TURNS_OPEN_QUESTION_TEXT,
      }),
    );

    const maxTurnsQuestion = openQuestions.listOpen().find(
      (question) => question.source === 'max_turns',
    );
    openQuestions.answer(maxTurnsQuestion!.id, {
      answer: 'go ahead',
      answeredBy: 'operator',
    });
    eventQueue.enqueue({
      type: 'operator.message',
      text: 'go ahead',
    });

    const result = await driverPromise;

    expect(send).toHaveBeenCalledTimes(2);
    expect(String(send.mock.calls[1]![0])).toContain('go ahead');
    expect(result.autonomousTurns).toBe(0);
    expect(result.stopReason).toBe('completed');
  });

  it('stops with interrupted when shutdown signal aborts', async () => {
    const send = vi.fn().mockResolvedValue({
      runId: 'run-1',
      status: 'running',
      result: 'working',
    });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();

    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor }),
      shutdownSignal: shutdown.signal,
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    shutdown.abort();

    const result = await driverPromise;
    expect(result.stopReason).toBe('interrupted');
  });

  it('stops with interrupted when shutdown aborts during in-flight conductor send', async () => {
    let resolveSlowSend!: (value: {
      runId: string;
      status: string;
      result: string;
    }) => void;
    const slowSend = new Promise<{
      runId: string;
      status: string;
      result: string;
    }>((resolve) => {
      resolveSlowSend = resolve;
    });

    const send = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'finished',
        result: 'done',
      })
      .mockReturnValueOnce(slowSend);

    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();

    eventQueue.enqueue({
      type: 'operator.message',
      text: 'continue',
    });

    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor }),
      shutdownSignal: shutdown.signal,
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    shutdown.abort();

    const result = await driverPromise;
    expect(result.stopReason).toBe('interrupted');

    resolveSlowSend({
      runId: 'run-2',
      status: 'finished',
      result: 'late',
    });
  });

  it('dispatches worker.completed without limit when maxTurns is unlimited', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'running',
        result: 'working',
      })
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'done',
      });

    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const openQuestions = new OpenQuestionRegistry();
    const onOpenQuestionEnqueued = vi.fn();

    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({
        eventQueue,
        conductor,
        openQuestions,
        maxTurns: 0,
      }),
      onOpenQuestionEnqueued,
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    eventQueue.enqueue({
      type: 'worker.completed',
      result: {
        name: 'worker',
        acpSessionId: 'sess-1',
        status: 'finished',
        result: 'ok',
      },
    });

    const result = await driverPromise;

    expect(send).toHaveBeenCalledTimes(2);
    expect(onOpenQuestionEnqueued).not.toHaveBeenCalled();
    expect(openQuestions.listOpen()).toEqual([]);
    expect(result.autonomousTurns).toBe(2);
    expect(result.stopReason).toBe('completed');
  });

  it('emits started → progress → completed in order', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'running',
        result: 'working',
      })
      .mockImplementationOnce(async (_message, callbacks) => {
        callbacks?.onToolCallStarted?.({
          runId: 'run-2',
          tool: 'shell',
          callId: 'call-1',
        });
        return {
          runId: 'run-2',
          status: 'finished',
          result: 'done',
        };
      });

    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const lifecycle: string[] = [];

    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor, maxTurns: 5 }),
      onSendStarted: () => {
        lifecycle.push('started');
      },
      onSendProgress: () => {
        lifecycle.push('progress');
      },
      onSendComplete: () => {
        lifecycle.push('completed');
      },
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    lifecycle.push('after-initial-started');

    eventQueue.enqueue({
      type: 'operator.message',
      text: 'continue',
    });

    await driverPromise;

    expect(lifecycle).toEqual([
      'started',
      'completed',
      'after-initial-started',
      'started',
      'progress',
      'completed',
    ]);
  });

  it('does not start a second dispatch while conductor send is in-flight', async () => {
    let resolveSecondSend!: (value: {
      runId: string;
      status: string;
      result: string;
    }) => void;
    const secondSendPromise = new Promise<{
      runId: string;
      status: string;
      result: string;
    }>((resolve) => {
      resolveSecondSend = resolve;
    });

    const send = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-1',
        status: 'running',
        result: 'working',
      })
      .mockReturnValueOnce(secondSendPromise)
      .mockResolvedValueOnce({
        runId: 'run-3',
        status: 'finished',
        result: 'done',
      });

    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();

    const driverPromise = runConductorSessionDriver(
      createDriverOptions({ eventQueue, conductor, maxTurns: 5 }),
    );

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    eventQueue.enqueue({ type: 'operator.message', text: 'first while in-flight' });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenCalledTimes(2);

    eventQueue.enqueue({ type: 'operator.message', text: 'second after first completes' });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).toHaveBeenCalledTimes(2);

    resolveSecondSend({
      runId: 'run-2',
      status: 'running',
      result: 'still working',
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    await driverPromise;
  });

  it('does not dispatch permission.pending until the initial send completes', async () => {
    let resolveInitialSend!: (value: {
      runId: string;
      status: 'running';
      result: string;
    }) => void;
    const initialSend = new Promise<{
      runId: string;
      status: 'running';
      result: string;
    }>((resolve) => {
      resolveInitialSend = resolve;
    });
    const send = vi
      .fn()
      .mockReturnValueOnce(initialSend)
      .mockResolvedValueOnce({
        runId: 'run-2',
        status: 'finished',
        result: 'permission handled',
      });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();

    const driverPromise = runConductorSessionDriver(
      createDriverOptions({ eventQueue, conductor, maxTurns: 5 }),
    );

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    eventQueue.enqueue({
      type: 'permission.pending',
      permission: {
        id: 'permission-initial-send',
        workerId: 'worker-1',
        createdAt: 1,
        request: { toolName: 'Shell', sessionId: 'sess-1' },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).toHaveBeenCalledTimes(1);

    resolveInitialSend({
      runId: 'run-1',
      status: 'running',
      result: 'initial send completed',
    });

    const result = await driverPromise;

    expect(send).toHaveBeenCalledTimes(2);
    expect(String(send.mock.calls[1]![0])).toContain('permission.pending');
    expect(result.stopReason).toBe('completed');
  });

  it('dispatches queued permission.pending immediately when the initial send is skipped', async () => {
    const send = vi.fn().mockResolvedValue({
      runId: 'run-permission',
      status: 'finished',
      result: 'permission handled',
    });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    eventQueue.enqueue({
      type: 'permission.pending',
      permission: {
        id: 'permission-resume',
        workerId: 'worker-1',
        createdAt: 1,
        request: { toolName: 'Shell', sessionId: 'sess-1' },
      },
    });

    const result = await runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor, maxTurns: 5 }),
      skipInitialSend: true,
    });

    expect(send).toHaveBeenCalledOnce();
    expect(String(send.mock.calls[0]![0])).toContain('permission.pending');
    expect(result.sendCount).toBe(1);
    expect(result.stopReason).toBe('completed');
  });
});
