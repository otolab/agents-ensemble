import { describe, expect, it } from 'vitest';
import { buildReviewerPrompt, buildWorkerPrompt } from './build-prompt.js';

describe('buildWorkerPrompt', () => {
  it('includes issue URL, skill, and worktree path', () => {
    const prompt = buildWorkerPrompt({
      issueUrl: 'https://github.com/org/repo/issues/1',
      skillName: 'lazy-implementer',
      worktreePath: '/repo/.ensemble/worktrees/issue-1',
    });

    expect(prompt).toContain('https://github.com/org/repo/issues/1');
    expect(prompt).toContain('lazy-implementer');
    expect(prompt).toContain('/repo/.ensemble/worktrees/issue-1');
    expect(prompt).toContain('personaとfoundationモード');
  });
});

describe('buildReviewerPrompt', () => {
  it('includes PR URL and worktree', () => {
    const prompt = buildReviewerPrompt({
      prUrl: 'https://github.com/org/repo/pull/2',
      skillName: 'review-bugbot',
      worktreePath: '/repo/.ensemble/worktrees/issue-1',
    });

    expect(prompt).toContain('https://github.com/org/repo/pull/2');
    expect(prompt).toContain('review-bugbot');
  });
});
