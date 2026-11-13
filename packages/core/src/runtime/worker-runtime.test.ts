import { describe, expect, it, vi } from 'vitest';
import type { AcpBridge } from '../acp/acp-bridge.js';
import { ConductorInbox } from './conductor-inbox.js';
import { WorkerRuntime } from './worker-runtime.js';

const TEST_WORKTREE = {
  path: '/tmp/wt',
  branch: 'ensemble/issue-1',
  issue: {
    owner: 'org',
    repo: 'repo',
    number: 1,
    url: 'https://github.com/org/repo/issues/1',
  },
};

describe('ConductorInbox', () => {
  it('fulfills permission requests via inbox listener', async () => {
    const inbox = new ConductorInbox();
    inbox.subscribe((message) => {
      if (message.type === 'permission.request') {
        inbox.fulfillPermission(message.id, {
          outcome: { outcome: 'selected', optionId: 'allow-once' },
        });
      }
    });

    const handler = inbox.createPermissionHandler('worker-1');
    const decision = await handler({ toolName: 'read', sessionId: 'sess-1' });
    await inbox.drain();

    expect(decision.outcome).toEqual({
      outcome: 'selected',
      optionId: 'allow-once',
    });
  });

  it('publishes worker completion to listeners', async () => {
    const inbox = new ConductorInbox();
    const completed: string[] = [];

    inbox.subscribe((message) => {
      if (message.type === 'worker.completed') {
        completed.push(message.workerId);
      }
    });

    inbox.publishWorkerCompleted('worker-abc', {
      name: 'ping-1',
      kind: 'ping',
      issue: TEST_WORKTREE.issue,
      worktree: TEST_WORKTREE,
      prompt: 'done',
      promptResult: { stopReason: 'end_turn' },
      acpSessionId: 'sess-1',
    });

    await inbox.drain();
    expect(completed).toEqual(['worker-abc']);
  });
});

function createMockBridge(close = vi.fn()): AcpBridge {
  return {
    newSession: vi.fn().mockResolvedValue('sess-1'),
    loadSession: vi.fn().mockResolvedValue(undefined),
    promptSession: vi.fn().mockResolvedValue({
      stopReason: 'end_turn',
      responseText: 'pong',
    }),
    close,
  } as unknown as AcpBridge;
}

describe('WorkerRuntime', () => {
  it('attaches workers and reports harness init prompt completion via inbox', async () => {
    const inbox = new ConductorInbox();
    const completed: Array<{ workerId: string; source?: string }> = [];
    const promptTelemetry: string[] = [];
    const workerStates: string[] = [];
    inbox.subscribe((message) => {
      if (message.type === 'worker.completed') {
        completed.push({
          workerId: message.workerId,
          source: message.result.source,
        });
      }
    });

    const close = vi.fn().mockResolvedValue(undefined);
    const runtime = new WorkerRuntime({
      inbox,
      connectAcp: async () => createMockBridge(close),
      onPromptTelemetry: (event) => {
        promptTelemetry.push(event.phase);
      },
      onWorkerState: (event) => {
        workerStates.push(event.state);
      },
    });
    const workerId = runtime.start({
      name: 'ping-1',
      issueUrl: TEST_WORKTREE.issue.url,
      kind: 'ping',
      prompt: { instructions: ['pong'] },
      worktree: TEST_WORKTREE,
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
    });

    expect(workerId).toBeTruthy();

    await runtime.waitForIdle();
    await inbox.drain();

    expect(runtime.runningCount).toBe(0);
    expect(runtime.attachedCount).toBe(1);
    expect(completed).toEqual([{ workerId, source: 'harness' }]);
    expect(promptTelemetry).toEqual(['started', 'completed']);
    expect(workerStates).toEqual(['attaching', 'processing', 'idle']);
    expect(close).not.toHaveBeenCalled();

    await runtime.shutdown();
    expect(close).toHaveBeenCalledOnce();
    expect(runtime.attachedCount).toBe(0);
  });

  it('forwards ACP session/update to onAcpUpdate during prompt', async () => {
    const inbox = new ConductorInbox();
    const acpUpdates: string[] = [];

    const promptSession = vi.fn(
      async (
        _sessionId: string,
        _prompt: string,
        options?: { onUpdate?: (update: unknown) => void },
      ) => {
        options?.onUpdate?.({
          sessionId: 'sess-1',
          update: { sessionUpdate: 'agent_thought_chunk' },
        });
        return { stopReason: 'end_turn', responseText: 'pong' };
      },
    );

    const runtime = new WorkerRuntime({
      inbox,
      connectAcp: async () =>
        ({
          newSession: vi.fn().mockResolvedValue('sess-1'),
          loadSession: vi.fn().mockResolvedValue(undefined),
          promptSession,
          close: vi.fn().mockResolvedValue(undefined),
        }) as unknown as AcpBridge,
      onAcpUpdate: (event) => {
        acpUpdates.push(event.sessionUpdate);
      },
    });

    runtime.start({
      name: 'ping-1',
      issueUrl: TEST_WORKTREE.issue.url,
      kind: 'ping',
      systemPrompt: 'pong',
      worktree: TEST_WORKTREE,
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
    });

    await runtime.waitForIdle();
    expect(acpUpdates).toContain('agent_thought_chunk');
    await runtime.shutdown();
  });

  it('increments runningCount synchronously when sendWorkerMessage starts a round', async () => {
    const inbox = new ConductorInbox();
    let resolveInit: (() => void) | undefined;
    const initPrompt = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });

    const promptSession = vi.fn(async () => {
      if (!resolveInit) {
        return { stopReason: 'end_turn', responseText: 'pong' };
      }
      await initPrompt;
      resolveInit = undefined;
      return { stopReason: 'end_turn', responseText: 'pong' };
    });

    const runtime = new WorkerRuntime({
      inbox,
      connectAcp: async () =>
        ({
          newSession: vi.fn().mockResolvedValue('sess-1'),
          loadSession: vi.fn().mockResolvedValue(undefined),
          promptSession,
          close: vi.fn().mockResolvedValue(undefined),
        }) as unknown as AcpBridge,
    });

    runtime.start({
      name: 'ping-1',
      issueUrl: TEST_WORKTREE.issue.url,
      kind: 'ping',
      prompt: { instructions: ['pong'] },
      worktree: TEST_WORKTREE,
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
    });

    await vi.waitFor(() => {
      expect(promptSession).toHaveBeenCalledOnce();
    });
    resolveInit!();
    await runtime.waitForIdle();

    const sent = runtime.sendWorkerMessage('ping-1', 'follow-up task');
    expect(sent).toEqual({ status: 'sent', worker: 'ping-1' });
    expect(runtime.runningCount).toBe(1);

    await runtime.waitForIdle();
    await runtime.shutdown();
  });

  it('keeps runningCount non-zero while an inbox permission request is pending', async () => {
    const inbox = new ConductorInbox();
    let permissionId: string | undefined;
    inbox.subscribe((message) => {
      if (message.type === 'permission.request') {
        permissionId = message.id;
      }
    });
    const runtime = new WorkerRuntime({ inbox });

    const decisionPromise = inbox.createPermissionHandler('worker-1')({
      toolName: 'Shell',
      raw: { command: 'echo test' },
    });

    await vi.waitFor(() => {
      expect(permissionId).toBeDefined();
      expect(runtime.runningCount).toBe(1);
    });

    inbox.fulfillPermission(permissionId!, {
      outcome: { outcome: 'selected', optionId: 'deny' },
    });
    await decisionPromise;
    expect(runtime.runningCount).toBe(0);
  });

  it('queues sendWorkerMessage while processing and drains after round completes', async () => {
    const inbox = new ConductorInbox();
    const prompts: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const firstPrompt = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const promptSession = vi.fn(async (_sessionId: string, prompt: string) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        await firstPrompt;
      }
      return { stopReason: 'end_turn', responseText: 'pong' };
    });

    const runtime = new WorkerRuntime({
      inbox,
      connectAcp: async () =>
        ({
          newSession: vi.fn().mockResolvedValue('sess-1'),
          loadSession: vi.fn().mockResolvedValue(undefined),
          promptSession,
          close: vi.fn().mockResolvedValue(undefined),
        }) as unknown as AcpBridge,
    });

    runtime.start({
      name: 'ping-1',
      issueUrl: TEST_WORKTREE.issue.url,
      kind: 'ping',
      prompt: { instructions: ['pong'] },
      worktree: TEST_WORKTREE,
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
    });

    await vi.waitFor(() => {
      expect(promptSession).toHaveBeenCalledOnce();
    });

    const queued = runtime.sendWorkerMessage('ping-1', 'follow-up task');
    expect(queued).toEqual({
      status: 'queued',
      worker: 'ping-1',
      position: 1,
    });

    resolveFirst!();
    await runtime.waitForIdle();
    await inbox.drain();

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe('follow-up task');
    expect(runtime.attachedCount).toBe(1);

    await runtime.shutdown();
  });

  it('emits prompt.failed telemetry when attach fails', async () => {
    const inbox = new ConductorInbox();
    const promptTelemetry: Array<{ phase: string; error?: string }> = [];
    const runtime = new WorkerRuntime({
      inbox,
      connectAcp: async () => {
        throw new Error('attach failed');
      },
      onPromptTelemetry: (event) => {
        promptTelemetry.push({ phase: event.phase, error: event.error });
      },
    });

    runtime.start({
      name: 'ping-1',
      issueUrl: TEST_WORKTREE.issue.url,
      kind: 'ping',
      prompt: { instructions: ['pong'] },
      worktree: TEST_WORKTREE,
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
    });

    await runtime.waitForIdle();
    await inbox.drain();

    expect(promptTelemetry).toEqual([
      { phase: 'started' },
      { phase: 'failed', error: 'attach failed' },
    ]);
    expect(runtime.attachedCount).toBe(0);
    expect(runtime.listWorkerStatuses()).toEqual([
      expect.objectContaining({
        name: 'ping-1',
        state: 'failed',
        error: 'attach failed',
      }),
    ]);
  });

  it('emits prompt.failed telemetry when init prompt fails', async () => {
    const inbox = new ConductorInbox();
    const promptTelemetry: Array<{ phase: string; error?: string }> = [];
    const runtime = new WorkerRuntime({
      inbox,
      connectAcp: async () =>
        ({
          newSession: vi.fn().mockResolvedValue('sess-1'),
          loadSession: vi.fn().mockResolvedValue(undefined),
          promptSession: vi.fn().mockRejectedValue(new Error('prompt failed')),
          close: vi.fn().mockResolvedValue(undefined),
        }) as unknown as AcpBridge,
      onPromptTelemetry: (event) => {
        promptTelemetry.push({ phase: event.phase, error: event.error });
      },
    });

    runtime.start({
      name: 'ping-1',
      issueUrl: TEST_WORKTREE.issue.url,
      kind: 'ping',
      prompt: { instructions: ['pong'] },
      worktree: TEST_WORKTREE,
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
    });

    await runtime.waitForIdle();
    await inbox.drain();

    expect(promptTelemetry).toEqual([
      { phase: 'started' },
      { phase: 'failed', error: 'prompt failed' },
    ]);
    expect(runtime.attachedCount).toBe(1);
  });

  it('replaces an unreadable resumed thread, bootstraps, then retries the conductor instruction once', async () => {
    const inbox = new ConductorInbox();
    const historyError = new Error(
      "The current provider can't read this thread's earlier reasoning, which another provider or account encrypted. Start a new thread.",
    );
    const oldPromptSession = vi
      .fn()
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        responseText: 'resumed',
      })
      .mockRejectedValueOnce(historyError);
    const oldClose = vi.fn().mockResolvedValue(undefined);
    const oldBridge = {
      newSession: vi.fn(),
      loadSession: vi.fn().mockResolvedValue(undefined),
      promptSession: oldPromptSession,
      cancelSession: vi.fn(),
      close: oldClose,
    } as unknown as AcpBridge;
    const newPromptSession = vi.fn().mockResolvedValue({
      stopReason: 'end_turn',
      responseText: 'ready',
    });
    const newSession = vi.fn().mockResolvedValue('sess-new');
    const newClose = vi.fn().mockResolvedValue(undefined);
    const newBridge = {
      newSession,
      loadSession: vi.fn(),
      promptSession: newPromptSession,
      cancelSession: vi.fn(),
      close: newClose,
    } as unknown as AcpBridge;
    const connectAcp = vi
      .fn()
      .mockResolvedValueOnce(oldBridge)
      .mockResolvedValueOnce(newBridge);
    const onWorkerSessionRecovered = vi.fn();
    const runtime = new WorkerRuntime({
      inbox,
      connectAcp,
      onWorkerSessionRecovered,
    });
    const workerId = runtime.start({
      name: 'ping-1',
      issueUrl: TEST_WORKTREE.issue.url,
      kind: 'ping',
      prompt: { instructions: ['pong'] },
      worktree: TEST_WORKTREE,
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
      resumeAcpSessionId: 'sess-old',
    });

    await runtime.waitForIdle();
    await inbox.drain();
    const resumePrompt = oldPromptSession.mock.calls[0]?.[1];

    expect(runtime.sendWorkerMessage('ping-1', 'inspect the current issue')).toEqual({
      status: 'sent',
      worker: 'ping-1',
    });
    await runtime.waitForIdle();
    await inbox.drain();

    expect(oldPromptSession).toHaveBeenNthCalledWith(
      2,
      'sess-old',
      'inspect the current issue',
      expect.any(Object),
    );
    expect(oldClose).toHaveBeenCalledOnce();
    expect(connectAcp).toHaveBeenCalledTimes(2);
    expect(newSession).toHaveBeenCalledOnce();
    expect(newSession).toHaveBeenCalledWith(TEST_WORKTREE.path);
    expect(newPromptSession).toHaveBeenCalledTimes(2);
    expect(newPromptSession.mock.calls[0]?.[0]).toBe('sess-new');
    expect(newPromptSession.mock.calls[0]?.[1]).not.toBe(resumePrompt);
    expect(newPromptSession.mock.calls[0]?.[1]).toContain('pong');
    expect(newPromptSession.mock.calls[1]?.[0]).toBe('sess-new');
    expect(newPromptSession.mock.calls[1]?.[1]).toBe(
      'inspect the current issue',
    );
    expect(onWorkerSessionRecovered).toHaveBeenCalledWith({
      workerId,
      name: 'ping-1',
      kind: 'ping',
      reason: 'prompt_history_unreadable',
      acpSessionId: 'sess-new',
      acpCwd: TEST_WORKTREE.path,
    });
    expect(runtime.getAttached('ping-1')?.session.sessionId).toBe('sess-new');

    await runtime.shutdown();
    expect(newClose).toHaveBeenCalledOnce();
  });

  it('does not replace a resumed thread after a generic prompt error', async () => {
    const inbox = new ConductorInbox();
    const oldPromptSession = vi
      .fn()
      .mockResolvedValueOnce({ stopReason: 'end_turn' })
      .mockRejectedValueOnce(new Error('prompt timed out'));
    const oldBridge = {
      newSession: vi.fn(),
      loadSession: vi.fn().mockResolvedValue(undefined),
      promptSession: oldPromptSession,
      cancelSession: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridge;
    const connectAcp = vi.fn().mockResolvedValue(oldBridge);
    const onWorkerSessionRecovered = vi.fn();
    const runtime = new WorkerRuntime({
      inbox,
      connectAcp,
      onWorkerSessionRecovered,
    });

    runtime.start({
      name: 'ping-1',
      issueUrl: TEST_WORKTREE.issue.url,
      kind: 'ping',
      worktree: TEST_WORKTREE,
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
      resumeAcpSessionId: 'sess-old',
    });
    await runtime.waitForIdle();
    await inbox.drain();

    runtime.sendWorkerMessage('ping-1', 'inspect the current issue');
    await runtime.waitForIdle();
    await inbox.drain();

    expect(connectAcp).toHaveBeenCalledOnce();
    expect(oldBridge.newSession).not.toHaveBeenCalled();
    expect(onWorkerSessionRecovered).not.toHaveBeenCalled();
    expect(runtime.getAttached('ping-1')?.session.sessionId).toBe('sess-old');
    await runtime.shutdown();
  });

  it('does not create another replacement session after bootstrap fails', async () => {
    const inbox = new ConductorInbox();
    const historyError = new Error(
      "The current provider can't read this thread's earlier reasoning, which another provider encrypted.",
    );
    const oldPromptSession = vi
      .fn()
      .mockResolvedValueOnce({ stopReason: 'end_turn' })
      .mockRejectedValueOnce(historyError);
    const oldBridge = {
      newSession: vi.fn(),
      loadSession: vi.fn().mockResolvedValue(undefined),
      promptSession: oldPromptSession,
      cancelSession: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridge;
    const newPromptSession = vi.fn().mockRejectedValue(historyError);
    const newSession = vi.fn().mockResolvedValue('sess-new');
    const newBridge = {
      newSession,
      loadSession: vi.fn(),
      promptSession: newPromptSession,
      cancelSession: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridge;
    const connectAcp = vi
      .fn()
      .mockResolvedValueOnce(oldBridge)
      .mockResolvedValueOnce(newBridge);
    const runtime = new WorkerRuntime({ inbox, connectAcp });

    runtime.start({
      name: 'ping-1',
      issueUrl: TEST_WORKTREE.issue.url,
      kind: 'ping',
      worktree: TEST_WORKTREE,
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
      resumeAcpSessionId: 'sess-old',
    });
    await runtime.waitForIdle();
    await inbox.drain();

    runtime.sendWorkerMessage('ping-1', 'inspect the current issue');
    await runtime.waitForIdle();
    await inbox.drain();
    runtime.sendWorkerMessage('ping-1', 'try again');
    await runtime.waitForIdle();
    await inbox.drain();

    expect(connectAcp).toHaveBeenCalledTimes(2);
    expect(newSession).toHaveBeenCalledOnce();
    expect(newPromptSession).toHaveBeenCalledTimes(2);
    await runtime.shutdown();
  });

  it('lets a preempted instruction wait for recovery bootstrap without cancelling the closed thread', async () => {
    const inbox = new ConductorInbox();
    const historyError = new Error(
      "The current provider can't read this thread's earlier reasoning, which another provider encrypted.",
    );
    const oldPromptSession = vi
      .fn()
      .mockResolvedValueOnce({ stopReason: 'end_turn' })
      .mockRejectedValueOnce(historyError);
    const oldBridge = {
      newSession: vi.fn(),
      loadSession: vi.fn().mockResolvedValue(undefined),
      promptSession: oldPromptSession,
      cancelSession: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridge;
    let resolveNewBridge!: (bridge: AcpBridge) => void;
    const pendingBridge = new Promise<AcpBridge>((resolve) => {
      resolveNewBridge = resolve;
    });
    const newPromptSession = vi.fn().mockResolvedValue({
      stopReason: 'end_turn',
      responseText: 'ready',
    });
    const newBridge = {
      newSession: vi.fn().mockResolvedValue('sess-new'),
      loadSession: vi.fn(),
      promptSession: newPromptSession,
      cancelSession: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridge;
    const connectAcp = vi
      .fn()
      .mockResolvedValueOnce(oldBridge)
      .mockReturnValueOnce(pendingBridge);
    const runtime = new WorkerRuntime({ inbox, connectAcp });

    runtime.start({
      name: 'ping-1',
      issueUrl: TEST_WORKTREE.issue.url,
      kind: 'ping',
      worktree: TEST_WORKTREE,
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
      resumeAcpSessionId: 'sess-old',
    });
    await runtime.waitForIdle();
    await inbox.drain();

    runtime.sendWorkerMessage('ping-1', 'old instruction');
    await vi.waitFor(() => expect(connectAcp).toHaveBeenCalledTimes(2));
    expect(
      runtime.sendWorkerMessage('ping-1', 'urgent instruction', {
        preempt: true,
      }),
    ).toEqual({ status: 'preempted', worker: 'ping-1' });
    expect(oldBridge.cancelSession).not.toHaveBeenCalled();

    resolveNewBridge(newBridge);
    await runtime.waitForIdle();
    await inbox.drain();

    expect(newPromptSession).toHaveBeenCalledTimes(2);
    expect(newPromptSession.mock.calls[1]?.[0]).toBe('sess-new');
    expect(newPromptSession.mock.calls[1]?.[1]).toBe('urgent instruction');
    expect(
      newPromptSession.mock.calls.some(
        ([, prompt]) => prompt === 'old instruction',
      ),
    ).toBe(false);
    await runtime.shutdown();
  });

  it('preempts in-flight prompt and runs the new instruction', async () => {
    const inbox = new ConductorInbox();
    const completed: string[] = [];
    inbox.subscribe((message) => {
      if (message.type === 'worker.completed') {
        completed.push(message.workerId);
      }
    });

    const prompts: string[] = [];
    let cancelFirst: (() => void) | undefined;
    const cancelSession = vi.fn(() => {
      cancelFirst?.();
    });

    const promptSession = vi.fn((_sessionId: string, prompt: string) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return new Promise<{ stopReason: string; responseText?: string }>(
          (resolve) => {
            cancelFirst = () => resolve({ stopReason: 'cancelled' });
          },
        );
      }
      return Promise.resolve({
        stopReason: 'end_turn',
        responseText: 'pong',
      });
    });

    const runtime = new WorkerRuntime({
      inbox,
      connectAcp: async () =>
        ({
          newSession: vi.fn().mockResolvedValue('sess-1'),
          loadSession: vi.fn().mockResolvedValue(undefined),
          promptSession,
          cancelSession,
          close: vi.fn().mockResolvedValue(undefined),
        }) as unknown as AcpBridge,
    });

    runtime.start({
      name: 'ping-1',
      issueUrl: TEST_WORKTREE.issue.url,
      kind: 'ping',
      prompt: { instructions: ['pong'] },
      worktree: TEST_WORKTREE,
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
    });

    await vi.waitFor(() => {
      expect(promptSession).toHaveBeenCalledOnce();
    });

    const preempted = runtime.sendWorkerMessage('ping-1', 'urgent task', {
      preempt: true,
    });
    expect(preempted).toEqual({ status: 'preempted', worker: 'ping-1' });
    expect(cancelSession).toHaveBeenCalledOnce();

    cancelFirst!();
    await runtime.waitForIdle();
    await inbox.drain();

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe('urgent task');
    expect(completed).toHaveLength(1);

    await runtime.shutdown();
  });

  it('force shutdown cancels in-flight prompts without waiting for idle', async () => {
    const inbox = new ConductorInbox();
    const cancelSession = vi.fn();
    let resolvePrompt: (() => void) | undefined;
    const close = vi.fn().mockResolvedValue(undefined);

    const promptSession = vi.fn(
      () =>
        new Promise<{ stopReason: string }>((resolve) => {
          resolvePrompt = () => resolve({ stopReason: 'cancelled' });
        }),
    );

    const runtime = new WorkerRuntime({
      inbox,
      connectAcp: async () =>
        ({
          newSession: vi.fn().mockResolvedValue('sess-1'),
          loadSession: vi.fn().mockResolvedValue(undefined),
          promptSession,
          cancelSession,
          close,
        }) as unknown as AcpBridge,
    });

    runtime.start({
      name: 'ping-1',
      issueUrl: TEST_WORKTREE.issue.url,
      kind: 'ping',
      prompt: { instructions: ['pong'] },
      worktree: TEST_WORKTREE,
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
    });

    await vi.waitFor(() => {
      expect(promptSession).toHaveBeenCalledOnce();
      expect(runtime.listWorkerStatuses()[0]?.state).toBe('processing');
    });

    const shutdownPromise = runtime.shutdown({ force: true });
    await expect(shutdownPromise).resolves.toBeUndefined();
    expect(cancelSession).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(runtime.attachedCount).toBe(0);

    resolvePrompt?.();
    await runtime.waitForIdle();
  });
});
