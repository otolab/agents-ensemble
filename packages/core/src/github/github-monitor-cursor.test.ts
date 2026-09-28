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

  it('returns false when PR cursor has a CI observation state', () => {
    expect(
      isEmptyGitHubMonitorCursor({
        pullRequests: {
          '42': {
            lastObserved: {
              'ci/test': { phase: 'completed', conclusion: 'SUCCESS' },
            },
          },
        },
      }),
    ).toBe(false);
  });

  it('returns false when a PR needs a CI bootstrap retry', () => {
    expect(
      isEmptyGitHubMonitorCursor({
        pullRequests: {
          '42': { ciBootstrapPending: true },
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

  it('deep-copies CI snapshots when normalized', () => {
    const source = {
      pullRequests: {
        '42': {
          lastObserved: {
            'ci/test': { phase: 'pending' as const },
          },
          ciBootstrapPending: true,
        },
      },
    };

    const normalized = normalizeGitHubMonitorCursor(source);
    expect(normalized.pullRequests?.['42']?.lastObserved).toEqual({
      'ci/test': { phase: 'pending' },
    });
    expect(normalized.pullRequests?.['42']?.lastObserved).not.toBe(
      source.pullRequests['42'].lastObserved,
    );
    expect(normalized.pullRequests?.['42']?.ciBootstrapPending).toBe(true);
  });

  it('migrates legacy CI cursors to lastObserved once', () => {
    const normalized = normalizeGitHubMonitorCursor({
      pullRequests: {
        '42': {
          ciChecks: {
            'ci/old-pending': { runKey: 'run:1', status: 'pending' },
            'ci/old-completed': { runKey: 'run:2', status: 'completed' },
          },
          pendingCheckNames: ['ci/name-pending'],
          notifiedCheckNames: ['ci/name-completed'],
        },
      },
    });

    expect(normalized.pullRequests?.['42']).toEqual({
      lastObserved: {
        'ci/old-pending': { phase: 'pending' },
        'ci/old-completed': { phase: 'completed' },
        'ci/name-pending': { phase: 'pending' },
        'ci/name-completed': { phase: 'completed' },
      },
    });
  });
});
