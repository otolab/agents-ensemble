import { describe, expect, it, vi } from 'vitest';
import { fetchGitHubUpdates } from './fetch-github-updates.js';
import { emptyGitHubMonitorCursor } from './github-monitor-cursor.js';

const ISSUE_URL = 'https://github.com/org/repo/issues/39';

function mockGh(responses: Record<string, string>) {
  return vi.fn(async (args: string[]) => {
    const key = args.join(' ');
    if (responses[key] !== undefined) {
      return responses[key];
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
      'search prs repo:org/repo type:pr 39 --json number,title,url,state --limit 20':
        '[]',
    });

    const result = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: emptyGitHubMonitorCursor(),
      bootstrapOnly: true,
      runGhFn,
    });

    expect(result.updates).toEqual([]);
    expect(result.cursor.lastIssueCommentId).toBe('100');
  });

  it('detects new issue comments after cursor', async () => {
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
      'search prs repo:org/repo type:pr 39 --json number,title,url,state --limit 20':
        '[]',
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

  it('detects PR review comments and CI completion', async () => {
    const runGhFn = mockGh({
      'api repos/org/repo/issues/39/comments --paginate': '[]',
      'search prs repo:org/repo type:pr 39 --json number,title,url,state --limit 20':
        JSON.stringify([
          {
            number: 42,
            title: 'feat',
            url: 'https://github.com/org/repo/pull/42',
            state: 'OPEN',
          },
        ]),
      'api repos/org/repo/pulls/42/reviews --paginate': JSON.stringify([
        {
          id: 10,
          body: 'LGTM',
          html_url: 'https://github.com/org/repo/pull/42#pullrequestreview-10',
          user: { login: 'reviewer' },
          state: 'APPROVED',
          submitted_at: '2026-01-03T00:00:00Z',
        },
      ]),
      'api repos/org/repo/pulls/42/comments --paginate': JSON.stringify([
        {
          id: 20,
          body: 'nit: rename',
          html_url: 'https://github.com/org/repo/pull/42#discussion_r20',
          user: { login: 'reviewer' },
          path: 'src/foo.ts',
          created_at: '2026-01-03T01:00:00Z',
        },
      ]),
      'pr view 42 --repo org/repo --json statusCheckRollup': JSON.stringify({
        statusCheckRollup: {
          state: 'SUCCESS',
          contexts: [
            { context: 'ci/test', state: 'SUCCESS', targetUrl: 'https://ci.example/run/1' },
          ],
        },
      }),
    });

    const bootstrap = await fetchGitHubUpdates({
      issueUrl: ISSUE_URL,
      cursor: emptyGitHubMonitorCursor(),
      bootstrapOnly: true,
      runGhFn,
    });

    expect(bootstrap.updates).toEqual([]);
    expect(bootstrap.cursor.pullRequests?.['42']?.lastReviewId).toBe('10');
    expect(bootstrap.cursor.pullRequests?.['42']?.lastReviewCommentId).toBe('20');

    const pendingGh = mockGh({
      'api repos/org/repo/issues/39/comments --paginate': '[]',
      'search prs repo:org/repo type:pr 39 --json number,title,url,state --limit 20':
        JSON.stringify([
          {
            number: 42,
            title: 'feat',
            url: 'https://github.com/org/repo/pull/42',
            state: 'OPEN',
          },
        ]),
      'api repos/org/repo/pulls/42/reviews --paginate': JSON.stringify([
        {
          id: 10,
          body: 'LGTM',
          html_url: 'https://github.com/org/repo/pull/42#pullrequestreview-10',
          user: { login: 'reviewer' },
          state: 'APPROVED',
          submitted_at: '2026-01-03T00:00:00Z',
        },
      ]),
      'api repos/org/repo/pulls/42/comments --paginate': JSON.stringify([
        {
          id: 20,
          body: 'nit: rename',
          html_url: 'https://github.com/org/repo/pull/42#discussion_r20',
          user: { login: 'reviewer' },
          path: 'src/foo.ts',
          created_at: '2026-01-03T01:00:00Z',
        },
      ]),
      'pr view 42 --repo org/repo --json statusCheckRollup': JSON.stringify({
        statusCheckRollup: {
          state: 'SUCCESS',
          contexts: [
            { context: 'ci/test', state: 'SUCCESS', targetUrl: 'https://ci.example/run/1' },
          ],
        },
      }),
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
      runGhFn: pendingGh,
    });

    expect(withPending.updates).toHaveLength(1);
    expect(withPending.updates[0]).toMatchObject({
      kind: 'ci.completed',
      checkName: 'ci/test',
      checkConclusion: 'SUCCESS',
    });
  });
});
