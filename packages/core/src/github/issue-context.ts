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

export interface IssueContext {
  issue: IssueRef;
  title: string;
  body: string;
  state: string;
  labels: string[];
  comments: IssueComment[];
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

  const [data, comments] = await Promise.all([
    client.getIssue(issue.owner, issue.repo, issue.number),
    client.listIssueComments(issue.owner, issue.repo, issue.number),
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
  };
}
