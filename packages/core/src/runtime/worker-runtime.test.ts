import { describe, expect, it, vi } from 'vitest';
import type { AcpBridge } from '../acp/acp-bridge.js';
import * as worktreeModule from '../worktree/worktree.js';
import { ConductorInbox } from './conductor-inbox.js';
import { WorkerRuntime } from './worker-runtime.js';

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
      issue: {
        owner: 'org',
        repo: 'repo',
        number: 1,
        url: 'https://github.com/org/repo/issues/1',
      },
      worktree: {
        path: '/tmp/wt',
        branch: 'ensemble/issue-1',
        issue: {
          owner: 'org',
          repo: 'repo',
          number: 1,
          url: 'https://github.com/org/repo/issues/1',
        },
      },
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
  it('attaches workers and reports bootstrap completion via inbox', async () => {
    vi.spyOn(worktreeModule, 'createWorkerWorktree').mockResolvedValue({
      path: '/tmp/wt',
      branch: 'ensemble/issue-1',
      issue: {
        owner: 'org',
        repo: 'repo',
        number: 1,
        url: 'https://github.com/org/repo/issues/1',
      },
    });

    const inbox = new ConductorInbox();
    const completed: string[] = [];
    inbox.subscribe((message) => {
      if (message.type === 'worker.completed') {
        completed.push(message.workerId);
      }
    });

    const close = vi.fn().mockResolvedValue(undefined);
    const runtime = new WorkerRuntime({
      inbox,
      connectAcp: async () => createMockBridge(close),
    });
    const workerId = runtime.start({
      name: 'ping-1',
      issueUrl: 'https://github.com/org/repo/issues/1',
      kind: 'ping',
      systemPrompt: 'pong',
      repoRoot: '/repo',
      sessionState: {
        workers: [{ name: 'ping-1', kind: 'ping' }],
        kinds: ['ping'],
      },
    });

    expect(workerId).toBeTruthy();
    expect(runtime.runningCount).toBe(1);

    await runtime.waitForIdle();
    await inbox.drain();

    expect(runtime.runningCount).toBe(0);
    expect(runtime.attachedCount).toBe(1);
    expect(completed).toEqual([workerId]);
    expect(close).not.toHaveBeenCalled();

    await runtime.shutdown();
    expect(close).toHaveBeenCalledOnce();
    expect(runtime.attachedCount).toBe(0);

    vi.restoreAllMocks();
  });
});
