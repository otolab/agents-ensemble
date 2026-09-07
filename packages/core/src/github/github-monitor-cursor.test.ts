import { describe, expect, it } from 'vitest';
import {
  emptyGitHubMonitorCursor,
  isEmptyGitHubMonitorCursor,
  normalizeGitHubMonitorCursor,
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

  it('preserves explicit pull request watches when normalized', () => {
    const cursor = normalizeGitHubMonitorCursor({
      explicitPullRequests: {
        '354': {
          registeredAt: '2026-09-07T05:00:00.000Z',
          kinds: ['pr.review', 'ci.completed'],
        },
      },
    });

    expect(cursor.explicitPullRequests).toEqual({
      '354': {
        registeredAt: '2026-09-07T05:00:00.000Z',
        kinds: ['pr.review', 'ci.completed'],
      },
    });
  });
});
