import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENSEMBLE_CONFIG } from '../config/defaults.js';
import { fetchGitHubUpdates } from './fetch-github-updates.js';
import { emptyGitHubMonitorCursor } from './github-monitor-cursor.js';
import type { GitHubClient } from './github-client.js';
import {
  GH_STATUS_CHECK_ROLLUP_COMPLETED_SUCCESS,
  GH_STATUS_CHECK_ROLLUP_IN_PROGRESS,
  GH_STATUS_CHECK_ROLLUP_STATUS_CONTEXT_PENDING,
  GH_STATUS_CHECK_ROLLUP_STATUS_CONTEXT_SUCCESS,
} from './github-test-fixtures.js';

const ISSUE_URL = 'https://github.com/org/repo/issues/39';

const PR_SEARCH = [
  {
    number: 42,
    title: 'feat',
    url: 'https://github.com/org/repo/pull/42',
    state: 'OPEN',
  },
] as const;

function createMockClient(handlers: Partial<GitHubClient>): GitHubClient {
  return {
    getIssue: vi.fn(),
    listIssueComments: vi.fn().mockResolvedValue([]),
    searchLinkedPullRequests: vi.fn().mockResolvedValue([]),
    listPullRequestReviews: vi.fn().mockResolvedValue([]),
    listPullRequestReviewComments: vi.fn().mockResolvedValue([]),
    getStatusCheckRollup: vi.fn().mockResolvedValue([]),
    ...handlers,
  };
}

describe('fetchGitHubUpdates', () => {
  it('bootstraps cursor without emitting historical comments', async () => {
    const githubClient = createMockClient({
      listIssueComments: vi.fn().mockResolvedValue([
        {
          id: 100,
          body: 'old comment',
          html_url: 'https://github.com/org/repo/issues/39#issuecomment-100',
          user: { login: 'alice' },
          created_at: '2026-01-01T00:00:00Z',
        },
      ]),
    });

    const result = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: emptyGitHubMonitorCursor(),
      initialCursorPoll: true,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });

    expect(result.updates).toEqual([]);
    expect(result.cursor.lastIssueCommentId).toBe('100');
    expect(githubClient.searchLinkedPullRequests).toHaveBeenCalledWith('org', 'repo', 39);
  });

  it('detects new issue comments after cursor (resume / offline diff)', async () => {
    const githubClient = createMockClient({
      listIssueComments: vi.fn().mockResolvedValue([
        {
          id: 100,
          body: 'old',
          html_url: 'https://github.com/org/repo/issues/39#issuecomment-100',
          user: { login: 'alice' },
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 101,
          body: 'new operator message',
          html_url: 'https://github.com/org/repo/issues/39#issuecomment-101',
          user: { login: 'bob' },
          created_at: '2026-01-02T00:00:00Z',
        },
      ]),
    });

    const result = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: { lastIssueCommentId: '100', pullRequests: {} },
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });

    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]).toMatchObject({
      kind: 'issue.comment',
      author: 'bob',
      summary: 'Issue コメント（@bob）',
    });
    expect(result.cursor.lastIssueCommentId).toBe('101');
  });

  it('continues issue comment monitoring when PR search fails', async () => {
    const githubClient = createMockClient({
      listIssueComments: vi.fn().mockResolvedValue([
        {
          id: 101,
          body: 'new while pr search broken',
          html_url: 'https://github.com/org/repo/issues/39#issuecomment-101',
          user: { login: 'bob' },
          created_at: '2026-01-02T00:00:00Z',
        },
      ]),
      searchLinkedPullRequests: vi.fn().mockRejectedValue(new Error('Invalid search query')),
    });

    const result = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: { lastIssueCommentId: '100', pullRequests: {} },
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });

    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]?.kind).toBe('issue.comment');
  });

  it('detects PR review comments and CI completion with real statusCheckRollup shape', async () => {
    const reviews = [
      {
        id: 10,
        body: 'LGTM',
        html_url: 'https://github.com/org/repo/pull/42#pullrequestreview-10',
        user: { login: 'reviewer' },
        state: 'APPROVED',
        submitted_at: '2026-01-03T00:00:00Z',
      },
    ];
    const reviewComments = [
      {
        id: 20,
        body: 'nit: rename',
        html_url: 'https://github.com/org/repo/pull/42#discussion_r20',
        user: { login: 'reviewer' },
        path: 'src/foo.ts',
        created_at: '2026-01-03T01:00:00Z',
      },
    ];

    const bootstrapClient = createMockClient({
      searchLinkedPullRequests: vi.fn().mockResolvedValue([...PR_SEARCH]),
      listPullRequestReviews: vi.fn().mockResolvedValue(reviews),
      listPullRequestReviewComments: vi.fn().mockResolvedValue(reviewComments),
      getStatusCheckRollup: vi
        .fn()
        .mockResolvedValue([...GH_STATUS_CHECK_ROLLUP_IN_PROGRESS]),
    });

    const bootstrap = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: emptyGitHubMonitorCursor(),
      initialCursorPoll: true,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient: bootstrapClient,
    });

    expect(bootstrap.updates).toEqual([]);
    expect(bootstrap.cursor.pullRequests?.['42']?.lastReviewId).toBe('10');
    expect(bootstrap.cursor.pullRequests?.['42']?.pendingCheckNames).toEqual([
      'ci/test',
    ]);

    const completedClient = createMockClient({
      searchLinkedPullRequests: vi.fn().mockResolvedValue([...PR_SEARCH]),
      listPullRequestReviews: vi.fn().mockResolvedValue(reviews),
      listPullRequestReviewComments: vi.fn().mockResolvedValue(reviewComments),
      getStatusCheckRollup: vi
        .fn()
        .mockResolvedValue([...GH_STATUS_CHECK_ROLLUP_COMPLETED_SUCCESS]),
    });

    const withPending = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: {
        ...bootstrap.cursor,
        pullRequests: {
          '42': {
            ...bootstrap.cursor.pullRequests!['42']!,
            pendingCheckNames: ['ci/test'],
          },
        },
      },
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient: completedClient,
    });

    expect(withPending.updates).toHaveLength(1);
    expect(withPending.updates[0]).toMatchObject({
      kind: 'ci.completed',
      checkName: 'ci/test',
      checkConclusion: 'SUCCESS',
    });
  });

  it('handles StatusContext entries in statusCheckRollup without throwing', async () => {
    const bootstrapClient = createMockClient({
      searchLinkedPullRequests: vi.fn().mockResolvedValue([...PR_SEARCH]),
      getStatusCheckRollup: vi
        .fn()
        .mockResolvedValue([...GH_STATUS_CHECK_ROLLUP_STATUS_CONTEXT_PENDING]),
    });

    const bootstrap = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: emptyGitHubMonitorCursor(),
      initialCursorPoll: true,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient: bootstrapClient,
    });

    expect(bootstrap.updates).toEqual([]);
    expect(bootstrap.cursor.pullRequests?.['42']?.pendingCheckNames).toEqual([
      'ci/legacy',
    ]);

    const completedClient = createMockClient({
      searchLinkedPullRequests: vi.fn().mockResolvedValue([...PR_SEARCH]),
      getStatusCheckRollup: vi
        .fn()
        .mockResolvedValue([...GH_STATUS_CHECK_ROLLUP_STATUS_CONTEXT_SUCCESS]),
    });

    const withPending = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: {
        ...bootstrap.cursor,
        pullRequests: {
          '42': {
            ...bootstrap.cursor.pullRequests!['42']!,
            pendingCheckNames: ['ci/legacy'],
          },
        },
      },
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient: completedClient,
    });

    expect(withPending.updates).toHaveLength(1);
    expect(withPending.updates[0]).toMatchObject({
      kind: 'ci.completed',
      checkName: 'ci/legacy',
      checkConclusion: 'SUCCESS',
    });
  });
});
