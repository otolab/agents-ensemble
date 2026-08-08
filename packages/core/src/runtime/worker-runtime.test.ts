import { describe, expect, it, vi } from 'vitest';
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
    });

    await inbox.drain();
    expect(completed).toEqual(['worker-abc']);
  });
});

describe('WorkerRuntime', () => {
  it('starts workers in the background and reports completion via inbox', async () => {
    const inbox = new ConductorInbox();
    const completed: string[] = [];
    inbox.subscribe((message) => {
      if (message.type === 'worker.completed') {
        completed.push(message.workerId);
      }
    });

    const dispatchWorker = vi.fn().mockResolvedValue({
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
    });

    const runtime = new WorkerRuntime({ inbox, dispatchWorker });
    const workerId = runtime.start({
      name: 'ping-1',
      issueUrl: 'https://github.com/org/repo/issues/1',
      kind: 'ping',
      systemPrompt: 'pong',
      repoRoot: '/repo',
    });

    expect(workerId).toBeTruthy();
    expect(runtime.runningCount).toBe(1);

    await runtime.waitForIdle();
    await inbox.drain();

    expect(runtime.runningCount).toBe(0);
    expect(dispatchWorker).toHaveBeenCalledOnce();
    expect(completed).toEqual([workerId]);
  });
});
