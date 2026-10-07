import type { EnsembleConfig } from '../config/types.js';
import type { IssueRef } from '../issue/issue-ref.js';
import { parseIssueUrl } from '../issue/issue-ref.js';
import {
  createGitHubClient,
  type GitHubClient,
  type CreateGitHubClientOptions,
} from './github-client.js';

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}

/** GitHub 上のオペレータ実体（`GITHUB_TOKEN` / `gh auth token` のユーザ）。 */
export interface IssueContextOperator {
  githubLogin: string;
}

export interface IssueContext {
  issue: IssueRef;
  title: string;
  body: string;
  state: string;
  labels: string[];
  comments: IssueComment[];
  /** 解決できたときのみ。Issue / PR 本文の `@me` や author 照合に使う。 */
  operator?: IssueContextOperator;
}

export interface FetchIssueContextOptions {
  ensembleConfig: EnsembleConfig;
  githubClient?: GitHubClient;
  createClientOptions?: Omit<CreateGitHubClientOptions, 'config'>;
}

export async function fetchIssueContext(
  issueUrl: string,
  options: FetchIssueContextOptions,
): Promise<IssueContext> {
  const issue = parseIssueUrl(issueUrl);
  const client =
    options.githubClient ??
    (await createGitHubClient({
      config: options.ensembleConfig,
      ...options.createClientOptions,
    }));

  const [data, comments, authenticatedUser] = await Promise.all([
    client.getIssue(issue.owner, issue.repo, issue.number),
    client.listIssueComments(issue.owner, issue.repo, issue.number),
    client.getAuthenticatedUser().catch(() => undefined),
  ]);

  return {
    issue,
    title: data.title,
    body: data.body ?? '',
    state: data.state,
    labels: (data.labels ?? []).map((label) => label.name),
    comments: comments.map((comment) => ({
      author: comment.user.login,
      body: comment.body,
      createdAt: comment.created_at,
    })),
    ...(authenticatedUser?.login
      ? { operator: { githubLogin: authenticatedUser.login } }
      : {}),
  };
}
