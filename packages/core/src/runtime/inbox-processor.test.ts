import { describe, expect, it, vi } from 'vitest';
import { ConductorInbox } from './conductor-inbox.js';
import { startInboxProcessor } from './inbox-processor.js';

describe('startInboxProcessor', () => {
  it('decides permission and fulfills the worker waiter', async () => {
    const inbox = new ConductorInbox();
    const decidePermission = vi.fn().mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });

    const processor = startInboxProcessor(inbox, { decidePermission });
    const handler = inbox.createPermissionHandler('worker-1');

    const decisionPromise = handler({ toolName: 'shell', sessionId: 'sess-1' });
    const decision = await decisionPromise;
    await processor.stop();

    expect(decidePermission).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'shell' }),
      'worker-1',
    );
    expect(decision.outcome).toEqual({
      outcome: 'selected',
      optionId: 'allow-once',
    });
  });

  it('notifies on worker completion', async () => {
    const inbox = new ConductorInbox();
    const onWorkerCompleted = vi.fn();

    const processor = startInboxProcessor(inbox, {
      decidePermission: async () => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      }),
      onWorkerCompleted,
    });

    inbox.publishWorkerCompleted('worker-1', {
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

    await processor.stop();
    expect(onWorkerCompleted).toHaveBeenCalledOnce();
  });

  it('notifies on worker failure', async () => {
    const inbox = new ConductorInbox();
    const onWorkerFailed = vi.fn();

    const processor = startInboxProcessor(inbox, {
      decidePermission: async () => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      }),
      onWorkerFailed,
    });

    inbox.publishWorkerFailed(
      {
        workerId: 'worker-1',
        issueUrl: 'https://github.com/org/repo/issues/1',
        skillName: 'lazy-implementer',
        repoRoot: '/repo',
      },
      new Error('dispatch failed'),
    );

    await processor.stop();
    expect(onWorkerFailed).toHaveBeenCalledWith({
      workerId: 'worker-1',
      issueUrl: 'https://github.com/org/repo/issues/1',
      skillName: 'lazy-implementer',
      error: 'dispatch failed',
    });
  });
});
