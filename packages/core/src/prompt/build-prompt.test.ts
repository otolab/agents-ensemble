import { describe, expect, it } from 'vitest';
import { buildReviewerPrompt, buildWorkerPrompt } from './build-prompt.js';

describe('buildWorkerPrompt', () => {
  it('includes issue URL, kind, and agent system prompt', () => {
    const prompt = buildWorkerPrompt({
      issueUrl: 'https://github.com/org/repo/issues/1',
      kind: 'ping',
      systemPrompt: 'respond with pong',
      worktreePath: '/tmp/wt',
    });

    expect(prompt).toContain('https://github.com/org/repo/issues/1');
    expect(prompt).toContain('agent kind: ping');
    expect(prompt).toContain('respond with pong');
    expect(prompt).not.toContain('Skill:');
  });
});

describe('buildReviewerPrompt', () => {
  it('includes review skill name', () => {
    const prompt = buildReviewerPrompt({
      prUrl: 'https://github.com/org/repo/pull/1',
      skillName: 'review-bugbot',
      worktreePath: '/tmp/wt',
    });

    expect(prompt).toContain('review-bugbot');
  });
});
