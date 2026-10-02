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
            lastAggregateBySha: {
              'sha-1': 'completed',
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

  it('deep-copies aggregate states when normalized', () => {
    const source = {
      pullRequests: {
        '42': {
          lastAggregateBySha: {
            'sha-1': 'running' as const,
          },
          ciBootstrapPending: true,
        },
      },
    };

    const normalized = normalizeGitHubMonitorCursor(source);
    expect(normalized.pullRequests?.['42']?.lastAggregateBySha).toEqual({
      'sha-1': 'running',
    });
    expect(normalized.pullRequests?.['42']?.lastAggregateBySha).not.toBe(
      source.pullRequests['42'].lastAggregateBySha,
    );
    expect(normalized.pullRequests?.['42']?.ciBootstrapPending).toBe(true);
  });

  it('resets legacy per-check CI cursors once on resume', () => {
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

    expect(normalized.pullRequests?.['42']).toEqual({});
  });

  it('drops invalid aggregate states while preserving valid ones', () => {
    const normalized = normalizeGitHubMonitorCursor({
      pullRequests: {
        '42': {
          lastAggregateBySha: {
            'sha-running': 'running',
            'sha-failed': 'failed',
            'sha-completed': 'completed',
            'sha-invalid': 'pending' as never,
          },
        },
      },
    });

    expect(normalized.pullRequests?.['42']?.lastAggregateBySha).toEqual({
      'sha-running': 'running',
      'sha-failed': 'failed',
      'sha-completed': 'completed',
    });
  });
});
