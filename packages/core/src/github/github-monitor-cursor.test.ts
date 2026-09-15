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

  it('returns false when PR cursor has a CI execution state', () => {
    expect(
      isEmptyGitHubMonitorCursor({
        pullRequests: {
          '42': {
            ciChecks: {
              'ci/test': { runKey: 'run:123', status: 'completed' },
            },
          },
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

  it('deep-copies run-aware CI cursors when normalized', () => {
    const source = {
      pullRequests: {
        '42': {
          ciChecks: {
            'ci/test': { runKey: 'run:123', status: 'pending' as const },
          },
        },
      },
    };

    const normalized = normalizeGitHubMonitorCursor(source);
    expect(normalized.pullRequests?.['42']?.ciChecks).toEqual({
      'ci/test': { runKey: 'run:123', status: 'pending' },
    });
    expect(normalized.pullRequests?.['42']?.ciChecks).not.toBe(
      source.pullRequests['42'].ciChecks,
    );
  });
});
