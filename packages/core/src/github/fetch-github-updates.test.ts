import { describe, expect, it, vi } from 'vitest';
import { fetchGitHubUpdates } from './fetch-github-updates.js';
import { emptyGitHubMonitorCursor } from './github-monitor-cursor.js';
import {
  GH_STATUS_CHECK_ROLLUP_COMPLETED_SUCCESS,
  GH_STATUS_CHECK_ROLLUP_IN_PROGRESS,
  GH_STATUS_CHECK_ROLLUP_STATUS_CONTEXT_PENDING,
  GH_STATUS_CHECK_ROLLUP_STATUS_CONTEXT_SUCCESS,
  ghPrViewStatusCheckRollupJson,
} from './github-test-fixtures.js';

const ISSUE_URL = 'https://github.com/org/repo/issues/39';
const SEARCH_PRS_KEY =
  'search prs 39 --repo org/repo --json number,title,url,state --limit 20';

function mockGh(responses: Record<string, string | Error>) {
  return vi.fn(async (args: string[]) => {
    const key = args.join(' ');
    const response = responses[key];
    if (response instanceof Error) {
      throw response;
    }
    if (response !== undefined) {
      return response;
    }
    throw new Error(`unexpected gh call: ${key}`);
  });
}

describe('fetchGitHubUpdates', () => {
  it('bootstraps cursor without emitting historical comments', async () => {
    const runGhFn = mockGh({
      'api repos/org/repo/issues/39/comments --paginate': JSON.stringify([
        {
          id: 100,
          body: 'old comment',
          html_url: 'https://github.com/org/repo/issues/39#issuecomment-100',
          user: { login: 'alice' },
          created_at: '2026-01-01T00:00:00Z',
        },
      ]),
      [SEARCH_PRS_KEY]: '[]',
    });

    const result = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: emptyGitHubMonitorCursor(),
      initialCursorPoll: true,
      runGhFn,
    });

    expect(result.updates).toEqual([]);
    expect(result.cursor.lastIssueCommentId).toBe('100');
    expect(runGhFn).toHaveBeenCalledWith(
      expect.arrayContaining(['search', 'prs', '39', '--repo', 'org/repo']),
      expect.anything(),
    );
  });

  it('detects new issue comments after cursor (resume / offline diff)', async () => {
    const runGhFn = mockGh({
      'api repos/org/repo/issues/39/comments --paginate': JSON.stringify([
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
      [SEARCH_PRS_KEY]: '[]',
    });

    const result = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: { lastIssueCommentId: '100', pullRequests: {} },
      runGhFn,
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
    const runGhFn = mockGh({
      'api repos/org/repo/issues/39/comments --paginate': JSON.stringify([
        {
          id: 101,
          body: 'new while pr search broken',
          html_url: 'https://github.com/org/repo/issues/39#issuecomment-101',
          user: { login: 'bob' },
          created_at: '2026-01-02T00:00:00Z',
        },
      ]),
      [SEARCH_PRS_KEY]: new Error(
        'gh search prs failed: Invalid search query',
      ),
    });

    const result = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: { lastIssueCommentId: '100', pullRequests: {} },
      runGhFn,
    });

    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]?.kind).toBe('issue.comment');
  });

  it('detects PR review comments and CI completion with real statusCheckRollup shape', async () => {
    const prSearch = JSON.stringify([
      {
        number: 42,
        title: 'feat',
        url: 'https://github.com/org/repo/pull/42',
        state: 'OPEN',
      },
    ]);
    const reviews = JSON.stringify([
      {
        id: 10,
        body: 'LGTM',
        html_url: 'https://github.com/org/repo/pull/42#pullrequestreview-10',
        user: { login: 'reviewer' },
        state: 'APPROVED',
        submitted_at: '2026-01-03T00:00:00Z',
      },
    ]);
    const reviewComments = JSON.stringify([
      {
        id: 20,
        body: 'nit: rename',
        html_url: 'https://github.com/org/repo/pull/42#discussion_r20',
        user: { login: 'reviewer' },
        path: 'src/foo.ts',
        created_at: '2026-01-03T01:00:00Z',
      },
    ]);

    const bootstrapGh = mockGh({
      'api repos/org/repo/issues/39/comments --paginate': '[]',
      [SEARCH_PRS_KEY]: prSearch,
      'api repos/org/repo/pulls/42/reviews --paginate': reviews,
      'api repos/org/repo/pulls/42/comments --paginate': reviewComments,
      'pr view 42 --repo org/repo --json statusCheckRollup':
        ghPrViewStatusCheckRollupJson(GH_STATUS_CHECK_ROLLUP_IN_PROGRESS),
    });

    const bootstrap = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: emptyGitHubMonitorCursor(),
      initialCursorPoll: true,
      runGhFn: bootstrapGh,
    });

    expect(bootstrap.updates).toEqual([]);
    expect(bootstrap.cursor.pullRequests?.['42']?.lastReviewId).toBe('10');
    expect(bootstrap.cursor.pullRequests?.['42']?.pendingCheckNames).toEqual([
      'ci/test',
    ]);

    const completedGh = mockGh({
      'api repos/org/repo/issues/39/comments --paginate': '[]',
      [SEARCH_PRS_KEY]: prSearch,
      'api repos/org/repo/pulls/42/reviews --paginate': reviews,
      'api repos/org/repo/pulls/42/comments --paginate': reviewComments,
      'pr view 42 --repo org/repo --json statusCheckRollup':
        ghPrViewStatusCheckRollupJson(GH_STATUS_CHECK_ROLLUP_COMPLETED_SUCCESS),
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
      runGhFn: completedGh,
    });

    expect(withPending.updates).toHaveLength(1);
    expect(withPending.updates[0]).toMatchObject({
      kind: 'ci.completed',
      checkName: 'ci/test',
      checkConclusion: 'SUCCESS',
    });
  });

  it('handles StatusContext entries in statusCheckRollup without throwing', async () => {
    const prSearch = JSON.stringify([
      {
        number: 42,
        title: 'feat',
        url: 'https://github.com/org/repo/pull/42',
        state: 'OPEN',
      },
    ]);

    const bootstrapGh = mockGh({
      'api repos/org/repo/issues/39/comments --paginate': '[]',
      [SEARCH_PRS_KEY]: prSearch,
      'api repos/org/repo/pulls/42/reviews --paginate': '[]',
      'api repos/org/repo/pulls/42/comments --paginate': '[]',
      'pr view 42 --repo org/repo --json statusCheckRollup':
        ghPrViewStatusCheckRollupJson(GH_STATUS_CHECK_ROLLUP_STATUS_CONTEXT_PENDING),
    });

    const bootstrap = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: emptyGitHubMonitorCursor(),
      initialCursorPoll: true,
      runGhFn: bootstrapGh,
    });

    expect(bootstrap.updates).toEqual([]);
    expect(bootstrap.cursor.pullRequests?.['42']?.pendingCheckNames).toEqual([
      'ci/legacy',
    ]);

    const completedGh = mockGh({
      'api repos/org/repo/issues/39/comments --paginate': '[]',
      [SEARCH_PRS_KEY]: prSearch,
      'api repos/org/repo/pulls/42/reviews --paginate': '[]',
      'api repos/org/repo/pulls/42/comments --paginate': '[]',
      'pr view 42 --repo org/repo --json statusCheckRollup':
        ghPrViewStatusCheckRollupJson(GH_STATUS_CHECK_ROLLUP_STATUS_CONTEXT_SUCCESS),
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
      runGhFn: completedGh,
    });

    expect(withPending.updates).toHaveLength(1);
    expect(withPending.updates[0]).toMatchObject({
      kind: 'ci.completed',
      checkName: 'ci/legacy',
      checkConclusion: 'SUCCESS',
    });
  });
});
