import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchReviewer as coreDispatchReviewer } from '@agents-ensemble/core';
import { registerReviewerDispatchCommand } from './dispatch-reviewer-command.js';

describe('registerReviewerDispatchCommand', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createProgram(
    dependencies: Parameters<typeof registerReviewerDispatchCommand>[1],
  ): Command {
    const program = new Command();
    const dispatch = program.command('dispatch');
    registerReviewerDispatchCommand(dispatch, dependencies);
    return program;
  }

  it('runs the reviewer action and prints its JSON result', async () => {
    const dispatchReviewer = vi.fn<typeof coreDispatchReviewer>();
    dispatchReviewer.mockResolvedValue({
      prUrl: 'https://github.com/org/repo/pull/2',
      worktreePath: '/repo/.ensemble/worktrees/issue-14',
      prompt: 'review',
      promptResult: { stopReason: 'end_turn' },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createProgram({ dispatchReviewer });

    await program.parseAsync(
      [
        'node',
        'ensemble',
        'dispatch',
        'reviewer',
        'https://github.com/org/repo/pull/2',
        '--skill',
        'pr-review',
        '--worktree-path',
        '/repo/.ensemble/worktrees/issue-14',
        '--repo-root',
        '/repo',
      ],
      { from: 'node' },
    );

    expect(dispatchReviewer).toHaveBeenCalledWith({
      prUrl: 'https://github.com/org/repo/pull/2',
      skillName: 'pr-review',
      worktreePath: '/repo/.ensemble/worktrees/issue-14',
      issueUrl: undefined,
      repoRoot: '/repo',
      permissionHandler: expect.any(Function),
    });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      prUrl: 'https://github.com/org/repo/pull/2',
      worktree: '/repo/.ensemble/worktrees/issue-14',
      stopReason: 'end_turn',
    });
  });

  it('reports dispatch failures and exits with status 1', async () => {
    const dispatchReviewer = vi.fn<typeof coreDispatchReviewer>();
    dispatchReviewer.mockRejectedValue(new Error('ACP failed'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.fn() as unknown as (code: number) => never;
    const program = createProgram({ dispatchReviewer, exit });

    await program.parseAsync(
      [
        'node',
        'ensemble',
        'dispatch',
        'reviewer',
        'https://github.com/org/repo/pull/2',
        '--skill',
        'pr-review',
        '--worktree-path',
        '/repo/.ensemble/worktrees/issue-14',
      ],
      { from: 'node' },
    );

    expect(error).toHaveBeenCalledWith('ACP failed');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
