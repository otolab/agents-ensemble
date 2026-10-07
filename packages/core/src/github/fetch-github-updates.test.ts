import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENSEMBLE_CONFIG } from '../config/defaults.js';
import {
  fetchGitHubUpdates,
  normalizeStatusCheckRollup,
} from './fetch-github-updates.js';
import { emptyGitHubMonitorCursor } from './github-monitor-cursor.js';
import type { GitHubClient } from './github-client.js';
import {
  GH_STATUS_CHECK_ROLLUP_COMPLETED_SUCCESS,
  GH_STATUS_CHECK_ROLLUP_IN_PROGRESS,
  GH_STATUS_CHECK_ROLLUP_MIXED_ISSUE_185,
  GH_STATUS_CHECK_ROLLUP_NON_STRING_CONCLUSION,
  GH_STATUS_CHECK_ROLLUP_STATUS_CONTEXT_NO_TYPENAME,
  GH_STATUS_CHECK_ROLLUP_STATUS_CONTEXT_PENDING,
  GH_STATUS_CHECK_ROLLUP_STATUS_CONTEXT_SUCCESS,
  GH_STATUS_CHECK_ROLLUP_WORKFLOW_RUN,
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
    getAuthenticatedUser: vi.fn().mockResolvedValue({ login: 'alice' }),
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

  it('polls explicitly registered PRs even when linked PR search is empty', async () => {
    const githubClient = createMockClient({
      searchLinkedPullRequests: vi.fn().mockResolvedValue([]),
    });

    const result = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: {
        ...emptyGitHubMonitorCursor(),
        explicitPullRequests: {
          '354': { registeredAt: '2026-09-07T05:00:00.000Z' },
        },
      },
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });

    expect(githubClient.listPullRequestReviews).toHaveBeenCalledWith(
      'org',
      'repo',
      354,
    );
    expect(githubClient.listPullRequestReviewComments).toHaveBeenCalledWith(
      'org',
      'repo',
      354,
    );
    expect(githubClient.getStatusCheckRollup).toHaveBeenCalledWith(
      'org',
      'repo',
      354,
    );
    expect(result.cursor.pullRequests?.['354']).toMatchObject({
      lastAggregateBySha: {},
    });
  });

  it('stops polling an explicit-only PR after its watch is removed', async () => {
    const listPullRequestReviews = vi.fn().mockResolvedValue([]);
    const listPullRequestReviewComments = vi.fn().mockResolvedValue([]);
    const getStatusCheckRollup = vi.fn().mockResolvedValue([]);
    const cursor = {
      pullRequests: { '354': { lastReviewId: '10' } },
      explicitPullRequests: {},
    };
    const result = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient: createMockClient({
        searchLinkedPullRequests: vi.fn().mockResolvedValue([]),
        listPullRequestReviews,
        listPullRequestReviewComments,
        getStatusCheckRollup,
      }),
    });

    expect(listPullRequestReviews).not.toHaveBeenCalled();
    expect(listPullRequestReviewComments).not.toHaveBeenCalled();
    expect(getStatusCheckRollup).not.toHaveBeenCalled();
    expect(result.cursor.pullRequests?.['354']).toEqual({
      lastReviewId: '10',
    });
  });

  it('continues polling a Search-linked PR after its explicit watch is removed', async () => {
    const linkedPr = {
      number: 354,
      title: 'feat',
      url: 'https://github.com/org/repo/pull/354',
      state: 'OPEN',
    };
    const githubClient = createMockClient({
      searchLinkedPullRequests: vi.fn().mockResolvedValue([linkedPr]),
      listPullRequestReviews: vi.fn().mockResolvedValue([
        {
          id: 11,
          body: 'new review',
          html_url: 'https://github.com/org/repo/pull/354#pullrequestreview-11',
          user: { login: 'reviewer' },
          state: 'APPROVED',
          submitted_at: '2026-09-07T05:00:00.000Z',
        },
      ]),
    });

    const result = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: {
        pullRequests: { '354': { lastReviewId: '10' } },
        explicitPullRequests: {},
      },
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });

    expect(result.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'pr-review:11', kind: 'pr.review' }),
      ]),
    );
    expect(githubClient.listPullRequestReviews).toHaveBeenCalledWith(
      'org',
      'repo',
      354,
    );
  });

  it('bootstraps a newly registered PR before notifying its existing updates', async () => {
    const reviews = [
      {
        id: 10,
        body: 'existing review',
        html_url: 'https://github.com/org/repo/pull/354#pullrequestreview-10',
        user: { login: 'reviewer' },
        state: 'APPROVED',
        submitted_at: '2026-09-07T05:00:00.000Z',
      },
    ];
    const reviewComments = [
      {
        id: 20,
        body: 'existing comment',
        html_url: 'https://github.com/org/repo/pull/354#discussion_r20',
        user: { login: 'reviewer' },
        path: 'src/index.ts',
        created_at: '2026-09-07T05:00:00.000Z',
      },
    ];
    const githubClient = createMockClient({
      searchLinkedPullRequests: vi.fn().mockResolvedValue([]),
      listPullRequestReviews: vi.fn().mockResolvedValue(reviews),
      listPullRequestReviewComments: vi.fn().mockResolvedValue(reviewComments),
    });

    const bootstrap = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: {
        ...emptyGitHubMonitorCursor(),
        explicitPullRequests: {
          '354': { registeredAt: '2026-09-07T05:00:00.000Z' },
        },
      },
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });

    expect(bootstrap.updates).toEqual([]);
    expect(bootstrap.cursor.pullRequests?.['354']).toMatchObject({
      lastReviewId: '10',
      lastReviewCommentId: '20',
    });

    const nextPoll = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: bootstrap.cursor,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient: createMockClient({
        searchLinkedPullRequests: vi.fn().mockResolvedValue([]),
        listPullRequestReviews: vi.fn().mockResolvedValue([
          ...reviews,
          {
            ...reviews[0]!,
            id: 11,
            body: 'new review',
          },
        ]),
        listPullRequestReviewComments: vi.fn().mockResolvedValue([
          ...reviewComments,
          {
            ...reviewComments[0]!,
            id: 21,
            body: 'new comment',
          },
        ]),
      }),
    });

    expect(nextPoll.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'pr-review:11', kind: 'pr.review' }),
        expect.objectContaining({
          id: 'pr-review-comment:21',
          kind: 'pr.review_comment',
        }),
      ]),
    );
  });

  it('limits explicit PR polling to its configured kinds', async () => {
    const listPullRequestReviewComments = vi.fn().mockResolvedValue([]);
    const getStatusCheckRollup = vi.fn().mockResolvedValue([]);
    const githubClient = createMockClient({
      searchLinkedPullRequests: vi.fn().mockResolvedValue([]),
      listPullRequestReviews: vi.fn().mockResolvedValue([
        {
          id: 11,
          body: 'new review',
          html_url: 'https://github.com/org/repo/pull/354#pullrequestreview-11',
          user: { login: 'reviewer' },
          state: 'APPROVED',
          submitted_at: '2026-09-07T05:00:00.000Z',
        },
      ]),
      listPullRequestReviewComments,
      getStatusCheckRollup,
    });

    const result = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: {
        pullRequests: { '354': { lastReviewId: '10' } },
        explicitPullRequests: {
          '354': {
            registeredAt: '2026-09-07T05:00:00.000Z',
            kinds: ['pr.review'],
          },
        },
      },
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });

    expect(result.updates).toMatchObject([
      expect.objectContaining({ id: 'pr-review:11', kind: 'pr.review' }),
    ]);
    expect(listPullRequestReviewComments).not.toHaveBeenCalled();
    expect(getStatusCheckRollup).not.toHaveBeenCalled();
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
    expect(bootstrap.cursor.pullRequests?.['42']?.lastAggregateBySha).toEqual({
      'sha-1': 'running',
    });

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
            lastAggregateBySha: { 'sha-1': 'running' },
          },
        },
      },
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient: completedClient,
    });

    expect(withPending.updates).toHaveLength(1);
    expect(withPending.updates[0]).toMatchObject({
      kind: 'ci.completed',
      commitSha: 'sha-1',
      aggregateState: 'completed',
    });
  });

  it('emits one aggregate update for each SHA state transition', async () => {
    const rollups = [
      [
        {
          __typename: 'CheckRun',
          id: 'check-run-1',
          name: 'ci/test',
          status: 'IN_PROGRESS',
          conclusion: null,
          headSha: 'sha-1',
          startedAt: '2026-09-07T05:00:00.000Z',
        },
      ],
      [
        {
          __typename: 'CheckRun',
          id: 'check-run-1',
          name: 'ci/test',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          headSha: 'sha-1',
          completedAt: '2026-09-07T05:01:00.000Z',
        },
      ],
      [
        {
          __typename: 'CheckRun',
          id: 'check-run-2',
          name: 'ci/test',
          status: 'IN_PROGRESS',
          conclusion: null,
          headSha: 'sha-1',
          startedAt: '2026-09-07T05:02:00.000Z',
        },
      ],
      [
        {
          __typename: 'CheckRun',
          id: 'check-run-2',
          name: 'ci/test',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          headSha: 'sha-1',
          completedAt: '2026-09-07T05:03:00.000Z',
        },
      ],
    ];
    let poll = 0;
    const githubClient = createMockClient({
      searchLinkedPullRequests: vi.fn().mockResolvedValue([...PR_SEARCH]),
      getStatusCheckRollup: vi.fn(async () => rollups[poll++] ?? []),
    });

    let cursor = emptyGitHubMonitorCursor();
    const results = [];
    for (let index = 0; index < rollups.length; index += 1) {
      const result = await fetchGitHubUpdates({
        issueUrl: ISSUE_URL,
        cursor,
        ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
        githubClient,
      });
      results.push(result);
      cursor = result.cursor;
    }

    expect(results[0]?.updates).toEqual([]);
    expect(results[1]?.updates).toMatchObject([
      expect.objectContaining({
        kind: 'ci.completed',
        commitSha: 'sha-1',
        aggregateState: 'failed',
        failedCheckNames: ['ci/test'],
      }),
    ]);
    expect(results[2]?.updates).toMatchObject([
      expect.objectContaining({
        kind: 'ci.completed',
        commitSha: 'sha-1',
        aggregateState: 'running',
      }),
    ]);
    expect(results[3]?.updates).toMatchObject([
      expect.objectContaining({
        kind: 'ci.completed',
        commitSha: 'sha-1',
        aggregateState: 'completed',
      }),
    ]);
    expect(cursor.pullRequests?.['42']?.lastAggregateBySha).toEqual({
      'sha-1': 'completed',
    });
  });

  it('uses a completed registration snapshot as baseline and detects a conclusion change', async () => {
    const firstRun = {
      __typename: 'CheckRun',
      id: 'check-run-1',
      name: 'ci/test',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      headSha: 'sha-1',
      completedAt: '2026-09-07T05:00:00.000Z',
    };
    const secondRun = { ...firstRun, conclusion: 'FAILURE' };
    let rollup = [firstRun];
    const githubClient = createMockClient({
      searchLinkedPullRequests: vi.fn().mockResolvedValue([...PR_SEARCH]),
      getStatusCheckRollup: vi.fn(async () => rollup),
    });

    const baseline = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: emptyGitHubMonitorCursor(),
      initialCursorPoll: true,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });
    expect(baseline.updates).toEqual([]);
    expect(baseline.cursor.pullRequests?.['42']?.lastAggregateBySha).toEqual({
      'sha-1': 'completed',
    });

    const sameRun = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: baseline.cursor,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });
    expect(sameRun.updates).toEqual([]);

    rollup = [secondRun];
    const laterRun = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: sameRun.cursor,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });
    expect(laterRun.updates).toMatchObject([
      expect.objectContaining({
        kind: 'ci.completed',
        commitSha: 'sha-1',
        aggregateState: 'failed',
        failedCheckNames: ['ci/test'],
      }),
    ]);
  });

  it.each([
    {
      label: 'running -> completed',
      previous: 'running',
      checks: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
      expectedNotification: true,
      expectedState: 'completed',
    },
    {
      label: 'running -> failed',
      previous: 'running',
      checks: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
      expectedNotification: true,
      expectedState: 'failed',
    },
    {
      label: 'failed -> running after re-run',
      previous: 'failed',
      checks: [{ status: 'IN_PROGRESS', conclusion: null }],
      expectedNotification: true,
      expectedState: 'running',
    },
    {
      label: 'same completed aggregate state',
      previous: 'completed',
      checks: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
      expectedNotification: false,
      expectedState: 'completed',
    },
    {
      label: 'same failed aggregate state',
      previous: 'failed',
      checks: [{ status: 'COMPLETED', conclusion: 'CANCELLED' }],
      expectedNotification: false,
      expectedState: 'failed',
    },
  ] as const)('notifies only for aggregate state changes: $label', async ({
    previous,
    checks,
    expectedNotification,
    expectedState,
  }) => {
    const githubClient = createMockClient({
      searchLinkedPullRequests: vi.fn().mockResolvedValue([...PR_SEARCH]),
      getStatusCheckRollup: vi.fn().mockResolvedValue([
        ...checks.map((check) => ({
          __typename: 'CheckRun',
          name: 'ci/test',
          headSha: 'sha-1',
          ...check,
        })),
      ]),
    });

    const result = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: {
        pullRequests: {
          '42': { lastAggregateBySha: { 'sha-1': previous } },
        },
      },
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });

    expect(result.updates.some((update) => update.kind === 'ci.completed')).toBe(
      expectedNotification,
    );
    expect(result.cursor.pullRequests?.['42']?.lastAggregateBySha).toEqual({
      'sha-1': expectedState,
    });
  });

  it.each([
    {
      label: 'all skip',
      checks: [{ name: 'ci/skip', status: 'COMPLETED', conclusion: 'SKIPPED' }],
    },
    {
      label: 'skip and complete mixed',
      checks: [
        { name: 'ci/skip', status: 'COMPLETED', conclusion: 'NEUTRAL' },
        { name: 'ci/test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    },
  ])('$label aggregates to completed', async ({ checks }) => {
    const result = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: {
        pullRequests: {
          '42': { lastAggregateBySha: { 'sha-1': 'running' } },
        },
      },
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient: createMockClient({
        searchLinkedPullRequests: vi.fn().mockResolvedValue([...PR_SEARCH]),
        getStatusCheckRollup: vi.fn().mockResolvedValue(
          checks.map((check) => ({
            __typename: 'CheckRun',
            headSha: 'sha-1',
            detailsUrl: 'https://example.test/ci',
            ...check,
          })),
        ),
      }),
    });

    expect(result.updates).toMatchObject([
      expect.objectContaining({
        aggregateState: 'completed',
        commitSha: 'sha-1',
      }),
    ]);
    expect(result.cursor.pullRequests?.['42']?.lastAggregateBySha).toEqual({
      'sha-1': 'completed',
    });
  });

  it('aggregates a running check before a completed check', async () => {
    const result = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: {
        pullRequests: {
          '42': { lastAggregateBySha: { 'sha-1': 'completed' } },
        },
      },
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient: createMockClient({
        searchLinkedPullRequests: vi.fn().mockResolvedValue([...PR_SEARCH]),
        getStatusCheckRollup: vi.fn().mockResolvedValue([
          {
            __typename: 'CheckRun',
            name: 'ci/test',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            headSha: 'sha-1',
          },
          {
            __typename: 'CheckRun',
            name: 'ci/slow',
            status: 'IN_PROGRESS',
            conclusion: null,
            headSha: 'sha-1',
          },
        ]),
      }),
    });

    expect(result.updates).toMatchObject([
      expect.objectContaining({ aggregateState: 'running', commitSha: 'sha-1' }),
    ]);
    expect(result.hasPendingCi).toBe(true);
  });

  it('keeps PR wakeup active when any current SHA aggregate is running', async () => {
    const result = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: {
        pullRequests: {
          '42': {
            lastAggregateBySha: {
              'sha-1': 'completed',
              'sha-2': 'completed',
            },
          },
        },
      },
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient: createMockClient({
        searchLinkedPullRequests: vi.fn().mockResolvedValue([...PR_SEARCH]),
        getStatusCheckRollup: vi.fn().mockResolvedValue([
          {
            __typename: 'CheckRun',
            name: 'ci/old-sha',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            headSha: 'sha-1',
          },
          {
            __typename: 'CheckRun',
            name: 'ci/new-sha',
            status: 'IN_PROGRESS',
            conclusion: null,
            headSha: 'sha-2',
          },
        ]),
      }),
    });

    expect(result.hasPendingCi).toBe(true);
    expect(result.updates).toMatchObject([
      expect.objectContaining({
        commitSha: 'sha-2',
        aggregateState: 'running',
      }),
    ]);
  });

  it('excludes a check when its SHA cannot be resolved', async () => {
    const result = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: emptyGitHubMonitorCursor(),
      initialCursorPoll: true,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient: createMockClient({
        searchLinkedPullRequests: vi.fn().mockResolvedValue([...PR_SEARCH]),
        getStatusCheckRollup: vi.fn().mockResolvedValue([
          {
            __typename: 'CheckRun',
            name: 'ci/no-sha',
            status: 'IN_PROGRESS',
            conclusion: null,
          },
        ]),
      }),
    });

    expect(result.updates).toEqual([]);
    expect(result.hasPendingCi).toBe(false);
    expect(result.cursor.pullRequests?.['42']?.lastAggregateBySha).toEqual({});
  });

  it('keeps the last aggregate when a rollup check is temporarily missing', async () => {
    const completedRun = {
      __typename: 'CheckRun',
      name: 'ci/test',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      headSha: 'sha-1',
    };
    let rollup: object[] = [completedRun];
    const githubClient = createMockClient({
      searchLinkedPullRequests: vi.fn().mockResolvedValue([...PR_SEARCH]),
      getStatusCheckRollup: vi.fn(async () => rollup),
    });

    const baseline = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: emptyGitHubMonitorCursor(),
      initialCursorPoll: true,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });

    rollup = [];
    const missing = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: baseline.cursor,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });
    expect(missing.updates).toEqual([]);
    expect(missing.cursor.pullRequests?.['42']?.lastAggregateBySha).toEqual({
      'sha-1': 'completed',
    });

    rollup = [completedRun];
    const restored = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: missing.cursor,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });
    expect(restored.updates).toEqual([]);
  });

  it('retries a failed CI bootstrap before tracking completion', async () => {
    const pendingRun = {
      __typename: 'CheckRun',
      id: 'check-run-1',
      name: 'ci/test',
      status: 'IN_PROGRESS',
      conclusion: null,
      headSha: 'sha-1',
      startedAt: '2026-09-07T05:00:00.000Z',
    };
    const completedRun = {
      ...pendingRun,
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      completedAt: '2026-09-07T05:01:00.000Z',
    };
    let statusPoll = 0;
    const githubClient = createMockClient({
      searchLinkedPullRequests: vi.fn().mockResolvedValue([...PR_SEARCH]),
      getStatusCheckRollup: vi.fn(async () => {
        statusPoll += 1;
        if (statusPoll === 1) {
          throw new Error('temporary status API failure');
        }
        return statusPoll === 2 ? [pendingRun] : [completedRun];
      }),
    });
    const registeredCursor = {
      ...emptyGitHubMonitorCursor(),
      explicitPullRequests: {
        '42': { registeredAt: '2026-09-07T05:00:00.000Z' },
      },
    };

    const failedBootstrap = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: registeredCursor,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });
    expect(failedBootstrap.updates).toEqual([]);
    expect(failedBootstrap.errors).toMatchObject([
      { phase: 'pr_status_checks', prNumber: 42 },
    ]);
    expect(failedBootstrap.cursor.pullRequests?.['42']).toMatchObject({
      ciBootstrapPending: true,
    });
    expect(failedBootstrap.cursor.pullRequests?.['42']?.ciChecks).toBeUndefined();

    const pending = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: failedBootstrap.cursor,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });
    expect(pending.updates).toEqual([]);
    expect(pending.cursor.pullRequests?.['42']).toMatchObject({
      lastAggregateBySha: {
        'sha-1': 'running',
      },
    });
    expect(pending.cursor.pullRequests?.['42']).not.toHaveProperty(
      'ciBootstrapPending',
    );

    const completed = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: pending.cursor,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });
    expect(completed.updates).toMatchObject([
      expect.objectContaining({
        kind: 'ci.completed',
        commitSha: 'sha-1',
        aggregateState: 'completed',
      }),
    ]);
  });

  it('retries bootstrap for a Search-discovered PR and emits completion', async () => {
    const completedRun = {
      __typename: 'CheckRun',
      id: 'check-run-search-1',
      name: 'ci/test',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      headSha: 'sha-1',
      completedAt: '2026-09-07T05:01:00.000Z',
    };
    let statusPoll = 0;
    const githubClient = createMockClient({
      searchLinkedPullRequests: vi.fn().mockResolvedValue([...PR_SEARCH]),
      getStatusCheckRollup: vi.fn(async () => {
        statusPoll += 1;
        if (statusPoll === 1) {
          throw new Error('temporary status API failure');
        }
        return [completedRun];
      }),
    });
    const existingSessionCursor = {
      lastIssueCommentId: '100',
      pullRequests: {},
    };

    const failedBootstrap = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: existingSessionCursor,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });
    expect(failedBootstrap.errors).toMatchObject([
      { phase: 'pr_status_checks', prNumber: 42 },
    ]);
    expect(failedBootstrap.cursor.pullRequests?.['42']).toMatchObject({
      ciBootstrapPending: true,
    });

    const completed = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: failedBootstrap.cursor,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });
    expect(completed.updates).toHaveLength(1);
    expect(completed.updates[0]).toMatchObject({
      kind: 'ci.completed',
      commitSha: 'sha-1',
      aggregateState: 'completed',
    });
    expect(completed.cursor.pullRequests?.['42']?.lastAggregateBySha).toEqual({
      'sha-1': 'completed',
    });
  });

  it('resets legacy CI cursors and records the current SHA baseline', async () => {
    const completedRun = {
      __typename: 'CheckRun',
      id: 'check-run-1',
      name: 'ci/test',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      headSha: 'sha-1',
      completedAt: '2026-09-07T05:01:00.000Z',
    };
    const createClient = () =>
      createMockClient({
        searchLinkedPullRequests: vi.fn().mockResolvedValue([...PR_SEARCH]),
        getStatusCheckRollup: vi.fn().mockResolvedValue([completedRun]),
      });

    const migratedPending = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: {
        pullRequests: {
          '42': { pendingCheckNames: ['ci/test'] },
        },
      },
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient: createClient(),
    });
    expect(migratedPending.updates).toEqual([]);
    expect(migratedPending.cursor.pullRequests?.['42']?.lastAggregateBySha).toEqual({
      'sha-1': 'completed',
    });

    const migratedNotifiedOnly = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: {
        pullRequests: {
          '42': { notifiedCheckNames: ['ci/test'] },
        },
      },
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient: createClient(),
    });
    expect(migratedNotifiedOnly.updates).toEqual([]);
    expect(migratedNotifiedOnly.cursor.pullRequests?.['42']?.lastAggregateBySha).toEqual({
      'sha-1': 'completed',
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
    expect(bootstrap.cursor.pullRequests?.['42']?.lastAggregateBySha).toEqual({
      'sha-1': 'running',
    });

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
            lastAggregateBySha: { 'sha-1': 'running' },
          },
        },
      },
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient: completedClient,
    });

    expect(withPending.updates).toHaveLength(1);
    expect(withPending.updates[0]).toMatchObject({
      kind: 'ci.completed',
      commitSha: 'sha-1',
      aggregateState: 'completed',
    });
  });

  it('handles Issue #185 rollup fixtures without throwing (toUpperCase regression)', async () => {
    expect(() => normalizeStatusCheckRollup([...GH_STATUS_CHECK_ROLLUP_MIXED_ISSUE_185])).not.toThrow();
    const normalized = normalizeStatusCheckRollup([...GH_STATUS_CHECK_ROLLUP_MIXED_ISSUE_185]);
    expect(normalized).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ci/legacy-no-typename', status: 'IN_PROGRESS' }),
        expect.objectContaining({ name: 'ci/broken-conclusion', status: 'COMPLETED', conclusion: null }),
        expect.objectContaining({ name: 'ci/test', status: 'COMPLETED', conclusion: 'SUCCESS' }),
      ]),
    );
    expect(normalized.find((check) => check.name === 'ci/workflow')).toBeUndefined();
  });

  it('continues issue comment monitoring when one PR statusCheckRollup fails', async () => {
    const pr42 = {
      number: 42,
      title: 'feat',
      url: 'https://github.com/org/repo/pull/42',
      state: 'OPEN',
    };
    const pr43 = {
      number: 43,
      title: 'fix',
      url: 'https://github.com/org/repo/pull/43',
      state: 'OPEN',
    };

    const githubClient = createMockClient({
      listIssueComments: vi.fn().mockResolvedValue([
        {
          id: 101,
          body: 'new comment',
          html_url: 'https://github.com/org/repo/issues/39#issuecomment-101',
          user: { login: 'bob' },
          created_at: '2026-01-02T00:00:00Z',
        },
      ]),
      searchLinkedPullRequests: vi.fn().mockResolvedValue([pr42, pr43]),
      getStatusCheckRollup: vi.fn(async (_owner, _repo, prNumber) => {
        if (prNumber === 42) {
          throw new TypeError("Cannot read properties of undefined (reading 'toUpperCase')");
        }
        return [...GH_STATUS_CHECK_ROLLUP_STATUS_CONTEXT_PENDING];
      }),
    });

    const result = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: { lastIssueCommentId: '100', pullRequests: {} },
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });

    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]?.kind).toBe('issue.comment');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      phase: 'pr_status_checks',
      prNumber: 42,
      cause: 'parse',
    });
    expect(result.cursor.pullRequests?.['43']?.lastAggregateBySha).toEqual({
      'sha-1': 'running',
    });
  });

  it('reports pr_search errors while continuing issue comment monitoring', async () => {
    const githubClient = createMockClient({
      listIssueComments: vi.fn().mockResolvedValue([
        {
          id: 101,
          body: 'new comment',
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
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      phase: 'pr_search',
      cause: 'unknown',
    });
  });

  it('does not re-notify when rollup identity fields drift', async () => {
    let poll = 0;
    const makeChecks = (keyMode: 'url' | 'runId') =>
      Array.from({ length: 7 }, (_, i) => ({
        __typename: 'CheckRun',
        ...(keyMode === 'runId' ? { id: `run-${i}` } : {}),
        name: `ci/job-${i}`,
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        headSha: 'sha-1',
        detailsUrl: `https://github.com/org/repo/actions/runs/${i}`,
      }));
    const githubClient = createMockClient({
      searchLinkedPullRequests: vi.fn().mockResolvedValue([...PR_SEARCH]),
      getStatusCheckRollup: vi.fn(async () =>
        poll++ % 2 === 0 ? makeChecks('url') : makeChecks('runId'),
      ),
    });

    let cursor = emptyGitHubMonitorCursor();
    const bootstrap = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor,
      initialCursorPoll: true,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });
    cursor = bootstrap.cursor;

    for (let i = 0; i < 4; i++) {
      const result = await fetchGitHubUpdates({
        issueUrl: ISSUE_URL,
        cursor,
        ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
        githubClient,
      });
      expect(result.updates).toEqual([]);
      cursor = result.cursor;
    }
  });

  it('baselines a newly observed head SHA independently', async () => {
    const firstRun = {
      __typename: 'CheckRun',
      id: 'check-run-1',
      name: 'ci/test',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      headSha: 'sha-1',
    };
    const secondRun = { ...firstRun, headSha: 'sha-2' };
    let rollup: object[] = [firstRun];
    const githubClient = createMockClient({
      searchLinkedPullRequests: vi.fn().mockResolvedValue([...PR_SEARCH]),
      getStatusCheckRollup: vi.fn(async () => rollup),
    });

    const bootstrap = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: emptyGitHubMonitorCursor(),
      initialCursorPoll: true,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });
    expect(bootstrap.updates).toEqual([]);

    const steady = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: bootstrap.cursor,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });
    expect(steady.updates).toEqual([]);

    rollup = [secondRun];
    const rerun = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: steady.cursor,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      githubClient,
    });
    expect(rerun.updates).toEqual([]);
    expect(rerun.cursor.pullRequests?.['42']?.lastAggregateBySha).toEqual({
      'sha-1': 'completed',
      'sha-2': 'completed',
    });
  });

  it('normalizes StatusContext without __typename and non-string conclusion', () => {
    const normalized = normalizeStatusCheckRollup([
      ...GH_STATUS_CHECK_ROLLUP_STATUS_CONTEXT_NO_TYPENAME,
      ...GH_STATUS_CHECK_ROLLUP_NON_STRING_CONCLUSION,
      ...GH_STATUS_CHECK_ROLLUP_WORKFLOW_RUN,
    ]);

    expect(normalized).toEqual([
      {
        name: 'ci/legacy-no-typename',
        status: 'IN_PROGRESS',
        conclusion: null,
        headSha: 'sha-1',
        detailsUrl: 'https://github.com/org/repo/actions/runs/3',
      },
      {
        name: 'ci/broken-conclusion',
        status: 'COMPLETED',
        conclusion: null,
        headSha: 'sha-1',
        detailsUrl: 'https://github.com/org/repo/actions/runs/4',
      },
    ]);
  });

  it('resolves SHA from GraphQL CheckRun and StatusContext commit fields', () => {
    const normalized = normalizeStatusCheckRollup([
      {
        __typename: 'CheckRun',
        name: 'ci/check-run',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        checkSuite: { commit: { oid: 'sha-check-run' } },
      },
      {
        __typename: 'StatusContext',
        context: 'ci/status-context',
        state: 'SUCCESS',
        commit: { oid: 'sha-status-context' },
      },
    ]);

    expect(normalized).toEqual([
      expect.objectContaining({ name: 'ci/check-run', headSha: 'sha-check-run' }),
      expect.objectContaining({
        name: 'ci/status-context',
        headSha: 'sha-status-context',
      }),
    ]);
  });
});
