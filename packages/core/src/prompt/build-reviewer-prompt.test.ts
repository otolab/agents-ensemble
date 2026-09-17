import { describe, expect, it } from 'vitest';
import { buildReviewerPrompt } from './build-reviewer-prompt.js';

describe('buildReviewerPrompt', () => {
  it('includes the independent bootstrap, PR, Skill, and existing worktree', () => {
    const prompt = buildReviewerPrompt({
      prUrl: 'https://github.com/org/repo/pull/2',
      skillName: 'pr-review',
      worktreePath: '/repo/.ensemble/worktrees/issue-14',
    });

    expect(prompt).toContain(
      'personaとfoundationモードを有効にしてください。本文をresourceから読み込むのも忘れずに。',
    );
    expect(prompt).toContain('https://github.com/org/repo/pull/2');
    expect(prompt).toContain('レビュー Skill: pr-review');
    expect(prompt).toContain(
      'worktreeを作成しているので、そこに入って検討します。',
    );
    expect(prompt).toContain(
      '作業 worktree: /repo/.ensemble/worktrees/issue-14',
    );
  });
});
