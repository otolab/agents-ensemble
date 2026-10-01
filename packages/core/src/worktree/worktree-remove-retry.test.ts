import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseIssueUrl } from '../issue/issue-ref.js';
import { removeWorkerWorktree } from './worktree.js';

const { mockRunGit } = vi.hoisted(() => ({
  mockRunGit: vi.fn(),
}));

vi.mock('../git/run-git.js', () => ({
  runGit: mockRunGit,
}));

const ISSUE = parseIssueUrl('https://github.com/org/repo/issues/7');
const REPO_ROOT = '/repo';
const WORKTREE_PATH = '/repo/.ensemble/worktrees/issue-7';

describe('removeWorkerWorktree retry', () => {
  beforeEach(() => {
    mockRunGit.mockReset();
    mockRunGit.mockImplementation(async (args: string[]) => {
      if (args.join(' ') === 'worktree list --porcelain') {
        return {
          stdout: [
            `worktree ${REPO_ROOT}`,
            'HEAD root-sha',
            `branch refs/heads/main`,
            `worktree ${WORKTREE_PATH}`,
            'HEAD worker-sha',
            'branch refs/heads/ensemble/issue-7',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      if (args.join(' ') === 'status --porcelain') {
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected git invocation: ${args.join(' ')}`);
    });
  });

  it('retries transient remove failures and preserves the final git error', async () => {
    let removeAttempts = 0;
    mockRunGit.mockImplementation(async (args: string[]) => {
      if (args.join(' ') === 'worktree list --porcelain') {
        return {
          stdout: [
            `worktree ${REPO_ROOT}`,
            'HEAD root-sha',
            'branch refs/heads/main',
            `worktree ${WORKTREE_PATH}`,
            'HEAD worker-sha',
            'branch refs/heads/ensemble/issue-7',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      if (args.join(' ') === 'status --porcelain') {
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        removeAttempts += 1;
        throw new Error(`git remove failed attempt ${removeAttempts}`);
      }
      throw new Error(`unexpected git invocation: ${args.join(' ')}`);
    });

    const result = await removeWorkerWorktree(REPO_ROOT, ISSUE);

    expect(result).toEqual({
      status: 'failed',
      path: WORKTREE_PATH,
      branch: 'ensemble/issue-7',
      error: 'git remove failed attempt 3',
    });
    expect(removeAttempts).toBe(3);
  });
});
