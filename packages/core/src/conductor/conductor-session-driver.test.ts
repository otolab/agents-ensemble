import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as issueContextModule from '../github/issue-context.js';
import { OpenQuestionRegistry } from '../escalation/open-question.js';
import { PermissionPipeline } from '../permission/permission-pipeline.js';
import { MAX_TURNS_OPEN_QUESTION_TEXT } from '../escalation/enqueue-max-turns-question.js';
import type { ConductorAgent } from './conductor-agent.js';
import type { ConductorAgentHandle } from './conductor-send-reconnect.js';
import { runConductorSessionDriver } from './conductor-session-driver.js';
import { SessionEventQueue } from './session/session-event-queue.js';

const TEST_ISSUE = {
  owner: 'org',
  repo: 'repo',
  number: 1,
  url: 'https://github.com/org/repo/issues/1',
};

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
}) {
  const workerDispatches: never[] = [];
  const workerFailures: never[] = [];
  const openQuestions = input.openQuestions ?? new OpenQuestionRegistry();
  const conductorHandle: ConductorAgentHandle = { conductor: input.conductor };

  return {
    issueUrl: TEST_ISSUE.url,
    profile: { workers: [] },
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
    workerDispatches,
    workerFailures,
    onSendComplete: vi.fn(),
  };
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
  });

  it('runs initial send then stops when conductor finishes', async () => {
    const onSendStarted = vi.fn();
    const send = vi.fn().mockResolvedValue({
      runId: 'run-1',
      status: 'finished',
      result: 'done',
    });
    const conductor = { agentId: 'agent-1', send, close: vi.fn() } as unknown as ConductorAgent;
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
});
