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
      },
    ]);
  });
});
