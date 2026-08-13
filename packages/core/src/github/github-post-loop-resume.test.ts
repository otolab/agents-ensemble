import { describe, expect, it } from 'vitest';
import type { GitHubUpdateItem } from './github-update-types.js';
import {
  canResumePostLoopForTurns,
  hasActionableIssueComment,
} from './github-post-loop-resume.js';

describe('hasActionableIssueComment', () => {
  it('returns true when issue.comment is present', () => {
    const items: GitHubUpdateItem[] = [
      { id: 'issue-comment:1', kind: 'issue.comment', summary: 'hello' },
    ];
    expect(hasActionableIssueComment(items)).toBe(true);
  });

  it('returns false for non-comment updates only', () => {
    const items: GitHubUpdateItem[] = [
      { id: 'ci:1', kind: 'ci.completed', summary: 'done' },
      { id: 'pr.review:1', kind: 'pr.review', summary: 'approved' },
    ];
    expect(hasActionableIssueComment(items)).toBe(false);
  });

  it('returns false for empty items', () => {
    expect(hasActionableIssueComment([])).toBe(false);
  });
});

describe('canResumePostLoopForTurns', () => {
  it('allows resume when turns remain', () => {
    expect(canResumePostLoopForTurns(0, 5)).toBe(true);
    expect(canResumePostLoopForTurns(4, 5)).toBe(true);
  });

  it('blocks resume when max-turns reached', () => {
    expect(canResumePostLoopForTurns(5, 5)).toBe(false);
    expect(canResumePostLoopForTurns(6, 5)).toBe(false);
  });

  it('allows resume when max-turns is unlimited', () => {
    expect(canResumePostLoopForTurns(100, 0)).toBe(true);
    expect(canResumePostLoopForTurns(100, -1)).toBe(true);
  });
});
