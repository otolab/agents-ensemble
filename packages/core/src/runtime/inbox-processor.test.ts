import { describe, expect, it, vi } from 'vitest';
import { PermissionPipeline } from '../permission/permission-pipeline.js';
import { allowOnce } from '../permission/permission-broker.js';
import { ConductorInbox } from './conductor-inbox.js';
import { startInboxProcessor } from './inbox-processor.js';

describe('startInboxProcessor', () => {
  it('decides permission and fulfills the worker waiter', async () => {
    const inbox = new ConductorInbox();
    const pipeline = new PermissionPipeline({
      policy: { allowTools: ['shell'] },
    });

    const processor = startInboxProcessor({
      inbox,
      decidePermission: (request, workerId, requestId) => {
        const outcome = pipeline.evaluate(requestId, workerId, request);
        return outcome.status === 'resolved' ? outcome.decision : null;
      },
    });
    const handler = inbox.createPermissionHandler('worker-1');

    const decisionPromise = handler({ toolName: 'shell', sessionId: 'sess-1' });
    const decision = await decisionPromise;
    await processor.stop();

    expect(decision.outcome).toEqual({
      outcome: 'selected',
      optionId: 'allow-once',
    });
  });

  it('defers non-obvious permission until resolve_permission fulfills', async () => {
    const inbox = new ConductorInbox();
    const pipeline = new PermissionPipeline({
      policy: { allowTools: [], allowReadOnlyTools: false },
    });

    const processor = startInboxProcessor({
      inbox,
      decidePermission: (request, workerId, requestId) => {
        const outcome = pipeline.evaluate(requestId, workerId, request);
        return outcome.status === 'resolved' ? outcome.decision : null;
      },
    });
    const handler = inbox.createPermissionHandler('worker-1');

    const decisionPromise = handler({ toolName: 'Shell', sessionId: 'sess-1' });
    await inbox.drain();

    expect(pipeline.pending.list()).toHaveLength(1);
    const pendingId = pipeline.pending.list()[0]!.id;

    pipeline.resolveAndFulfill(inbox, pendingId, true);
    await expect(decisionPromise).resolves.toEqual(allowOnce());
    await processor.stop();
  });

  it('notifies on worker completion', async () => {
    const inbox = new ConductorInbox();
    const onWorkerCompleted = vi.fn();

    const processor = startInboxProcessor({
      inbox,
      decidePermission: async () => allowOnce(),
      onWorkerCompleted,
    });

    inbox.publishWorkerCompleted('worker-1', {
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

    await processor.stop();
    expect(onWorkerCompleted).toHaveBeenCalledOnce();
  });

  it('notifies on worker failure', async () => {
    const inbox = new ConductorInbox();
    const onWorkerFailed = vi.fn();

    const processor = startInboxProcessor({
      inbox,
      decidePermission: async () => allowOnce(),
      onWorkerFailed,
    });

    inbox.publishWorkerFailed(
      {
        workerId: 'worker-1',
        name: 'ping-1',
        issueUrl: 'https://github.com/org/repo/issues/1',
        kind: 'ping',
        prompt: { instructions: ['pong'] },
        repoRoot: '/repo',
      },
      new Error('dispatch failed'),
    );

    await processor.stop();
    expect(onWorkerFailed).toHaveBeenCalledWith({
      workerId: 'worker-1',
      name: 'ping-1',
      issueUrl: 'https://github.com/org/repo/issues/1',
      kind: 'ping',
      error: 'dispatch failed',
    });
  });
});
