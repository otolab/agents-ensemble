import { describe, expect, it, vi } from 'vitest';
import * as acpBridgeModule from '../acp/acp-bridge.js';
import * as worktreeModule from '../worktree/worktree.js';
import { dispatchReviewer } from './reviewer-dispatch.js';

describe('dispatchReviewer', () => {
  it('runs ACP session in an existing worktree', async () => {
    const connectSpy = vi.spyOn(acpBridgeModule.AcpBridge, 'connect').mockResolvedValue({
      runSession: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as acpBridgeModule.AcpBridge);

    const worktree = {
      path: '/tmp/issue-1',
      branch: 'ensemble/issue-1',
      issue: {
        owner: 'org',
        repo: 'repo',
        number: 1,
        url: 'https://github.com/org/repo/issues/1',
      },
    };

    const result = await dispatchReviewer({
      prUrl: 'https://github.com/org/repo/pull/2',
      skillName: 'review-bugbot',
      worktreePath: worktree.path,
      spawn: { command: 'fake-agent', args: ['acp'] },
    });

    expect(result.worktreePath).toBe(worktree.path);
    expect(result.prompt).toContain('https://github.com/org/repo/pull/2');
    expect(result.prompt).toContain('review-bugbot');
    expect(result.promptResult.stopReason).toBe('end_turn');
    expect(connectSpy).toHaveBeenCalledOnce();

    connectSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('resolves worktree from issueUrl and repoRoot', async () => {
    vi.spyOn(acpBridgeModule.AcpBridge, 'connect').mockResolvedValue({
      runSession: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as acpBridgeModule.AcpBridge);

    const worktree = {
      path: '/tmp/issue-3',
      branch: 'ensemble/issue-3',
      issue: {
        owner: 'org',
        repo: 'repo',
        number: 3,
        url: 'https://github.com/org/repo/issues/3',
      },
    };
    vi.spyOn(worktreeModule, 'resolveWorkerWorktree').mockResolvedValue(worktree);

    const result = await dispatchReviewer({
      prUrl: 'https://github.com/org/repo/pull/9',
      skillName: 'review-bugbot',
      issueUrl: worktree.issue.url,
      repoRoot: '/repo',
    });

    expect(result.worktreePath).toBe(worktree.path);
    vi.restoreAllMocks();
  });

  it('throws when worktree cannot be resolved', async () => {
    vi.spyOn(worktreeModule, 'resolveWorkerWorktree').mockResolvedValue(undefined);

    await expect(
      dispatchReviewer({
        prUrl: 'https://github.com/org/repo/pull/9',
        skillName: 'review-bugbot',
        issueUrl: 'https://github.com/org/repo/issues/3',
        repoRoot: '/repo',
      }),
    ).rejects.toThrow('Worker worktree not found');

    vi.restoreAllMocks();
  });
});
