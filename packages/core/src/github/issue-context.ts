import type { IssueRef } from '../issue/issue-ref.js';
import { parseIssueUrl } from '../issue/issue-ref.js';
import { runGh } from './run-gh.js';

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

interface GhIssueView {
  title: string;
  body: string;
  state: string;
  labels?: Array<{ name: string }>;
  comments?: Array<{
    author: { login: string };
    body: string;
    createdAt: string;
  }>;
}

export async function fetchIssueContext(issueUrl: string): Promise<IssueContext> {
  const issue = parseIssueUrl(issueUrl);
  const ref = `${issue.owner}/${issue.repo}#${issue.number}`;
  const stdout = await runGh([
    'issue',
    'view',
    ref,
    '--json',
    'title,body,state,labels,comments',
  ]);
  const data = JSON.parse(stdout) as GhIssueView;

  return {
    issue,
    title: data.title,
    body: data.body ?? '',
    state: data.state,
    labels: (data.labels ?? []).map((label) => label.name),
    comments: (data.comments ?? []).map((comment) => ({
      author: comment.author.login,
      body: comment.body,
      createdAt: comment.createdAt,
    })),
  };
}

export function formatIssueContextForPrompt(context: IssueContext): string {
  const lines = [
    `# Issue #${context.issue.number}: ${context.title}`,
    '',
    `URL: ${context.issue.url}`,
    `State: ${context.state}`,
  ];

  if (context.labels.length > 0) {
    lines.push(`Labels: ${context.labels.join(', ')}`);
  }

  lines.push('', '## Description', context.body || '(empty)');

  if (context.comments.length > 0) {
    lines.push('', '## Comments');
    for (const comment of context.comments) {
      lines.push(
        '',
        `### @${comment.author} (${comment.createdAt})`,
        comment.body,
      );
    }
  }

  return lines.join('\n');
}
