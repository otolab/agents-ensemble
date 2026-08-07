import { describe, expect, it } from 'vitest';
import { buildConductorFollowUpPrompt } from './build-conductor-follow-up-prompt.js';

describe('buildConductorFollowUpPrompt', () => {
  it('includes fresh issue context and dispatch summaries', () => {
    const prompt = buildConductorFollowUpPrompt({
      issueContext: {
        issue: {
          owner: 'org',
          repo: 'repo',
          number: 1,
          url: 'https://github.com/org/repo/issues/1',
        },
        title: 'Add feature',
        body: 'body',
        state: 'OPEN',
        labels: [],
        comments: [],
      },
      repoRoot: '/repo',
      turn: 2,
      maxTurns: 5,
      workerDispatches: [
        {
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
        },
      ],
      reviewerDispatches: [
        {
          prUrl: 'https://github.com/org/repo/pull/2',
          worktreePath: '/repo/.ensemble/worktrees/issue-1',
          prompt: 'review',
          promptResult: { stopReason: 'end_turn' },
        },
      ],
    });

    expect(prompt).toContain('Add feature');
    expect(prompt).toContain('dispatch_reviewer');
    expect(prompt).toContain('https://github.com/org/repo/pull/2');
    expect(prompt).toContain('ターン: 2 / 5');
  });
});
