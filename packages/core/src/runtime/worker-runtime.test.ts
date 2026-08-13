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
    expect(close).not.toHaveBeenCalled();

    await runtime.shutdown();
    expect(close).toHaveBeenCalledOnce();
    expect(runtime.attachedCount).toBe(0);
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
});
