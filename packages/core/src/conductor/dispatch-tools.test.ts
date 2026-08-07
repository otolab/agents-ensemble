import { describe, expect, it, vi } from 'vitest';
import { createDispatchTools } from './dispatch-tools.js';
import * as workerDispatchModule from '../dispatch/worker-dispatch.js';

describe('createDispatchTools', () => {
  it('dispatch_worker calls dispatchWorker', async () => {
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
    });
    expect(result).toMatchObject({
      structuredContent: {
        stopReason: 'end_turn',
        worktree: '/tmp/wt',
      },
    });

    vi.restoreAllMocks();
  });
});
