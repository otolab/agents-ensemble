import type { EnsembleConfig } from '../config/types.js';
import { resolveGitHubAuthToken } from './resolve-github-auth-token.js';

const GITHUB_REST_BASE = 'https://api.github.com';
const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';
const USER_AGENT = 'agents-ensemble';

export interface GitHubClientOptions {
  token: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

export interface GitHubRestIssue {
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string }>;
}

export interface GitHubIssueComment {
  id: number;
  body: string;
  html_url: string;
  user: { login: string };
  created_at: string;
}

export interface GitHubPullRequestRef {
  number: number;
  title: string;
  url: string;
  state: string;
}

export interface GitHubPullRequestReview {
  id: number;
  body: string;
  html_url: string;
  user: { login: string };
  state: string;
  submitted_at: string;
}

export interface GitHubPullRequestReviewComment {
  id: number;
  body: string;
  html_url: string;
  user: { login: string };
  path: string;
  created_at: string;
}

export interface GitHubClient {
  getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubRestIssue>;
  listIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<GitHubIssueComment[]>;
  searchLinkedPullRequests(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<GitHubPullRequestRef[]>;
  listPullRequestReviews(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<GitHubPullRequestReview[]>;
  listPullRequestReviewComments(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<GitHubPullRequestReviewComment[]>;
  getStatusCheckRollup(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<unknown[]>;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, options: { status: number; retryable?: boolean }) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export interface CreateGitHubClientOptions {
  config: EnsembleConfig;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  resolveTokenFn?: typeof resolveGitHubAuthToken;
}

export async function createGitHubClient(
  options: CreateGitHubClientOptions,
): Promise<GitHubClient> {
  const resolveTokenFn = options.resolveTokenFn ?? resolveGitHubAuthToken;
  const auth = await resolveTokenFn({
    config: options.config,
    env: options.env,
  });
  if (!auth.token) {
    throw new GitHubApiError('GitHub authentication token not found', {
      status: 401,
      retryable: false,
    });
  }

  return buildGitHubClient({
    token: auth.token,
    fetchFn: options.fetchFn,
    signal: options.signal,
  });
}

export function buildGitHubClient(options: GitHubClientOptions): GitHubClient {
  const fetchFn = options.fetchFn ?? fetch;

  const restRequest = async <T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> => {
    const url = path.startsWith('http') ? path : `${GITHUB_REST_BASE}${path}`;
    const response = await fetchFn(url, {
      ...init,
      signal: options.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      throw await createRestError(response);
    }

    return (await response.json()) as T;
  };

  const restPaginate = async <T>(path: string): Promise<T[]> => {
    const items: T[] = [];
    let nextUrl: string | undefined = path;

    while (nextUrl) {
      const url: string = nextUrl.startsWith('http') ? nextUrl : `${GITHUB_REST_BASE}${nextUrl}`;
      const response: Response = await fetchFn(url, {
        signal: options.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${options.token}`,
          'User-Agent': USER_AGENT,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (!response.ok) {
        throw await createRestError(response);
      }

      const page = (await response.json()) as T[];
      items.push(...page);
      nextUrl = parseLinkHeader(response.headers.get('link')).next;
    }

    return items;
  };

  const graphqlRequest = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const response = await fetchFn(GITHUB_GRAPHQL_URL, {
      method: 'POST',
      signal: options.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw await createRestError(response);
    }

    const payload = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };

    if (payload.errors?.length) {
      const message = payload.errors.map((error) => error.message).join('; ');
      throw new GitHubApiError(`GitHub GraphQL error: ${message}`, {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    if (!payload.data) {
      throw new GitHubApiError('GitHub GraphQL response missing data', {
        status: response.status,
        retryable: false,
      });
    }

    return payload.data;
  };

  return {
    async getIssue(owner, repo, issueNumber) {
      return restRequest<GitHubRestIssue>(`/repos/${owner}/${repo}/issues/${issueNumber}`);
    },

    async listIssueComments(owner, repo, issueNumber) {
      return restPaginate<GitHubIssueComment>(
        `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`,
      );
    },

    async searchLinkedPullRequests(owner, repo, issueNumber) {
      const query = encodeURIComponent(`${issueNumber} repo:${owner}/${repo} type:pr`);
      const data = await restRequest<{ items: GitHubPullRequestRef[] }>(
        `/search/issues?q=${query}&per_page=20`,
      );
      return data.items.filter((pr) => pr.state === 'OPEN' || pr.state === 'open');
    },

    async listPullRequestReviews(owner, repo, prNumber) {
      return restPaginate<GitHubPullRequestReview>(
        `/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`,
      );
    },

    async listPullRequestReviewComments(owner, repo, prNumber) {
      return restPaginate<GitHubPullRequestReviewComment>(
        `/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`,
      );
    },

    async getStatusCheckRollup(owner, repo, prNumber) {
      const query = `
        query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              statusCheckRollup {
                contexts(first: 100) {
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                      detailsUrl
                    }
                    ... on StatusContext {
                      context
                      state
                      targetUrl
                    }
                  }
                }
              }
            }
          }
        }
      `;

      type RollupResponse = {
        repository: {
          pullRequest: {
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                nodes: unknown[];
              };
            } | null;
          } | null;
        } | null;
      };

      const data = await graphqlRequest<RollupResponse>(query, {
        owner,
        name: repo,
        number: prNumber,
      });

      const rollup = data.repository?.pullRequest?.statusCheckRollup;
      if (!rollup) {
        return [];
      }

      return rollup.contexts.nodes ?? [];
    },
  };
}

async function createRestError(response: Response): Promise<GitHubApiError> {
  let detail = response.statusText;
  try {
    const body = (await response.json()) as { message?: string };
    if (body.message) {
      detail = body.message;
    }
  } catch {
    // ignore JSON parse errors
  }

  const remaining = response.headers.get('x-ratelimit-remaining');
  const retryable =
    response.status === 429 ||
    response.status >= 500 ||
    (response.status === 403 && remaining === '0');

  return new GitHubApiError(
    `GitHub API ${response.status}: ${detail}`,
    { status: response.status, retryable },
  );
}

function parseLinkHeader(header: string | null): { next?: string } {
  if (!header) {
    return {};
  }

  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === 'next') {
      return { next: match[1] };
    }
  }

  return {};
}
