import { describe, expect, it, vi } from 'vitest';
import { createDispatchTools } from './dispatch-tools.js';
import * as reviewerDispatchModule from '../dispatch/reviewer-dispatch.js';
import * as workerDispatchModule from '../dispatch/worker-dispatch.js';
import { ConductorInbox } from '../runtime/conductor-inbox.js';
import { WorkerRuntime } from '../runtime/worker-runtime.js';

describe('createDispatchTools', () => {
  it('dispatch_worker uses WorkerRuntime when provided', async () => {
    const inbox = new ConductorInbox();
    const dispatchWorker = vi.fn().mockResolvedValue({
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
      prompt: 'hi',
      promptResult: { stopReason: 'end_turn' },
    });
    const workerRuntime = new WorkerRuntime({ inbox, dispatchWorker });
    const onWorkerStarted = vi.fn();

    const tools = createDispatchTools({
      repoRoot: '/repo',
      workerRuntime,
      onWorkerStarted,
    });

    const result = await tools.dispatch_worker!.execute!(
      {
        issueUrl: 'https://github.com/org/repo/issues/1',
        skillName: 'lazy-implementer',
      },
      { toolCallId: '1' },
    );

    expect(onWorkerStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        issueUrl: 'https://github.com/org/repo/issues/1',
        skillName: 'lazy-implementer',
        repoRoot: '/repo',
      }),
    );
    expect(result).toMatchObject({
      structuredContent: {
        status: 'running',
        issueUrl: 'https://github.com/org/repo/issues/1',
        skillName: 'lazy-implementer',
      },
    });

    await workerRuntime.waitForIdle();
    expect(dispatchWorker).toHaveBeenCalledOnce();
  });

  it('dispatch_worker calls dispatchWorker synchronously without WorkerRuntime', async () => {
    const dispatchSpy = vi.spyOn(workerDispatchModule, 'dispatchWorker').mockResolvedValue({
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
      prompt: 'hi',
      promptResult: { stopReason: 'end_turn' },
    });

    const tools = createDispatchTools({ repoRoot: '/repo' });
    const result = await tools.dispatch_worker!.execute!(
      {
        issueUrl: 'https://github.com/org/repo/issues/1',
        skillName: 'lazy-implementer',
      },
      { toolCallId: '1' },
    );

    expect(dispatchSpy).toHaveBeenCalledWith({
      issueUrl: 'https://github.com/org/repo/issues/1',
      skillName: 'lazy-implementer',
      repoRoot: '/repo',
      permissionHandler: undefined,
    });
    expect(result).toMatchObject({
      structuredContent: {
        stopReason: 'end_turn',
        worktree: '/tmp/wt',
      },
    });

    vi.restoreAllMocks();
  });

  it('dispatch_reviewer calls dispatchReviewer', async () => {
    const dispatchSpy = vi.spyOn(reviewerDispatchModule, 'dispatchReviewer').mockResolvedValue({
      prUrl: 'https://github.com/org/repo/pull/2',
      worktreePath: '/tmp/wt',
      prompt: 'review',
      promptResult: { stopReason: 'end_turn' },
    });

    const tools = createDispatchTools({ repoRoot: '/repo' });
    const result = await tools.dispatch_reviewer!.execute!(
      {
        prUrl: 'https://github.com/org/repo/pull/2',
        skillName: 'review-bugbot',
        worktreePath: '/tmp/wt',
      },
      { toolCallId: '2' },
    );

    expect(dispatchSpy).toHaveBeenCalledWith({
      prUrl: 'https://github.com/org/repo/pull/2',
      skillName: 'review-bugbot',
      worktreePath: '/tmp/wt',
      issueUrl: undefined,
      repoRoot: '/repo',
      permissionHandler: undefined,
    });
    expect(result).toMatchObject({
      structuredContent: {
        prUrl: 'https://github.com/org/repo/pull/2',
        worktree: '/tmp/wt',
        stopReason: 'end_turn',
      },
    });

    vi.restoreAllMocks();
  });
});
