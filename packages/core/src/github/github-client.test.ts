import { describe, expect, it, vi } from 'vitest';
import { buildGitHubClient, GitHubApiError } from './github-client.js';

describe('buildGitHubClient', () => {
  it('paginates REST list endpoints via Link header', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: {
            Link: '<https://api.github.com/next>; rel="next"',
          },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 2 }]), { status: 200 }));

    const client = buildGitHubClient({ token: 'test-token', fetchFn });
    const comments = await client.listIssueComments('org', 'repo', 39);

    expect(comments).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws GitHubApiError on non-OK REST responses', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }),
    );
    const client = buildGitHubClient({ token: 'test-token', fetchFn });

    await expect(client.getIssue('org', 'repo', 1)).rejects.toMatchObject({
      status: 401,
    } satisfies Partial<GitHubApiError>);
  });

  it('maps GraphQL statusCheckRollup nodes', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                statusCheckRollup: {
                  contexts: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        __typename: 'CheckRun',
                        name: 'ci/test',
                        status: 'COMPLETED',
                        conclusion: 'SUCCESS',
                        detailsUrl: 'https://example.com',
                        checkSuite: { commit: { oid: 'sha-1' } },
                      },
                    ],
                  },
                },
              },
            },
          },
        }),
        { status: 200 },
      ),
    );

    const client = buildGitHubClient({ token: 'test-token', fetchFn });
    const rollup = await client.getStatusCheckRollup('org', 'repo', 42);

    expect(rollup).toEqual([
      {
        __typename: 'CheckRun',
        name: 'ci/test',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://example.com',
        checkSuite: { commit: { oid: 'sha-1' } },
      },
    ]);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.github.com/graphql',
      expect.objectContaining({
        body: expect.stringContaining('checkSuite'),
      }),
    );
    expect((fetchFn.mock.calls[0]?.[1] as RequestInit).body).toEqual(
      expect.stringContaining('commit'),
    );
  });

  it('returns bounded linked PR head, per-check, review, and truncation details', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            repository: {
              issue: {
                timelineItems: {
                  pageInfo: { hasNextPage: true },
                  nodes: [
                    {
                      source: {
                        number: 743,
                        title: 'Discover repository runs',
                        url: 'https://github.com/org/repo/pull/743',
                        state: 'OPEN',
                        headRefName: 'feature/743',
                        headRefOid: 'head-sha',
                        reviewDecision: 'REVIEW_REQUIRED',
                        statusCheckRollup: {
                          contexts: {
                            pageInfo: { hasNextPage: true },
                            nodes: [
                              {
                                __typename: 'CheckRun',
                                name: 'unit',
                                status: 'COMPLETED',
                                conclusion: 'SUCCESS',
                                detailsUrl: 'https://example.com/check',
                                checkSuite: { commit: { oid: 'check-sha' } },
                              },
                              {
                                __typename: 'StatusContext',
                                context: 'build/legacy',
                                state: 'PENDING',
                                targetUrl: 'https://example.com/status',
                                commit: { oid: 'status-sha' },
                              },
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
        { status: 200 },
      ),
    );
    const client = buildGitHubClient({ token: 'test-token', fetchFn });

    await expect(
      client.getIssuePullRequestSummaries!('org', 'repo', 743),
    ).resolves.toEqual({
      pullRequests: [
        {
          number: 743,
          title: 'Discover repository runs',
          url: 'https://github.com/org/repo/pull/743',
          state: 'OPEN',
          headRefName: 'feature/743',
          headRefOid: 'head-sha',
          reviewDecision: 'REVIEW_REQUIRED',
          checks: [
            {
              type: 'check_run',
              name: 'unit',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
              url: 'https://example.com/check',
              headSha: 'check-sha',
            },
            {
              type: 'status_context',
              name: 'build/legacy',
              status: 'PENDING',
              conclusion: null,
              url: 'https://example.com/status',
              headSha: 'status-sha',
            },
          ],
          checksTruncated: true,
        },
      ],
      pullRequestsTruncated: true,
    });
    const request = JSON.parse(
      (fetchFn.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as { query: string; variables: Record<string, unknown> };
    expect(request.query).toContain('timelineItems');
    expect(request.query).toContain('CROSS_REFERENCED_EVENT');
    expect(request.query).toContain('first: 5');
    expect(request.query).toContain('contexts(first: 20)');
    expect(request.variables).toEqual({
      owner: 'org',
      name: 'repo',
      number: 743,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
