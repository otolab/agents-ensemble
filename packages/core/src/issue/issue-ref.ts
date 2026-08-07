export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

const ISSUE_URL_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/;

export function parseIssueUrl(issueUrl: string): IssueRef {
  const match = ISSUE_URL_RE.exec(issueUrl.trim());
  if (!match) {
    throw new Error(
      `Invalid GitHub Issue URL: ${issueUrl} (expected https://github.com/owner/repo/issues/123)`,
    );
  }

  const [, owner, repo, numberText] = match;
  return {
    owner: owner!,
    repo: repo!.replace(/\.git$/, ''),
    number: Number(numberText),
    url: issueUrl.trim().replace(/\/$/, ''),
  };
}

export function buildIssueUrl(issue: Pick<IssueRef, 'owner' | 'repo' | 'number'>): string {
  return `https://github.com/${issue.owner}/${issue.repo}/issues/${issue.number}`;
}
