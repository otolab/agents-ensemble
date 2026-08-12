import { describe, expect, it } from 'vitest';
import {
  emptyGitHubMonitorCursor,
  isEmptyGitHubMonitorCursor,
} from './github-monitor-cursor.js';

describe('isEmptyGitHubMonitorCursor', () => {
  it('returns true for empty cursor', () => {
    expect(isEmptyGitHubMonitorCursor(emptyGitHubMonitorCursor())).toBe(true);
  });

  it('returns false when issue comment cursor exists', () => {
    expect(
      isEmptyGitHubMonitorCursor({
        lastIssueCommentId: '100',
        pullRequests: {},
      }),
    ).toBe(false);
  });

  it('returns false when PR cursor has review state', () => {
    expect(
      isEmptyGitHubMonitorCursor({
        pullRequests: {
          '42': { lastReviewId: '10' },
        },
      }),
    ).toBe(false);
  });
});
