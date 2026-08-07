import { describe, expect, it, vi } from 'vitest';
import * as acpBridgeModule from '../acp/acp-bridge.js';
import * as worktreeModule from '../worktree/worktree.js';
import { dispatchWorker } from './worker-dispatch.js';

describe('dispatchWorker', () => {
  it('creates worktree and runs ACP session', async () => {
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
    vi.spyOn(worktreeModule, 'createWorkerWorktree').mockResolvedValue(worktree);

    const result = await dispatchWorker({
      issueUrl: worktree.issue.url,
      skillName: 'lazy-implementer',
      repoRoot: '/repo',
      spawn: {
        command: 'fake-agent',
        args: ['acp'],
      },
    });

    expect(result.worktree).toEqual(worktree);
    expect(result.prompt).toContain('lazy-implementer');
    expect(result.promptResult.stopReason).toBe('end_turn');
    expect(connectSpy).toHaveBeenCalledOnce();

    connectSpy.mockRestore();
    vi.restoreAllMocks();
  });
});
