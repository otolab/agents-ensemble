import { describe, expect, it, vi } from 'vitest';
import { WorkerSession } from './worker-session.js';

describe('WorkerSession', () => {
  it('starts workers at bootstrap without conductor tools', async () => {
    const dispatchWorker = vi.fn().mockResolvedValue({
      issue: {
        owner: 'org',
        repo: 'repo',
        number: 1,
        url: 'https://github.com/org/repo/issues/1',
      },
      worktree: {
        path: '/repo/.ensemble/worktrees/issue-1',
        branch: 'ensemble/issue-1',
        issue: {
          owner: 'org',
          repo: 'repo',
          number: 1,
          url: 'https://github.com/org/repo/issues/1',
        },
      },
      prompt: 'work',
      promptResult: { stopReason: 'end_turn' },
    });

    const session = new WorkerSession({
      issueUrl: 'https://github.com/org/repo/issues/1',
      repoRoot: '/repo',
      workers: [{ name: 'ping-1', kind: 'ping', systemPrompt: 'pong only' }],
      dispatchWorker,
      decidePermission: () => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      }),
    });

    session.bootstrap();
    await session.stop();

    expect(session.startedWorkerIds).toHaveLength(1);
    expect(dispatchWorker).toHaveBeenCalledOnce();
  });
});
