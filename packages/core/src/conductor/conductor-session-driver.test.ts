import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenQuestionRegistry } from '../escalation/open-question.js';
import { PermissionPipeline } from '../permission/permission-pipeline.js';
import { MAX_TURNS_OPEN_QUESTION_TEXT } from '../escalation/enqueue-max-turns-question.js';
import type { ConductorAgent } from './conductor-agent.js';
import type { ConductorAgentHandle } from './conductor-send-reconnect.js';
import type { CursorBootstrapState } from './cursor-bootstrap-state.js';
import { ConductorDispatchLifecycle } from './conductor-dispatch-lifecycle.js';
import { ConductorRecoveryInbox } from './conductor-recovery-inbox.js';
import { runConductorSessionDriver } from './conductor-session-driver.js';
import { createSetDispatchHoldTool } from '../dispatch/set-dispatch-hold-tool.js';
import {
  bufferDispatchHoldEvents,
  createDispatchHoldState,
  pruneStalePermissionEvents,
  type DispatchHoldChange,
} from './session/dispatch-hold.js';
import { SessionEventQueue } from './session/session-event-queue.js';

const TEST_ISSUE = {
  owner: 'org',
  repo: 'repo',
  number: 1,
  url: 'https://github.com/org/repo/issues/1',
};

const PI_API_KEY_RESOLUTION_ERROR =
  'API key auth failed for provider litellm: Failed to resolve API key for provider "litellm" from shell command: cached-auth.mjs -- gcloud auth print-identity-token';

const { mockResume, mockCreate } = vi.hoisted(() => ({
  mockResume: vi.fn(),
  mockCreate: vi.fn(),
}));

function createWorkerSessionStub(runningCount = 0) {
  return {
    runtime: { runningCount },
    inbox: { drain: vi.fn().mockResolvedValue(undefined) },
  };
}

function createDriverOptions(input: {
  eventQueue: SessionEventQueue;
  conductor: ConductorAgent;
  openQuestions?: OpenQuestionRegistry;
  permissionPipeline?: PermissionPipeline;
  isPermissionPending?: (requestId: string) => boolean;
  maxTurns?: number;
  runningCount?: number;
  stopOnUnansweredInput?: boolean;
  initialPrompt?: string;
}) {
  const workerDispatches: never[] = [];
  const workerFailures: never[] = [];
  const openQuestions = input.openQuestions ?? new OpenQuestionRegistry();
  const permissionPipeline = input.permissionPipeline ?? new PermissionPipeline({});
  const conductorHandle: ConductorAgentHandle = { conductor: input.conductor };

  return {
    issueUrl: TEST_ISSUE.url,
    initialPrompt: input.initialPrompt ?? 'compiled conductor system prompt',
    conductorHandle,
    sendReconnect: {
      conductorAgentFactory: { create: mockCreate, resume: mockResume },
      conductorOptions: { cwd: '/repo', systemPrompt: 'compiled conductor system prompt' },
    },
    eventQueue: input.eventQueue,
    workerSession: createWorkerSessionStub(input.runningCount ?? 0),
    permissionPipeline,
    ...(input.isPermissionPending
      ? { isPermissionPending: input.isPermissionPending }
      : {}),
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

function createPendingPermissionEvent(
  pipeline: PermissionPipeline,
  id: string,
  workerId = 'worker-1',
) {
  pipeline.evaluate(id, workerId, {
    toolName: 'Shell',
    sessionId: 'sess-1',
  });
  return {
    type: 'permission.pending' as const,
    permission: pipeline.pending.get(id)!,
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
  afterEach(() => {
    mockResume.mockReset();
    mockCreate.mockReset();
  });

  it('runs initial send then stops when conductor finishes', async () => {
    const onSendStarted = vi.fn();
    const onConductorInbound = vi.fn();
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
      onConductorInbound,
      onSendStarted,
    });

    expect(onConductorInbound).toHaveBeenCalledWith({
      triggers: 1,
      sources: ['initial'],
    });

    expect(onSendStarted).toHaveBeenCalledWith({
      sendCount: 1,
      dispatchSource: 'initial',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe('compiled conductor system prompt');
    expect(result.sendCount).toBe(1);
    expect(result.stopReason).toBe('completed');
  });

  it('summarizes the sources of a regular conductor inbound batch', async () => {
    const send = vi.fn().mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    eventQueue.enqueue({ type: 'operator.message', text: 'next' });
    const onConductorInbound = vi.fn();

    await runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor }),
      onConductorInbound,
    });

    expect(onConductorInbound).toHaveBeenNthCalledWith(1, {
      triggers: 1,
      sources: ['initial'],
    });
    expect(onConductorInbound).toHaveBeenNthCalledWith(2, {
      triggers: 1,
      sources: ['operator'],
    });
  });

  it('forwards a short backend-specific kickoff without modifying it', async () => {
    const send = vi.fn().mockResolvedValue({
      runId: 'run-pi-kickoff',
      status: 'finished',
      result: 'started',
    });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const kickoff = `Start the conductor workflow for ${TEST_ISSUE.url}.`;

    await runConductorSessionDriver({
      ...createDriverOptions({
        eventQueue: new SessionEventQueue(),
        conductor,
        initialPrompt: kickoff,
      }),
    });

    expect(send).toHaveBeenCalledWith(kickoff, expect.any(Object));
  });

  it('drains worker outcome notifications before stopping on an idle queue', async () => {
    const send = vi.fn().mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    eventQueue.enqueue({
      type: 'worker.failed',
      failure: {
        workerId: 'worker-failed',
        name: 'fail-1',
        kind: 'fail',
        error: 'attach failed',
        issueUrl: TEST_ISSUE.url,
      },
    });

    let drainCount = 0;
    const inbox = {
      drain: vi.fn(async () => {
        drainCount += 1;
        if (drainCount === 1) {
          eventQueue.enqueue({
            type: 'worker.completed',
            result: {
              name: 'ping-1',
              kind: 'ping',
              issue: TEST_ISSUE,
              worktree: {
                path: '/tmp/wt',
                branch: 'ensemble/issue-1',
                issue: TEST_ISSUE,
              },
              prompt: 'done',
              promptResult: { stopReason: 'end_turn' },
              acpSessionId: 'sess-1',
              source: 'harness',
            },
          });
        }
      }),
    };
    const options = createDriverOptions({ eventQueue, conductor });
    options.workerSession.inbox = inbox;

    const result = await runConductorSessionDriver(options);

    expect(send).toHaveBeenCalledTimes(3);
    expect(String(send.mock.calls[1]![0])).toContain('worker.failed');
    expect(String(send.mock.calls[2]![0])).toContain('worker.completed');
    expect(inbox.drain).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe('completed');
  });

  it('dispatches late worker outcomes before stopping a one-shot session', async () => {
    const eventQueue = new SessionEventQueue();
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
        result: 'worker outcomes delivered',
      });
    const inbox = {
      drain: vi.fn().mockImplementationOnce(async () => {
        await Promise.resolve();
        eventQueue.enqueue({
          type: 'worker.completed',
          result: {
            name: 'late-worker',
            kind: 'implementer',
            issue: TEST_ISSUE,
            worktree: {
              path: '/tmp/wt',
              branch: 'ensemble/issue-1',
              issue: TEST_ISSUE,
            },
            prompt: 'done',
            promptResult: { stopReason: 'end_turn' },
            acpSessionId: 'sess-completed',
            source: 'harness',
          },
        });
        eventQueue.enqueue({
          type: 'worker.failed',
          failure: {
            name: 'late-worker',
            kind: 'implementer',
            error: 'late failure',
          },
        });
      }).mockResolvedValueOnce(undefined),
    };
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const options = createDriverOptions({
      eventQueue,
      conductor,
      stopOnUnansweredInput: true,
    });
    options.workerSession.inbox = inbox;

    expect(eventQueue.isEmpty()).toBe(true);

    const result = await runConductorSessionDriver(options);

    expect(send).toHaveBeenCalledTimes(2);
    expect(inbox.drain).toHaveBeenCalledTimes(2);
    expect(String(send.mock.calls[1]![0])).toContain('worker.completed');
    expect(String(send.mock.calls[1]![0])).toContain('worker.failed');
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

  it('reports only the GitHub update IDs included in each completed send', async () => {
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();
    const onSendComplete = vi.fn();
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
    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor }),
      shutdownSignal: shutdown.signal,
      continueAfterIssueLoopStop: true,
      onSendComplete,
    });

    await vi.waitFor(() =>
      expect(onSendComplete).toHaveBeenCalledWith(
        expect.objectContaining({ sendCount: 1, githubUpdateIds: [] }),
      ),
    );
    eventQueue.enqueue({
      type: 'github.update',
      items: [
        { id: 'review:10', kind: 'pr.review', summary: 'review' },
        { id: 'ci:sha-1:failed', kind: 'ci.completed', summary: 'failed' },
      ],
    });
    await vi.waitFor(() =>
      expect(onSendComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          sendCount: 2,
          githubUpdateIds: ['review:10', 'ci:sha-1:failed'],
        }),
      ),
    );

    shutdown.abort();
    await driverPromise;
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

  it('does not dispatch a cleanup-stale permission before worker.failed', async () => {
    const eventQueue = new SessionEventQueue();
    const permissionPipeline = new PermissionPipeline({
      policy: { allowTools: [], allowReadOnlyTools: false },
    });
    const stalePermission = createPendingPermissionEvent(
      permissionPipeline,
      'permission-stale-queued',
    );
    permissionPipeline.pending.take(stalePermission.permission.id);
    eventQueue.enqueue(stalePermission);
    eventQueue.enqueue({
      type: 'worker.failed',
      failure: {
        workerId: 'worker-1',
        name: 'worker-1',
        kind: 'implementer',
        error: 'worker failed',
        issueUrl: TEST_ISSUE.url,
      },
    });
    const send = vi.fn().mockResolvedValue({
      runId: 'run-failure',
      status: 'finished',
      result: 'failure handled',
    });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;

    await runConductorSessionDriver({
      ...createDriverOptions({
        eventQueue,
        conductor,
        permissionPipeline,
        isPermissionPending: (id) => permissionPipeline.pending.get(id) !== undefined,
      }),
      skipInitialSend: true,
    });

    expect(send).toHaveBeenCalledOnce();
    expect(String(send.mock.calls[0]![0])).toContain('worker.failed');
    expect(String(send.mock.calls[0]![0])).not.toContain('permission-stale-queued');
  });

  it('prunes a permission cleaned during held release while preserving worker.failed', async () => {
    const eventQueue = new SessionEventQueue();
    const holdState = createDispatchHoldState();
    holdState.dispatchHold = true;
    const permissionPipeline = new PermissionPipeline({
      policy: { allowTools: [], allowReadOnlyTools: false },
    });
    const stalePermission = createPendingPermissionEvent(
      permissionPipeline,
      'permission-stale-held',
    );
    holdState.heldEvents.push(stalePermission, {
      type: 'worker.failed',
      failure: {
        workerId: 'worker-1',
        name: 'worker-1',
        kind: 'implementer',
        error: 'worker failed',
        issueUrl: TEST_ISSUE.url,
      },
    });
    eventQueue.enqueue({ type: 'operator.message', text: 'release' });

    const holdTool = createSetDispatchHoldTool({
      state: holdState,
      onBeforeRelease: () => {
        permissionPipeline.pending.take(stalePermission.permission.id);
        pruneStalePermissionEvents({
          state: holdState,
          eventQueue,
          isPermissionPending: (id) =>
            permissionPipeline.pending.get(id) !== undefined,
        });
      },
    });
    const send = vi.fn().mockImplementation(async (message: string) => {
      if (message === 'release') {
        await holdTool.set_dispatch_hold!.execute({ hold: false });
      }
      return {
        runId: `run-${send.mock.calls.length}`,
        status: message === 'release' ? 'running' : 'finished',
        result: message,
      };
    });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;

    await runConductorSessionDriver({
      ...createDriverOptions({
        eventQueue,
        conductor,
        permissionPipeline,
        isPermissionPending: (id) => permissionPipeline.pending.get(id) !== undefined,
      }),
      dispatchHoldState: holdState,
      skipInitialSend: true,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(String(send.mock.calls[0]![0])).toBe('release');
    expect(String(send.mock.calls[1]![0])).toContain('worker.failed');
    expect(String(send.mock.calls[1]![0])).not.toContain('permission-stale-held');
    expect(holdState.heldEvents).toEqual([]);
  });

  it('does not rescue a cleanup-stale permission from held max-turns events', async () => {
    const eventQueue = new SessionEventQueue();
    const holdState = createDispatchHoldState();
    const permissionPipeline = new PermissionPipeline({
      policy: { allowTools: [], allowReadOnlyTools: false },
    });
    const stalePermission = createPendingPermissionEvent(
      permissionPipeline,
      'permission-stale-max-turns',
    );
    const livePermission = createPendingPermissionEvent(
      permissionPipeline,
      'permission-live-max-turns',
    );
    permissionPipeline.pending.take(stalePermission.permission.id);
    holdState.heldEvents.push(
      stalePermission,
      livePermission,
      {
        type: 'worker.completed',
        result: {
          name: 'worker-1',
          kind: 'implementer',
          acpSessionId: 'sess-1',
          status: 'finished',
          result: 'held worker result',
        },
      },
    );
    const shutdown = new AbortController();
    const send = vi.fn().mockImplementation(async () => {
      setTimeout(() => shutdown.abort(), 0);
      return {
        runId: 'run-permission',
        status: 'finished',
        result: 'permission handled',
      };
    });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const options = createDriverOptions({
      eventQueue,
      conductor,
      permissionPipeline,
      isPermissionPending: (id) => permissionPipeline.pending.get(id) !== undefined,
      maxTurns: 1,
    });

    const result = await runConductorSessionDriver({
      ...options,
      shutdownSignal: shutdown.signal,
      dispatchHoldState: holdState,
      skipInitialSend: true,
      resumeStore: {
        sendCount: 1,
        autonomousTurns: 1,
        lastDispatchesThisTurn: 0,
        lastSendResult: {
          runId: 'run-initial',
          status: 'finished',
          result: 'initial',
        },
      },
    });

    expect(send).toHaveBeenCalledOnce();
    expect(String(send.mock.calls[0]![0])).toContain('permission-live-max-turns');
    expect(String(send.mock.calls[0]![0])).not.toContain('permission-stale-max-turns');
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

  it('dispatches permission.stall after operator.message and permission.pending', async () => {
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
        result: 'operator handled',
      })
      .mockResolvedValueOnce({
        runId: 'run-3',
        status: 'running',
        result: 'permission handled',
      })
      .mockResolvedValueOnce({
        runId: 'run-4',
        status: 'finished',
        result: 'stall handled',
      });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();

    eventQueue.enqueue({
      type: 'permission.stall',
      message: 'permission stalled for a long time',
      pendingPermissionIds: ['permission-1'],
      pendingPermissionCount: 1,
      oldestPermissionCreatedAt: 1,
      stallAgeMs: 300_000,
      stallThresholdMs: 300_000,
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
    eventQueue.enqueue({ type: 'operator.message', text: 'operator takes priority' });
    const result = await runConductorSessionDriver({
      ...createDriverOptions({
        eventQueue,
        conductor,
        maxTurns: 2,
      }),
    });

    expect(send).toHaveBeenCalledTimes(4);
    expect(String(send.mock.calls[1]![0])).toBe('operator takes priority');
    expect(String(send.mock.calls[2]![0])).toContain('permission.pending');
    expect(String(send.mock.calls[3]![0])).toContain('permission.stall');
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
        conductorAgentFactory: { create: mockCreate, resume: mockResume },
        conductorOptions: {
          cwd: '/repo',
          systemPrompt: 'compiled conductor system prompt',
        },
        onTransportReconnectAttempt,
        onTransportReconnectComplete,
      },
    });

    await vi.waitFor(() => expect(initialSend).toHaveBeenCalledOnce());
    eventQueue.enqueue({ type: 'operator.reconnect' });
    await vi.waitFor(() => expect(mockResume).toHaveBeenCalledOnce());

    expect(oldClose).toHaveBeenCalledOnce();
    expect(mockResume).toHaveBeenCalledWith('agent-1', {
      cwd: '/repo',
      systemPrompt: 'compiled conductor system prompt',
    });
    expect(onTransportReconnectAttempt).toHaveBeenCalledWith({
      agentId: 'agent-1',
      source: 'manual',
    });
    expect(onTransportReconnectComplete).toHaveBeenCalledWith({
      agentId: 'agent-1',
      success: true,
      source: 'manual',
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

  it('keeps only operator-authored input after an ambiguous failed dispatch and gates later sends', async () => {
    const authError = {
      runId: 'run-auth-failed',
      status: 'error',
      error: {
        code: 'auth',
        message: 'authentication failed at /private/secret/provider-token',
      },
    };
    const operatorEvent = {
      type: 'operator.message' as const,
      text: 'generated Open Question context\nprivate operator instruction',
      operatorInput: 'private operator instruction',
    };
    const initialSend = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-initial',
        status: 'finished',
        result: 'ready',
      })
      .mockImplementationOnce(async () => {
        operatorEvent.operatorInput = 'changed operator instruction';
        return authError;
      });
    const resumedSend = vi.fn().mockResolvedValue({
      runId: 'run-after-confirmation',
      status: 'finished',
      result: 'continued',
    });
    const conductor = {
      agentId: 'agent-1',
      send: initialSend,
      close: vi.fn(),
    } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();
    const recoveryInbox = new ConductorRecoveryInbox();
    const lifecycle = new ConductorDispatchLifecycle();
    const onRecoveryAttention = vi.fn();
    const driverOptions = createDriverOptions({ eventQueue, conductor });
    mockResume.mockResolvedValueOnce({
      agentId: 'agent-1',
      send: resumedSend,
      close: vi.fn(),
    });

    const driverPromise = runConductorSessionDriver({
      ...driverOptions,
      initialPrompt: 'compiled issue system prompt',
      shutdownSignal: shutdown.signal,
      continueOnConductorError: true,
      continueAfterIssueLoopStop: true,
      operatorCanInspectRecovery: true,
      recoveryBackend: 'cursor',
      recoveryInbox,
      dispatchLifecycle: lifecycle,
      onRecoveryAttention,
    });

    try {
      await vi.waitFor(() => expect(initialSend).toHaveBeenCalledOnce());
      eventQueue.enqueue(operatorEvent);
      await vi.waitFor(() => expect(initialSend).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(mockResume).toHaveBeenCalledOnce());
      expect(initialSend.mock.calls[1]![0]).toContain(
        'generated Open Question context',
      );
      expect(resumedSend).not.toHaveBeenCalled();
      expect(eventQueue.isEmpty()).toBe(true);

      const [summary] = recoveryInbox.list();
      expect(summary).toMatchObject({
        workflow: 'issue',
        backend: 'cursor',
        failureClass: 'auth',
        status: 'error',
        automaticReconnect: { reason: 'auth', succeeded: true },
        automaticRetryAttempts: 0,
        toolCallStarted: false,
      });
      const snapshot = recoveryInbox.get(summary!.recoveryId)!;
      expect(snapshot.inputTexts).toEqual(['private operator instruction']);
      expect(JSON.stringify(snapshot)).not.toContain('compiled issue system prompt');
      expect(JSON.stringify(snapshot)).not.toContain('generated Open Question context');
      expect(JSON.stringify(snapshot)).not.toContain('/private/secret/provider-token');
      expect(JSON.stringify(onRecoveryAttention.mock.calls)).not.toContain(
        'private operator instruction',
      );

      eventQueue.enqueue({
        type: 'operator.message',
        text: 'continue from the current state',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resumedSend).not.toHaveBeenCalled();
      expect(eventQueue.snapshot()).toEqual([
        {
          type: 'operator.message',
          text: 'continue from the current state',
        },
      ]);

      expect(lifecycle.confirmRecovery()).toBe(true);
      await vi.waitFor(() => expect(resumedSend).toHaveBeenCalledOnce());
      expect(resumedSend.mock.calls[0]![0]).toContain(
        'continue from the current state',
      );
    } finally {
      shutdown.abort();
      await driverPromise;
      recoveryInbox.dispose();
    }
  });

  it('does not capture the compiled initial prompt and leaves undispatched operator input queued', async () => {
    const authError = {
      runId: 'run-initial-auth-failed',
      status: 'error',
      error: { code: 'auth', message: PI_API_KEY_RESOLUTION_ERROR },
    };
    const initialSend = vi.fn().mockResolvedValue(authError);
    const resumedSend = vi.fn().mockResolvedValue({
      runId: 'run-operator-input',
      status: 'finished',
      result: 'continued',
    });
    const conductor = {
      agentId: 'agent-1',
      send: initialSend,
      close: vi.fn(),
    } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();
    const recoveryInbox = new ConductorRecoveryInbox();
    const lifecycle = new ConductorDispatchLifecycle();
    const initialOperatorInput = {
      type: 'operator.message' as const,
      text: 'initial CLI operator input',
      operatorInput: 'initial CLI operator input',
    };
    eventQueue.enqueue(initialOperatorInput);
    mockResume.mockResolvedValueOnce({
      agentId: 'agent-1',
      send: resumedSend,
      close: vi.fn(),
    });

    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor }),
      initialPrompt: 'compiled Cursor system prompt with private config',
      shutdownSignal: shutdown.signal,
      continueOnConductorError: true,
      continueAfterIssueLoopStop: true,
      operatorCanInspectRecovery: true,
      recoveryInbox,
      dispatchLifecycle: lifecycle,
    });

    try {
      await vi.waitFor(() => expect(initialSend).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(mockResume).toHaveBeenCalledOnce());
      expect(initialSend).toHaveBeenCalledWith(
        'compiled Cursor system prompt with private config',
        expect.any(Object),
      );
      expect(recoveryInbox.list()).toEqual([]);
      expect(eventQueue.snapshot()).toEqual([initialOperatorInput]);
      expect(resumedSend).not.toHaveBeenCalled();

      expect(lifecycle.confirmRecovery()).toBe(true);
      await vi.waitFor(() => expect(resumedSend).toHaveBeenCalledOnce());
      expect(resumedSend.mock.calls[0]![0]).toBe(
        'initial CLI operator input',
      );
    } finally {
      shutdown.abort();
      await driverPromise;
      recoveryInbox.dispose();
    }
  });

  it('restores the Cursor bootstrap with the next confirmed event after initial failure', async () => {
    const authError = {
      runId: 'run-initial-auth-failed',
      status: 'error',
      error: { code: 'auth', message: PI_API_KEY_RESOLUTION_ERROR },
    };
    const compiledPrompt = 'compiled Cursor role prompt with private config';
    const initialSend = vi.fn().mockResolvedValue(authError);
    const resumedSend = vi.fn().mockResolvedValue({
      runId: 'run-after-bootstrap',
      status: 'finished',
      result: 'continued',
    });
    const conductor = {
      agentId: 'agent-1',
      send: initialSend,
      close: vi.fn(),
    } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const recoveryInbox = new ConductorRecoveryInbox();
    const lifecycle = new ConductorDispatchLifecycle();
    const shutdown = new AbortController();
    const operatorInput = {
      type: 'operator.message' as const,
      text: 'initial CLI operator input',
      operatorInput: 'initial CLI operator input',
    };
    eventQueue.enqueue(operatorInput);
    mockResume.mockResolvedValueOnce({
      agentId: 'agent-1',
      send: resumedSend,
      close: vi.fn(),
    });
    const driverOptions = createDriverOptions({ eventQueue, conductor });

    const driverPromise = runConductorSessionDriver({
      ...driverOptions,
      initialPrompt: compiledPrompt,
      recoveryBackend: 'cursor',
      shutdownSignal: shutdown.signal,
      continueOnConductorError: true,
      continueAfterIssueLoopStop: true,
      operatorCanInspectRecovery: true,
      recoveryInbox,
      dispatchLifecycle: lifecycle,
    });

    try {
      await vi.waitFor(() => expect(initialSend).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(mockResume).toHaveBeenCalledOnce());
      expect(initialSend).toHaveBeenCalledWith(
        compiledPrompt,
        expect.any(Object),
      );
      expect(eventQueue.snapshot()).toEqual([operatorInput]);
      expect(recoveryInbox.list()).toEqual([]);
      expect(resumedSend).not.toHaveBeenCalled();
      expect(lifecycle.confirmRecovery()).toBe(true);

      await vi.waitFor(() => expect(resumedSend).toHaveBeenCalledOnce());
      const sentMessage = resumedSend.mock.calls[0]![0] as string;
      expect(sentMessage).toContain(compiledPrompt);
      expect(sentMessage).toContain('## 今回のセッションイベント');
      expect(sentMessage).toContain(operatorInput.text);
      expect(eventQueue.isEmpty()).toBe(true);
      expect(recoveryInbox.list()).toEqual([]);

      const completion =
        driverOptions.onSendComplete.mock.calls.at(-1)?.[0];
      expect(completion?.inbound).toContain(compiledPrompt);
      expect(completion?.historyInbound).toBe(operatorInput.text);
    } finally {
      shutdown.abort();
      await driverPromise;
      recoveryInbox.dispose();
    }
  });

  it('holds a legacy Cursor queue for an explicit saved bootstrap decision and never replays the failed input', async () => {
    const compiledPrompt = 'compiled Cursor prompt with private config';
    const firstInput = {
      type: 'operator.message' as const,
      text: 'first fresh instruction',
      operatorInput: 'first fresh instruction',
    };
    const laterInputA = {
      type: 'operator.message' as const,
      text: 'later instruction A',
      operatorInput: 'later instruction A',
    };
    const laterInputB = {
      type: 'operator.message' as const,
      text: 'later instruction B',
      operatorInput: 'later instruction B',
    };
    const eventQueue = new SessionEventQueue();
    eventQueue.enqueue(firstInput);
    const conductor = {
      agentId: 'agent-legacy-cursor',
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as ConductorAgent;
    let notifyFirstSendStarted!: () => void;
    const firstSendStarted = new Promise<void>((resolve) => {
      notifyFirstSendStarted = resolve;
    });
    let finishFirstSend!: (result: {
      runId: string;
      status: 'cancelled';
    }) => void;
    const firstSendResult = new Promise<{
      runId: string;
      status: 'cancelled';
    }>((resolve) => {
      finishFirstSend = resolve;
    });
    const send = vi
      .fn()
      .mockImplementationOnce(() => {
        notifyFirstSendStarted();
        return firstSendResult;
      })
      .mockResolvedValueOnce({
        runId: 'run-later-inputs',
        status: 'finished',
        result: 'continued',
      });
    conductor.send = send;
    const bootstrapState: CursorBootstrapState = { status: 'unknown' };
    const lifecycle = new ConductorDispatchLifecycle();
    const shutdown = new AbortController();
    const recoveryInbox = new ConductorRecoveryInbox();
    const onOperatorQueueChanged = vi.fn();
    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor }),
      initialPrompt: compiledPrompt,
      skipInitialSend: true,
      recoveryBackend: 'cursor',
      cursorBootstrapState: bootstrapState,
      shutdownSignal: shutdown.signal,
      continueAfterIssueLoopStop: true,
      operatorCanInspectRecovery: true,
      dispatchLifecycle: lifecycle,
      recoveryInbox,
      onOperatorQueueChanged,
    });

    try {
      await vi.waitFor(() =>
        expect(onOperatorQueueChanged).toHaveBeenCalledOnce(),
      );
      expect(send).not.toHaveBeenCalled();
      expect(eventQueue.snapshot()).toEqual([firstInput]);

      bootstrapState.status = 'saving';
      lifecycle.wake();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(send).not.toHaveBeenCalled();
      expect(eventQueue.snapshot()).toEqual([firstInput]);

      bootstrapState.status = 'incomplete';
      lifecycle.wake();
      await firstSendStarted;
      expect(send).toHaveBeenCalledOnce();
      const firstMessage = send.mock.calls[0]![0] as string;
      expect(firstMessage).toContain(compiledPrompt);
      expect(firstMessage).toContain(firstInput.text);

      eventQueue.enqueue(laterInputA);
      eventQueue.enqueue(laterInputB);
      finishFirstSend({
        runId: 'run-first-fresh-input',
        status: 'cancelled',
      });
      await vi.waitFor(() => expect(lifecycle.confirmationRequired).toBe(true));
      expect(send).toHaveBeenCalledOnce();
      const failedSnapshot = recoveryInbox.get(
        recoveryInbox.list()[0]!.recoveryId,
      );
      expect(failedSnapshot?.inputTexts).toEqual([firstInput.text]);
      expect(eventQueue.snapshot()).toEqual([laterInputA, laterInputB]);

      expect(lifecycle.confirmRecovery()).toBe(true);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      const laterMessage = send.mock.calls[1]![0] as string;
      expect(laterMessage).toContain(compiledPrompt);
      expect(laterMessage).not.toContain(firstInput.text);
      expect(laterMessage.indexOf(laterInputA.text)).toBeLessThan(
        laterMessage.indexOf(laterInputB.text),
      );
      expect(eventQueue.isEmpty()).toBe(true);
    } finally {
      shutdown.abort();
      await driverPromise;
      recoveryInbox.dispose();
    }
  });

  it('honors assume-complete without adding the compiled prompt to the next event', async () => {
    const compiledPrompt = 'compiled Cursor prompt with private config';
    const inputEvent = {
      type: 'operator.message' as const,
      text: 'new instruction after explicit choice',
      operatorInput: 'new instruction after explicit choice',
    };
    const eventQueue = new SessionEventQueue();
    eventQueue.enqueue(inputEvent);
    const send = vi.fn().mockResolvedValue({
      runId: 'run-after-assume-complete',
      status: 'finished',
      result: 'continued',
    });
    const conductor = {
      agentId: 'agent-legacy-cursor-complete',
      send,
      close: vi.fn(),
    } as unknown as ConductorAgent;
    const bootstrapState: CursorBootstrapState = { status: 'unknown' };
    const lifecycle = new ConductorDispatchLifecycle();
    const shutdown = new AbortController();
    const onOperatorQueueChanged = vi.fn();
    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor }),
      initialPrompt: compiledPrompt,
      skipInitialSend: true,
      recoveryBackend: 'cursor',
      cursorBootstrapState: bootstrapState,
      shutdownSignal: shutdown.signal,
      continueAfterIssueLoopStop: true,
      dispatchLifecycle: lifecycle,
      onOperatorQueueChanged,
    });

    try {
      await vi.waitFor(() =>
        expect(onOperatorQueueChanged).toHaveBeenCalledOnce(),
      );
      expect(send).not.toHaveBeenCalled();
      bootstrapState.status = 'complete';
      lifecycle.wake();

      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(send.mock.calls[0]![0]).toContain(inputEvent.text);
      expect(send.mock.calls[0]![0]).not.toContain(compiledPrompt);
    } finally {
      shutdown.abort();
      await driverPromise;
    }
  });

  it('does not retain recovery content or wait for an unavailable TTY confirmation', async () => {
    const authError = {
      runId: 'run-initial-auth-failed',
      status: 'error',
      error: { code: 'auth', message: '/private/secret/provider-token' },
    };
    const initialSend = vi.fn().mockResolvedValue(authError);
    const conductor = {
      agentId: 'agent-1',
      send: initialSend,
      close: vi.fn(),
    } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const queuedInput = {
      type: 'operator.message' as const,
      text: 'queued input after bootstrap',
      operatorInput: 'queued input after bootstrap',
    };
    eventQueue.enqueue(queuedInput);
    const recoveryInbox = new ConductorRecoveryInbox();
    const onRecoveryAttention = vi.fn();
    mockResume.mockResolvedValueOnce({
      agentId: 'agent-1',
      send: vi.fn(),
      close: vi.fn(),
    });

    try {
      const result = await runConductorSessionDriver({
        ...createDriverOptions({ eventQueue, conductor }),
        continueOnConductorError: true,
        operatorCanInspectRecovery: false,
        recoveryInbox,
        onRecoveryAttention,
      });

      expect(result.stopReason).toBe('error');
      expect(initialSend).toHaveBeenCalledOnce();
      expect(mockResume).toHaveBeenCalledOnce();
      expect(eventQueue.snapshot()).toEqual([queuedInput]);
      expect(recoveryInbox.list()).toEqual([]);
      expect(onRecoveryAttention).toHaveBeenCalledWith(
        expect.objectContaining({
          failureClass: 'auth',
        }),
      );
      expect(onRecoveryAttention.mock.calls[0]?.[0]).not.toHaveProperty(
        'snapshot',
      );
      expect(JSON.stringify(onRecoveryAttention.mock.calls)).not.toContain(
        '/private/secret/provider-token',
      );
    } finally {
      recoveryInbox.dispose();
    }
  });

  it('keeps a selected input queued when inbox capacity is full and resumes after clear', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-initial',
        status: 'finished',
        result: 'ready',
      })
      .mockResolvedValueOnce({
        runId: 'run-operator',
        status: 'finished',
        result: 'continued',
      });
    const conductor = {
      agentId: 'agent-1',
      send,
      close: vi.fn(),
    } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const recoveryInbox = new ConductorRecoveryInbox();
    const shutdown = new AbortController();
    const onRecoveryCapacityBlocked = vi.fn();
    const operatorEvent = {
      type: 'operator.message' as const,
      text: 'complete operator input',
      operatorInput: 'complete operator input',
    };
    eventQueue.enqueue(operatorEvent);

    for (let index = 1; index <= 4; index += 1) {
      const inputTexts = [`existing complete input ${index}`];
      const reservation = recoveryInbox.reserve(inputTexts);
      if (!reservation.ok || !reservation.reservation) {
        throw new Error('Expected to reserve recovery capacity.');
      }
      recoveryInbox.commit(
        reservation.reservation,
        {
          recoveryId: `conductor-recovery-${100 + index}`,
          workflow: 'issue',
          backend: 'cursor',
          sendCount: index,
          sourceKey: 'operator',
          eventTypes: ['operator.message'],
          status: 'error',
          failureClass: 'auth',
          automaticRetryAttempts: 0,
          toolCallStarted: false,
        },
        inputTexts,
      );
    }
    const existingRecoveryIds = recoveryInbox
      .list()
      .map((snapshot) => snapshot.recoveryId);

    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor }),
      shutdownSignal: shutdown.signal,
      operatorCanInspectRecovery: true,
      recoveryInbox,
      onRecoveryCapacityBlocked,
    });

    try {
      await vi.waitFor(() =>
        expect(onRecoveryCapacityBlocked).toHaveBeenCalledOnce(),
      );
      expect(send).toHaveBeenCalledOnce();
      expect(eventQueue.snapshot()).toEqual([operatorEvent]);
      expect(recoveryInbox.list().map((item) => item.recoveryId)).toEqual(
        existingRecoveryIds,
      );

      expect(recoveryInbox.remove(existingRecoveryIds[0]!)).toBe(true);
      const result = await driverPromise;

      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]![0]).toBe('complete operator input');
      expect(result.stopReason).toBe('completed');
      expect(recoveryInbox.list()).toHaveLength(3);
    } finally {
      shutdown.abort();
      recoveryInbox.dispose();
    }
  });

  it('treats send rejection as unknown, reconnects manually, and requires confirmation before continuing', async () => {
    const initialSend = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-initial',
        status: 'finished',
        result: 'ready',
      })
      .mockRejectedValueOnce(new Error('raw rejected error with secret-token'));
    const resumedSend = vi.fn().mockResolvedValue({
      runId: 'run-after-reconnect',
      status: 'finished',
      result: 'continued',
    });
    const oldClose = vi
      .fn()
      .mockRejectedValue(new Error('close cleanup failed'));
    const conductor = {
      agentId: 'agent-1',
      send: initialSend,
      close: oldClose,
    } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();
    const recoveryInbox = new ConductorRecoveryInbox();
    const lifecycle = new ConductorDispatchLifecycle();
    const reconnectComplete = vi.fn();
    const driverOptions = createDriverOptions({ eventQueue, conductor });
    mockResume.mockResolvedValueOnce({
      agentId: 'agent-1',
      send: resumedSend,
      close: vi.fn(),
    });

    const driverPromise = runConductorSessionDriver({
      ...driverOptions,
      shutdownSignal: shutdown.signal,
      continueOnConductorError: true,
      continueAfterIssueLoopStop: true,
      operatorCanInspectRecovery: true,
      recoveryInbox,
      dispatchLifecycle: lifecycle,
      sendReconnect: {
        ...driverOptions.sendReconnect,
        onTransportReconnectComplete: reconnectComplete,
      },
    });

    try {
      await vi.waitFor(() => expect(initialSend).toHaveBeenCalledOnce());
      eventQueue.enqueue({
        type: 'operator.message',
        text: 'the request whose outcome is unknown',
      });
      await vi.waitFor(() => expect(initialSend).toHaveBeenCalledTimes(2));
      expect(mockResume).not.toHaveBeenCalled();
      expect(recoveryInbox.list()[0]).toMatchObject({
        failureClass: 'send_rejected',
        status: 'send_rejected',
        automaticRetryAttempts: 0,
      });
      expect(
        JSON.stringify(recoveryInbox.get(recoveryInbox.list()[0]!.recoveryId)),
      ).not.toContain('secret-token');
      expect(lifecycle.available).toBe(false);
      expect(lifecycle.confirmationRequired).toBe(true);

      eventQueue.enqueue({ type: 'operator.reconnect' });
      eventQueue.enqueue({
        type: 'operator.message',
        text: 'continue after checking the current state',
      });
      await vi.waitFor(() => expect(mockResume).toHaveBeenCalledOnce());
      expect(reconnectComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          source: 'manual',
          closeFailed: true,
        }),
      );
      expect(oldClose).toHaveBeenCalledOnce();
      expect(lifecycle.available).toBe(true);
      expect(lifecycle.confirmationRequired).toBe(true);
      expect(resumedSend).not.toHaveBeenCalled();

      expect(lifecycle.confirmRecovery()).toBe(true);
      await vi.waitFor(() => expect(resumedSend).toHaveBeenCalledOnce());
      expect(resumedSend.mock.calls[0]![0]).toContain(
        'continue after checking the current state',
      );
    } finally {
      shutdown.abort();
      await driverPromise;
      recoveryInbox.dispose();
    }
  });

  it('coalesces reconnects queued during a failed resume into one retry', async () => {
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();
    const operatorMessage = {
      type: 'operator.message' as const,
      text: 'keep this while the agent is closed',
      delivery: 'next' as const,
    };
    let rejectFirstResume!: (error: Error) => void;
    let resolveSecondResume!: (agent: ConductorAgent) => void;
    const firstResume = new Promise<ConductorAgent>((_, reject) => {
      rejectFirstResume = reject;
    });
    const secondResume = new Promise<ConductorAgent>((resolve) => {
      resolveSecondResume = resolve;
    });
    const oldClose = vi.fn();
    const resumedSend = vi.fn().mockResolvedValue({
      runId: 'run-after-reconnect',
      status: 'finished',
      result: 'queued message delivered',
    });
    const conductor = {
      agentId: 'agent-1',
      send: vi.fn(),
      close: oldClose,
    } as unknown as ConductorAgent;
    const driverOptions = createDriverOptions({ eventQueue, conductor });
    const onTransportReconnectComplete = vi.fn();
    mockResume.mockReturnValueOnce(firstResume).mockReturnValueOnce(secondResume);

    const driverPromise = runConductorSessionDriver({
      ...driverOptions,
      skipInitialSend: true,
      resumeStore: {
        sendCount: 1,
        autonomousTurns: 0,
        lastSendResult: { runId: 'run-before-reconnect', status: 'running' },
        lastDispatchesThisTurn: 0,
      },
      shutdownSignal: shutdown.signal,
      continueAfterIssueLoopStop: true,
      sendReconnect: {
        ...driverOptions.sendReconnect,
        onTransportReconnectComplete,
      },
    });

    eventQueue.enqueue({ type: 'operator.reconnect' });
    await vi.waitFor(() => expect(mockResume).toHaveBeenCalledOnce());
    eventQueue.enqueue(operatorMessage);
    eventQueue.enqueue({ type: 'operator.reconnect' });
    eventQueue.enqueue({ type: 'operator.reconnect' });

    rejectFirstResume(new Error('resume unavailable'));
    await vi.waitFor(() => expect(mockResume).toHaveBeenCalledTimes(2));
    expect(onTransportReconnectComplete).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
    expect(eventQueue.snapshot()).toEqual([operatorMessage]);
    expect(oldClose).toHaveBeenCalledOnce();

    resolveSecondResume({
      agentId: 'agent-1',
      send: resumedSend,
      close: vi.fn(),
    } as unknown as ConductorAgent);
    await vi.waitFor(() => expect(resumedSend).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(onTransportReconnectComplete).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      ),
    );
    expect(resumedSend.mock.calls[0]![0]).toContain(
      'keep this while the agent is closed',
    );
    expect(mockResume).toHaveBeenCalledTimes(2);
    expect(oldClose).toHaveBeenCalledOnce();

    shutdown.abort();
    const result = await driverPromise;
    expect(result.stopReason).toBe('interrupted');
  });

  it('does not dispatch queued input after shutdown while manual reconnect is pending', async () => {
    const authError = {
      runId: 'run-auth-error',
      status: 'error' as const,
      error: { code: 'auth', message: PI_API_KEY_RESOLUTION_ERROR },
    };
    const originalSend = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-initial',
        status: 'finished' as const,
        result: 'ready',
      })
      .mockResolvedValueOnce(authError);
    const reportSend = vi.fn().mockResolvedValue({
      runId: 'run-report',
      status: 'finished',
      result: 'should not be sent',
    });
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();
    const recoveryInbox = new ConductorRecoveryInbox();
    const lifecycle = new ConductorDispatchLifecycle();
    let resolveManualResume!: (agent: ConductorAgent) => void;
    const manualResume = new Promise<ConductorAgent>((resolve) => {
      resolveManualResume = resolve;
    });
    const conductor = {
      agentId: 'agent-1',
      send: originalSend,
      close: vi.fn(),
    } as unknown as ConductorAgent;
    const driverOptions = createDriverOptions({ eventQueue, conductor });

    mockResume
      .mockRejectedValueOnce(new Error('automatic resume unavailable'))
      .mockReturnValueOnce(manualResume);

    const driverPromise = runConductorSessionDriver({
      ...driverOptions,
      shutdownSignal: shutdown.signal,
      continueOnConductorError: true,
      continueAfterIssueLoopStop: true,
      operatorCanInspectRecovery: true,
      recoveryInbox,
      dispatchLifecycle: lifecycle,
    });

    await vi.waitFor(() => expect(originalSend).toHaveBeenCalledOnce());
    eventQueue.enqueue({
      type: 'operator.message',
      text: 'failed input',
    });
    await vi.waitFor(() => expect(mockResume).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(driverOptions.onSendComplete).toHaveBeenCalledTimes(2),
    );

    eventQueue.enqueue({ type: 'operator.reconnect' });
    await vi.waitFor(() => expect(mockResume).toHaveBeenCalledTimes(2));
    eventQueue.enqueue({
      type: 'operator.message',
      text: 'arrived while reconnect was pending',
    });
    shutdown.abort();
    resolveManualResume({
      agentId: 'agent-1',
      send: reportSend,
      close: vi.fn(),
    } as unknown as ConductorAgent);

    const result = await driverPromise;
    expect(result.stopReason).toBe('interrupted');
    expect(reportSend).not.toHaveBeenCalled();
    expect(originalSend).toHaveBeenCalledTimes(2);
    expect(eventQueue.snapshot()).toEqual([
      {
        type: 'operator.message',
        text: 'arrived while reconnect was pending',
      },
    ]);
    recoveryInbox.dispose();
  });

  it('closes an automatic resume that resolves after Issue shutdown', async () => {
    const authError = {
      runId: 'run-auth-error',
      status: 'error' as const,
      error: { code: 'auth', message: PI_API_KEY_RESOLUTION_ERROR },
    };
    const originalSend = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-initial',
        status: 'finished' as const,
        result: 'ready',
      })
      .mockResolvedValueOnce(authError);
    const originalClose = vi.fn();
    const conductor = {
      agentId: 'agent-1',
      send: originalSend,
      close: originalClose,
    } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();
    const recoveryInbox = new ConductorRecoveryInbox();
    const driverOptions = createDriverOptions({ eventQueue, conductor });
    let resolveResume!: (agent: ConductorAgent) => void;
    const pendingResume = new Promise<ConductorAgent>((resolve) => {
      resolveResume = resolve;
    });
    const lateAgentClose = vi.fn().mockResolvedValue(undefined);
    const resumedSend = vi.fn();
    const lateAgent = {
      agentId: 'agent-1',
      send: resumedSend,
      close: lateAgentClose,
    } as unknown as ConductorAgent;
    mockResume.mockReturnValueOnce(pendingResume);

    const driverPromise = runConductorSessionDriver({
      ...driverOptions,
      shutdownSignal: shutdown.signal,
      continueOnConductorError: true,
      continueAfterIssueLoopStop: true,
      operatorCanInspectRecovery: true,
      recoveryInbox,
    });

    try {
      await vi.waitFor(() => expect(originalSend).toHaveBeenCalledOnce());
      eventQueue.enqueue({
        type: 'operator.message',
        text: 'failed user input',
      });
      await vi.waitFor(() => expect(originalSend).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(mockResume).toHaveBeenCalledOnce());
      eventQueue.enqueue({
        type: 'operator.message',
        text: 'arrived while automatic resume was pending',
      });

      shutdown.abort();
      const result = await driverPromise;
      expect(result.stopReason).toBe('interrupted');
      expect(eventQueue.snapshot()).toEqual([
        {
          type: 'operator.message',
          text: 'arrived while automatic resume was pending',
        },
      ]);

      resolveResume(lateAgent);
      await vi.waitFor(() =>
        expect(driverOptions.onSendComplete).toHaveBeenCalledTimes(2),
      );
      expect(driverOptions.conductorHandle.conductor).toBe(conductor);
      expect(lateAgentClose).toHaveBeenCalledOnce();
      expect(resumedSend).not.toHaveBeenCalled();
      expect(originalClose).toHaveBeenCalledOnce();
    } finally {
      shutdown.abort();
      recoveryInbox.dispose();
    }
  });

  it('keeps queued input through failed reconnects and requires confirmation after manual recovery', async () => {
    const authError = {
      runId: 'run-auth-error',
      status: 'error' as const,
      error: { code: 'auth', message: PI_API_KEY_RESOLUTION_ERROR },
    };
    const originalSend = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-initial',
        status: 'finished' as const,
        result: 'ready',
      })
      .mockResolvedValueOnce(authError);
    let resolveOperatorBatch!: (result: {
      runId: string;
      status: 'finished';
      result: string;
    }) => void;
    const operatorBatchSend = new Promise<{
      runId: string;
      status: 'finished';
      result: string;
    }>((resolve) => {
      resolveOperatorBatch = resolve;
    });
    const resumedSend = vi.fn((message: string) => {
      if (resumedSend.mock.calls.length === 1) {
        expect(message).toContain('first message while reconnect is pending');
        expect(message).toContain('second message while agent remains closed');
        expect(message.indexOf('first message while reconnect is pending')).toBeLessThan(
          message.indexOf('second message while agent remains closed'),
        );
        expect(message).not.toContain('original failed dispatch');
        expect(message).not.toContain('worker event retained');
        return operatorBatchSend;
      }
      expect(message).toContain('worker.completed');
      return Promise.resolve({
        runId: 'run-worker-after-reconnect',
        status: 'finished' as const,
        result: 'worker event delivered',
      });
    });
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();
    const recoveryInbox = new ConductorRecoveryInbox();
    const lifecycle = new ConductorDispatchLifecycle();
    let rejectAutomaticResume!: (error: Error) => void;
    let rejectFirstManualResume!: (error: Error) => void;
    const automaticResume = new Promise<ConductorAgent>((_, reject) => {
      rejectAutomaticResume = reject;
    });
    const failedManualResume = new Promise<ConductorAgent>((_, reject) => {
      rejectFirstManualResume = reject;
    });
    const originalClose = vi.fn();
    const conductor = {
      agentId: 'agent-1',
      send: originalSend,
      close: originalClose,
    } as unknown as ConductorAgent;
    const driverOptions = createDriverOptions({ eventQueue, conductor });
    const onTransportReconnectComplete = vi.fn();
    mockResume
      .mockReturnValueOnce(automaticResume)
      .mockReturnValueOnce(failedManualResume)
      .mockResolvedValueOnce({
        agentId: 'agent-1',
        send: resumedSend,
        close: vi.fn(),
      });

    const driverPromise = runConductorSessionDriver({
      ...driverOptions,
      shutdownSignal: shutdown.signal,
      continueOnConductorError: true,
      continueAfterIssueLoopStop: true,
      operatorCanInspectRecovery: true,
      recoveryInbox,
      dispatchLifecycle: lifecycle,
      sendReconnect: {
        ...driverOptions.sendReconnect,
        onTransportReconnectComplete,
      },
    });

    try {
      await vi.waitFor(() => expect(originalSend).toHaveBeenCalledOnce());
      eventQueue.enqueue({
        type: 'operator.message',
        text: 'original failed dispatch',
      });
      await vi.waitFor(() => expect(mockResume).toHaveBeenCalledOnce());
      eventQueue.enqueue({
        type: 'operator.message',
        text: 'first message while reconnect is pending',
      });
      const workerEvent = {
        type: 'worker.completed' as const,
        result: {
          name: 'implementer',
          acpSessionId: 'worker-session',
          status: 'finished' as const,
          result: 'worker event retained',
        },
      };
      eventQueue.enqueue(workerEvent);
      rejectAutomaticResume(new Error('automatic resume unavailable'));
      await vi.waitFor(() =>
        expect(driverOptions.onSendComplete).toHaveBeenCalledTimes(2),
      );
      expect(eventQueue.snapshot()).toEqual([
        {
          type: 'operator.message',
          text: 'first message while reconnect is pending',
        },
        workerEvent,
      ]);
      expect(recoveryInbox.list()[0]).toMatchObject({
        automaticReconnect: { reason: 'auth', succeeded: false },
      });

      eventQueue.enqueue({ type: 'operator.reconnect' });
      await vi.waitFor(() => expect(mockResume).toHaveBeenCalledTimes(2));
      eventQueue.enqueue({
        type: 'operator.message',
        text: 'second message while agent remains closed',
      });
      rejectFirstManualResume(new Error('manual resume still unavailable'));
      await vi.waitFor(() =>
        expect(onTransportReconnectComplete).toHaveBeenCalledWith(
          expect.objectContaining({ success: false, source: 'manual' }),
        ),
      );
      expect(originalSend).toHaveBeenCalledTimes(2);
      expect(eventQueue.snapshot()).toEqual([
        {
          type: 'operator.message',
          text: 'first message while reconnect is pending',
        },
        workerEvent,
        {
          type: 'operator.message',
          text: 'second message while agent remains closed',
        },
      ]);

      eventQueue.enqueue({ type: 'operator.reconnect' });
      await vi.waitFor(() => expect(mockResume).toHaveBeenCalledTimes(3));
      await vi.waitFor(() =>
        expect(onTransportReconnectComplete).toHaveBeenCalledWith(
          expect.objectContaining({ success: true, source: 'manual' }),
        ),
      );
      expect(resumedSend).not.toHaveBeenCalled();
      expect(lifecycle.available).toBe(true);
      expect(lifecycle.confirmationRequired).toBe(true);
      expect(eventQueue.snapshot()).toEqual([
        {
          type: 'operator.message',
          text: 'first message while reconnect is pending',
        },
        workerEvent,
        {
          type: 'operator.message',
          text: 'second message while agent remains closed',
        },
      ]);

      expect(lifecycle.confirmRecovery()).toBe(true);
      await vi.waitFor(() => expect(resumedSend).toHaveBeenCalledOnce());
      resolveOperatorBatch({
        runId: 'run-after-reconnect',
        status: 'finished',
        result: 'continued',
      });
      await vi.waitFor(() => expect(resumedSend).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(driverOptions.onSendComplete).toHaveBeenCalledTimes(4),
      );
      expect(eventQueue.isEmpty()).toBe(true);
      expect(recoveryInbox.list()).toHaveLength(1);
      expect(originalClose).toHaveBeenCalledOnce();
    } finally {
      shutdown.abort();
      await driverPromise;
      recoveryInbox.dispose();
    }
  });

  it('captures an ambiguous transport failure once and waits for explicit confirmation', async () => {
    const transportError = {
      runId: 'run-transport-error',
      status: 'error',
      error: { message: 'Connection stalled repeatedly' },
    };
    const originalSend = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-initial',
        status: 'finished',
        result: 'ready',
      })
      .mockResolvedValueOnce(transportError);
    const resumedSend = vi.fn().mockResolvedValue({
      runId: 'run-after-confirmation',
      status: 'finished',
      result: 'continued',
    });
    const conductor = {
      agentId: 'agent-1',
      send: originalSend,
      close: vi.fn(),
    } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();
    const recoveryInbox = new ConductorRecoveryInbox();
    const lifecycle = new ConductorDispatchLifecycle();
    const driverOptions = createDriverOptions({ eventQueue, conductor });
    mockResume.mockResolvedValueOnce({
      agentId: 'agent-1',
      send: resumedSend,
      close: vi.fn(),
    });

    const driverPromise = runConductorSessionDriver({
      ...driverOptions,
      shutdownSignal: shutdown.signal,
      continueOnConductorError: true,
      continueAfterIssueLoopStop: true,
      operatorCanInspectRecovery: true,
      recoveryInbox,
      dispatchLifecycle: lifecycle,
    });

    try {
      await vi.waitFor(() => expect(originalSend).toHaveBeenCalledOnce());
      eventQueue.enqueue({
        type: 'operator.message',
        text: 'possibly completed remote work',
      });
      await vi.waitFor(() => expect(originalSend).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(mockResume).toHaveBeenCalledOnce());
      expect(resumedSend).not.toHaveBeenCalled();
      expect(recoveryInbox.list()[0]).toMatchObject({
        failureClass: 'transport',
        automaticReconnect: { reason: 'transport', succeeded: true },
        automaticRetryAttempts: 0,
      });

      eventQueue.enqueue({
        type: 'operator.message',
        text: 'send a fresh operator request',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resumedSend).not.toHaveBeenCalled();
      expect(eventQueue.snapshot()).toEqual([
        {
          type: 'operator.message',
          text: 'send a fresh operator request',
        },
      ]);

      expect(lifecycle.confirmRecovery()).toBe(true);
      await vi.waitFor(() => expect(resumedSend).toHaveBeenCalledOnce());
      expect(resumedSend.mock.calls[0]![0]).toContain(
        'send a fresh operator request',
      );
      expect(resumedSend.mock.calls[0]![0]).not.toBe(
        originalSend.mock.calls[1]![0],
      );
    } finally {
      shutdown.abort();
      await driverPromise;
      recoveryInbox.dispose();
    }
  });

  it('records tool-start observation and keeps manual reconnect local', async () => {
    const authError = {
      runId: 'run-auth-error',
      status: 'error' as const,
      error: { code: 'auth', message: PI_API_KEY_RESOLUTION_ERROR },
    };
    const originalSend = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-initial',
        status: 'finished' as const,
        result: 'ready',
      })
      .mockImplementationOnce(
        async (
          _prompt: string,
          callbacks?: {
            onToolCallStarted?: (info: {
              runId: string;
              tool: string;
              callId: string;
            }) => void;
          },
        ) => {
          callbacks?.onToolCallStarted?.({
            runId: 'run-partial',
            tool: 'prompt_worker',
            callId: 'call-1',
          });
          return authError;
        },
      );
    const automaticResumeSend = vi.fn();
    const manualResumeSend = vi.fn().mockResolvedValue({
      runId: 'run-fresh',
      status: 'finished',
      result: 'continued after state check',
    });
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();
    const recoveryInbox = new ConductorRecoveryInbox();
    const lifecycle = new ConductorDispatchLifecycle();
    const conductor = {
      agentId: 'agent-1',
      send: originalSend,
      close: vi.fn(),
    } as unknown as ConductorAgent;
    mockResume
      .mockResolvedValueOnce({
        agentId: 'agent-1',
        send: automaticResumeSend,
        close: vi.fn(),
      })
      .mockResolvedValueOnce({
        agentId: 'agent-1',
        send: manualResumeSend,
        close: vi.fn(),
      });

    const driverOptions = createDriverOptions({ eventQueue, conductor });
    const driverPromise = runConductorSessionDriver({
      ...driverOptions,
      shutdownSignal: shutdown.signal,
      continueOnConductorError: true,
      continueAfterIssueLoopStop: true,
      operatorCanInspectRecovery: true,
      recoveryInbox,
      dispatchLifecycle: lifecycle,
    });

    try {
      await vi.waitFor(() => expect(originalSend).toHaveBeenCalledOnce());
      eventQueue.enqueue({
        type: 'operator.message',
        text: 'perform work that may run tools',
      });
      await vi.waitFor(() => expect(originalSend).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(mockResume).toHaveBeenCalledOnce());
      const failedPrompt = originalSend.mock.calls[1]![0] as string;
      expect(automaticResumeSend).not.toHaveBeenCalled();
      expect(recoveryInbox.get(recoveryInbox.list()[0]!.recoveryId)?.inputTexts).toEqual([
        'perform work that may run tools',
      ]);
      expect(recoveryInbox.list()[0]).toMatchObject({ toolCallStarted: true });

      eventQueue.enqueue({
        type: 'operator.message',
        text: 'inspect current state and continue only unfinished work',
      });
      eventQueue.enqueue({ type: 'operator.reconnect' });
      await vi.waitFor(() => expect(mockResume).toHaveBeenCalledTimes(2));
      expect(manualResumeSend).not.toHaveBeenCalled();
      expect(lifecycle.confirmationRequired).toBe(true);
      expect(eventQueue.snapshot()).toEqual([
        {
          type: 'operator.message',
          text: 'inspect current state and continue only unfinished work',
        },
      ]);
      expect(originalSend.mock.calls[1]![0]).toBe(failedPrompt);
      expect(originalSend.mock.calls[1]![0]).not.toContain(
        'conductor.recovery.report',
      );

      expect(lifecycle.confirmRecovery()).toBe(true);
      await vi.waitFor(() => expect(manualResumeSend).toHaveBeenCalledOnce());
      const freshPrompt = manualResumeSend.mock.calls[0]![0] as string;
      expect(freshPrompt).toContain(
        'inspect current state and continue only unfinished work',
      );
      expect(freshPrompt).not.toBe(failedPrompt);
      expect(freshPrompt).not.toContain('conductor.recovery.report');
    } finally {
      shutdown.abort();
      await driverPromise;
      recoveryInbox.dispose();
    }
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

  it('allows idle operator messages while dispatch hold remains active', async () => {
    const holdState = createDispatchHoldState();
    const eventQueue = new SessionEventQueue();
    const holdTool = createSetDispatchHoldTool({
      state: holdState,
      onBeforeRelease: () =>
        bufferDispatchHoldEvents({
          state: holdState,
          eventQueue,
        }),
    });
    const shutdown = new AbortController();
    const idleMessage = 'deliver during the active hold';
    const send = vi
      .fn()
      .mockImplementationOnce(async () => {
        await holdTool.set_dispatch_hold!.execute({ hold: true });
        return { runId: 'run-1', status: 'running', result: 'holding' };
      })
      .mockImplementationOnce(async (message: string) => {
        expect(message).toContain(idleMessage);
        expect(holdState.dispatchHold).toBe(true);
        expect(holdState.heldEvents).toHaveLength(1);
        await holdTool.set_dispatch_hold!.execute({ hold: false });
        return { runId: 'run-2', status: 'running', result: 'released' };
      })
      .mockImplementationOnce(async (message: string) => {
        expect(message).toContain('worker.completed');
        return { runId: 'run-3', status: 'finished', result: 'worker processed' };
      });
    const conductor = {
      agentId: 'agent-1',
      send,
      close: vi.fn(),
    } as unknown as ConductorAgent;
    const options = createDriverOptions({
      eventQueue,
      conductor,
      maxTurns: 5,
      runningCount: 1,
    });
    const dispatched = vi.fn();
    const driverPromise = runConductorSessionDriver({
      ...options,
      shutdownSignal: shutdown.signal,
      dispatchHoldState: holdState,
      onOperatorDispatched: (events) => {
        if (events.some((event) => event.type === 'operator.message')) {
          dispatched(holdState.dispatchHold, eventQueue.snapshot());
        }
      },
    });

    await vi.waitFor(() => expect(holdState.dispatchHold).toBe(true));
    eventQueue.enqueue({
      type: 'worker.completed',
      result: {
        name: 'implementer',
        kind: 'implementer',
        acpSessionId: 'worker-session',
        status: 'finished',
        result: 'worker finished',
      },
    });
    await vi.waitFor(() => expect(holdState.heldEvents).toHaveLength(1));
    options.workerSession.runtime.runningCount = 0;
    eventQueue.enqueue({
      type: 'operator.message',
      text: idleMessage,
      delivery: 'idle',
    });

    await awaitDriverWithTimeout(driverPromise, shutdown);

    expect(send).toHaveBeenCalledTimes(3);
    expect(String(send.mock.calls[1]![0])).toContain(idleMessage);
    expect(String(send.mock.calls[2]![0])).toContain('worker.completed');
    expect(dispatched).toHaveBeenCalledWith(true, []);
    expect(holdState).toEqual({ dispatchHold: false, heldEvents: [] });
  });

  it('dispatches held autonomous work before idle operator messages after hold release', async () => {
    const holdState = createDispatchHoldState();
    const eventQueue = new SessionEventQueue();
    const holdTool = createSetDispatchHoldTool({
      state: holdState,
      onBeforeRelease: () =>
        bufferDispatchHoldEvents({
          state: holdState,
          eventQueue,
        }),
    });
    const idleMessage = 'wait for held worker outcome';
    const send = vi
      .fn()
      .mockImplementationOnce(async () => {
        await holdTool.set_dispatch_hold!.execute({ hold: true });
        return { runId: 'run-1', status: 'running', result: 'holding' };
      })
      .mockImplementationOnce(async (message: string) => {
        expect(message).toBe('release dispatch hold');
        await holdTool.set_dispatch_hold!.execute({ hold: false });
        expect(holdState.heldEvents).toHaveLength(1);
        eventQueue.enqueue({
          type: 'operator.message',
          text: idleMessage,
          delivery: 'idle',
        });
        return { runId: 'run-2', status: 'running', result: 'released' };
      })
      .mockImplementationOnce(async (message: string) => {
        expect(message).toContain('worker.completed');
        expect(message).not.toContain(idleMessage);
        return { runId: 'run-3', status: 'running', result: 'worker processed' };
      })
      .mockImplementationOnce(async (message: string) => {
        expect(message).toContain(idleMessage);
        return { runId: 'run-4', status: 'finished', result: 'operator handled' };
      });
    const conductor = {
      agentId: 'agent-1',
      send,
      close: vi.fn(),
    } as unknown as ConductorAgent;
    const options = createDriverOptions({
      eventQueue,
      conductor,
      maxTurns: 5,
      runningCount: 1,
    });
    const driverPromise = runConductorSessionDriver({
      ...options,
      dispatchHoldState: holdState,
    });

    await vi.waitFor(() => expect(holdState.dispatchHold).toBe(true));
    eventQueue.enqueue({
      type: 'worker.completed',
      result: {
        name: 'implementer',
        kind: 'implementer',
        acpSessionId: 'worker-session',
        status: 'finished',
        result: 'worker finished',
      },
    });
    await vi.waitFor(() => expect(holdState.heldEvents).toHaveLength(1));
    options.workerSession.runtime.runningCount = 0;
    eventQueue.enqueue({
      type: 'operator.message',
      text: 'release dispatch hold',
    });

    const result = await driverPromise;

    expect(send).toHaveBeenCalledTimes(4);
    expect(String(send.mock.calls[2]![0])).toContain('worker.completed');
    expect(String(send.mock.calls[2]![0])).not.toContain(idleMessage);
    expect(String(send.mock.calls[3]![0])).toContain(idleMessage);
    expect(holdState).toEqual({ dispatchHold: false, heldEvents: [] });
    expect(options.onSendComplete).toHaveBeenCalledWith(
      expect.objectContaining({ workerDispatches: 1 }),
    );
    expect(result.autonomousTurns).toBe(0);
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
      .mockImplementationOnce(async (message: string) => {
        expect(message).toContain('## worker 通知（implementer・2 件）');
        eventQueue.enqueue({
          type: 'worker.completed',
          result: {
            name: 'late-worker',
            acpSessionId: 'sess-2',
            status: 'finished',
            result: 'late outcome',
          },
        });
        return {
          runId: 'run-2',
          status: 'finished',
          result: 'flushed',
        };
      })
      .mockResolvedValueOnce({
        runId: 'run-3',
        status: 'finished',
        result: 'late outcome delivered',
      });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;

    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor, maxTurns: 5 }),
      dispatchHoldState: holdState,
      onDispatchHoldChanged: (change) => holdChanges.push(change),
      onSendComplete,
    });

    const result = await driverPromise;

    expect(send).toHaveBeenCalledTimes(3);
    expect(String(send.mock.calls[1]![0])).toContain('## worker 通知（implementer・2 件）');
    expect(String(send.mock.calls[1]![0])).toContain('worker.completed');
    expect(String(send.mock.calls[1]![0])).toContain('worker.failed');
    expect(String(send.mock.calls[2]![0])).toContain('late-worker');
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
    expect(onSendComplete.mock.calls.map(([info]) => info.autonomousTurns)).toEqual([1, 2, 3]);
    expect(onSendComplete.mock.calls[1]?.[0]).toMatchObject({
      workerDispatches: 1,
      workerFailures: 1,
    });
    expect(result.autonomousTurns).toBe(3);
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

  it('dispatches permission.stall during hold at max turns and releases pending ahead of held work', async () => {
    const holdState = createDispatchHoldState();
    const holdChanges: DispatchHoldChange[] = [];
    const eventQueue = new SessionEventQueue();
    const shutdown = new AbortController();
    const permissionPipeline = new PermissionPipeline({});
    const pendingEvent = createPendingPermissionEvent(
      permissionPipeline,
      'permission-stalled',
    );
    const workerEvent = {
      type: 'worker.completed' as const,
      result: {
        name: 'implementer',
        acpSessionId: 'sess-1',
        status: 'finished' as const,
        result: 'work finished',
      },
    };
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
    await holdTool.set_dispatch_hold!.execute({ hold: true });
    eventQueue.enqueue(workerEvent);
    eventQueue.enqueue(pendingEvent);
    eventQueue.enqueue({
      type: 'permission.stall',
      message: 'permission stalled for a long time',
      pendingPermissionIds: [pendingEvent.permission.id],
      pendingPermissionCount: 1,
      oldestPermissionCreatedAt: pendingEvent.permission.createdAt,
      stallAgeMs: 300_000,
      stallThresholdMs: 300_000,
    });

    const send = vi
      .fn()
      .mockImplementationOnce(async (message: string) => {
        expect(message).toContain('permission.stall');
        expect(message).not.toContain('permission.pending');
        expect(holdState.dispatchHold).toBe(true);
        expect(holdState.heldEvents).toEqual([workerEvent, pendingEvent]);
        await holdTool.set_dispatch_hold!.execute({ hold: false });
        return { runId: 'run-stall', status: 'running', result: 'released for recovery' };
      })
      .mockImplementationOnce(async (message: string) => {
        expect(message).toContain('permission.pending');
        expect(message).not.toContain('worker.completed');
        expect(holdState.dispatchHold).toBe(false);
        expect(holdState.heldEvents).toEqual([workerEvent]);
        return { runId: 'run-pending', status: 'running', result: 'permission handled' };
      });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({
        eventQueue,
        conductor,
        permissionPipeline,
        isPermissionPending: (requestId) =>
          permissionPipeline.pending.get(requestId) !== undefined,
        maxTurns: 1,
        runningCount: 1,
      }),
      dispatchHoldState: holdState,
      onDispatchHoldChanged: (change) => holdChanges.push(change),
      skipInitialSend: true,
      resumeStore: {
        sendCount: 1,
        autonomousTurns: 1,
        lastSendResult: { runId: 'run-before-hold', status: 'running' },
        lastDispatchesThisTurn: 0,
      },
      shutdownSignal: shutdown.signal,
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    shutdown.abort();
    const result = await awaitDriverWithTimeout(driverPromise, shutdown);

    expect(send).toHaveBeenCalledTimes(2);
    expect(String(send.mock.calls[0]![0])).toContain('permission.stall');
    expect(String(send.mock.calls[1]![0])).toContain('permission.pending');
    expect(result.stopReason).toBe('interrupted');
    expect(holdChanges).toContainEqual({
      status: 'released',
      hold: false,
      heldEventCount: 2,
      flushedEventCount: 2,
    });
    expect(holdState).toEqual({
      dispatchHold: false,
      heldEvents: [workerEvent],
    });
  });

  it('holds same-poll GitHub recovery with its update and flushes once released', async () => {
    const holdState = createDispatchHoldState();
    const eventQueue = new SessionEventQueue();
    const holdTool = createSetDispatchHoldTool({
      state: holdState,
      onBeforeRelease: () =>
        bufferDispatchHoldEvents({
          state: holdState,
          eventQueue,
        }),
    });
    const send = vi
      .fn()
      .mockImplementationOnce(async () => {
        await holdTool.set_dispatch_hold!.execute({ hold: true });
        eventQueue.enqueue({
          type: 'harness.connectivity.recovered',
          source: 'github_monitor',
          suppressedErrorCount: 3,
          dispatchMode: 'inform',
        });
        eventQueue.enqueue({
          type: 'github.update',
          items: [
            {
              id: 'issue-comment:recovered',
              kind: 'issue.comment',
              summary: 'recovered update',
            },
          ],
        });
        await holdTool.set_dispatch_hold!.execute({ hold: false });
        return { runId: 'run-1', status: 'finished', result: 'hold released' };
      })
      .mockImplementationOnce(async (message: string) => {
        expect(message).toContain('## GitHub 更新・接続復旧（2 件）');
        expect(message).toContain('suppressedErrorCount: 3');
        expect(message).toContain('recovered update');
        return { runId: 'run-2', status: 'finished', result: 'recovery handled' };
      });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({
        eventQueue,
        conductor,
      }),
      dispatchHoldState: holdState,
    });

    const result = await driverPromise;

    expect(send).toHaveBeenCalledTimes(2);
    expect(String(send.mock.calls[1]![0])).toContain(
      '## GitHub 更新・接続復旧（2 件）',
    );
    expect(holdState).toEqual({ dispatchHold: false, heldEvents: [] });
    expect(result.stopReason).toBe('completed');
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
      })
      .mockResolvedValueOnce({
        runId: 'run-3',
        status: 'finished',
        result: 'late worker delivered',
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

    expect(send).toHaveBeenCalledTimes(3);
    expect(String(send.mock.calls[1]![0])).toContain('go ahead');
    expect(String(send.mock.calls[2]![0])).toContain('late worker');
    expect(result.autonomousTurns).toBe(1);
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

  it('dispatches idle operator.message at max turns before blocked worker events', async () => {
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
      })
      .mockResolvedValueOnce({
        runId: 'run-3',
        status: 'finished',
        result: 'late worker delivered',
      });

    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const openQuestions = new OpenQuestionRegistry();
    const driverPromise = runConductorSessionDriver(
      createDriverOptions({ eventQueue, conductor, openQuestions, maxTurns: 1 }),
    );

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
    eventQueue.enqueue({
      type: 'operator.message',
      text: 'wait until autonomous work is idle',
      delivery: 'idle',
    });

    await vi.waitFor(() =>
      expect(
        openQuestions.listOpen().find((question) => question.source === 'max_turns'),
      ).toBeDefined(),
    );
    const maxTurnsQuestion = openQuestions.listOpen().find(
      (question) => question.source === 'max_turns',
    );
    openQuestions.answer(maxTurnsQuestion!.id, {
      answer: 'continue',
      answeredBy: 'operator',
    });

    const result = await driverPromise;

    expect(send).toHaveBeenCalledTimes(3);
    expect(String(send.mock.calls[1]![0])).toContain(
      'wait until autonomous work is idle',
    );
    expect(String(send.mock.calls[2]![0])).toContain('worker.completed');
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

  it('stops with interrupted when shutdown aborts during the initial conductor send', async () => {
    let resolveInitialSend!: (value: {
      runId: string;
      status: string;
      result: string;
    }) => void;
    const initialSend = new Promise<{
      runId: string;
      status: string;
      result: string;
    }>((resolve) => {
      resolveInitialSend = resolve;
    });
    const send = vi.fn().mockReturnValue(initialSend);
    const conductor = {
      agentId: 'agent-1',
      send,
      close: vi.fn(),
    } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    eventQueue.enqueue({
      type: 'operator.message',
      text: 'must remain queued during bootstrap',
    });
    const shutdown = new AbortController();
    const dispatchLifecycle = new ConductorDispatchLifecycle();
    const onSendComplete = vi.fn();

    const driverPromise = runConductorSessionDriver({
      ...createDriverOptions({ eventQueue, conductor }),
      dispatchLifecycle,
      shutdownSignal: shutdown.signal,
      onSendComplete,
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    shutdown.abort();

    const result = await awaitDriverWithTimeout(driverPromise, shutdown);

    expect(result.stopReason).toBe('interrupted');
    expect(send).toHaveBeenCalledTimes(1);
    expect(eventQueue.snapshot()).toEqual([
      expect.objectContaining({
        type: 'operator.message',
        text: 'must remain queued during bootstrap',
      }),
    ]);
    expect(dispatchLifecycle.state).toBe('in_flight');

    resolveInitialSend({
      runId: 'run-initial',
      status: 'finished',
      result: 'late bootstrap completion',
    });
    await vi.waitFor(() => expect(dispatchLifecycle.state).toBe('ready'));
    expect(onSendComplete).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(1);
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

  it('notifies the view when an idle message arrives through a queue waiter', async () => {
    const shutdown = new AbortController();
    const eventQueue = new SessionEventQueue();
    const send = vi.fn().mockResolvedValue({
      runId: 'initial', status: 'finished', result: 'working',
    });
    const options = createDriverOptions({
      eventQueue,
      conductor: { agentId: 'agent', send, close: vi.fn() } as unknown as ConductorAgent,
      runningCount: 1,
    });
    const snapshots: unknown[] = [];
    const driver = runConductorSessionDriver({
      ...options,
      shutdownSignal: shutdown.signal,
      onOperatorQueueChanged: () => snapshots.push(eventQueue.snapshot()),
    });
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(options.onSendComplete).toHaveBeenCalled());
      eventQueue.enqueue({ type: 'operator.message', text: 'wait', delivery: 'idle' });
      await vi.waitFor(() => expect(snapshots).toContainEqual([
        { type: 'operator.message', text: 'wait', delivery: 'idle' },
      ]));
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      shutdown.abort();
      await driver;
    }
  });

  it('holds idle operator input through active worker work, then dispatches it', async () => {
    let resolveInitialSend!: (value: {
      runId: string;
      status: string;
      result: string;
    }) => void;
    const initialSend = new Promise<{
      runId: string;
      status: string;
      result: string;
    }>((resolve) => {
      resolveInitialSend = resolve;
    });
    let resolveWorkerSend!: (value: {
      runId: string;
      status: string;
      result: string;
    }) => void;
    const workerSend = new Promise<{
      runId: string;
      status: string;
      result: string;
    }>((resolve) => {
      resolveWorkerSend = resolve;
    });
    const send = vi
      .fn()
      .mockReturnValueOnce(initialSend)
      .mockReturnValueOnce(workerSend)
      .mockResolvedValueOnce({
        runId: 'run-operator',
        status: 'finished',
        result: 'operator handled',
      });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const options = createDriverOptions({
      eventQueue,
      conductor,
      runningCount: 1,
      maxTurns: 5,
    });
    const dispatched = vi.fn();
    const driverPromise = runConductorSessionDriver({
      ...options,
      onOperatorDispatched: (events) => {
        if (events.some((event) => event.type === 'operator.message')) {
          dispatched(events, eventQueue.snapshot());
        }
      },
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    eventQueue.enqueue({
      type: 'operator.message',
      text: 'wait until workers settle',
      delivery: 'idle',
    });
    eventQueue.enqueue({
      type: 'worker.completed',
      result: {
        name: 'implementer',
        kind: 'implementer',
        acpSessionId: 'worker-session',
        status: 'finished',
        result: 'worker finished',
      },
    });

    resolveInitialSend({
      runId: 'run-initial',
      status: 'finished',
      result: 'dispatched work',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(String(send.mock.calls[1]![0])).toContain('worker.completed');
    expect(String(send.mock.calls[1]![0])).not.toContain(
      'wait until workers settle',
    );
    expect(eventQueue.snapshot()).toContainEqual({
      type: 'operator.message', text: 'wait until workers settle', delivery: 'idle',
    });
    expect(dispatched).not.toHaveBeenCalled();

    options.workerSession.runtime.runningCount = 0;
    resolveWorkerSend({
      runId: 'run-worker',
      status: 'finished',
      result: 'worker acknowledged',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(String(send.mock.calls[2]![0])).toContain(
      'wait until workers settle',
    );
    expect(dispatched).toHaveBeenCalledWith(
      [expect.objectContaining({ type: 'operator.message', delivery: 'idle' })],
      [],
    );
    await driverPromise;
  });

  it('continues with the queued interrupt message after a run is cancelled', async () => {
    let resolveInitialSend!: (value: {
      runId: string;
      status: string;
      result: string;
    }) => void;
    const initialSend = new Promise<{
      runId: string;
      status: string;
      result: string;
    }>((resolve) => {
      resolveInitialSend = resolve;
    });
    const send = vi
      .fn()
      .mockReturnValueOnce(initialSend)
      .mockResolvedValueOnce({
        runId: 'run-operator',
        status: 'finished',
        result: 'operator handled',
      });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
    const eventQueue = new SessionEventQueue();
    const driverPromise = runConductorSessionDriver(
      createDriverOptions({ eventQueue, conductor }),
    );

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    eventQueue.enqueue({
      type: 'operator.message',
      text: 'stop the current turn',
      delivery: 'interrupt',
    });
    resolveInitialSend({
      runId: 'run-initial',
      status: 'cancelled',
      result: 'partial output',
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(String(send.mock.calls[1]![0])).toContain('stop the current turn');
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
