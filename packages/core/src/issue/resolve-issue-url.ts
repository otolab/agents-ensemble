import { runGit } from '../git/run-git.js';
import { buildIssueUrl, parseIssueUrl } from './issue-ref.js';

const ISSUE_NUMBER_RE = /^#?(\d+)$/;
const HTTPS_GITHUB_REMOTE_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const SSH_GITHUB_REMOTE_RE =
  /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/;

export function parseGitHubRemoteUrl(
  remoteUrl: string,
): { owner: string; repo: string } | null {
  const trimmed = remoteUrl.trim();
  const httpsMatch = HTTPS_GITHUB_REMOTE_RE.exec(trimmed);
  if (httpsMatch) {
    return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };
  }

  const sshMatch = SSH_GITHUB_REMOTE_RE.exec(trimmed);
  if (sshMatch) {
    return { owner: sshMatch[1]!, repo: sshMatch[2]! };
  }

  return null;
}

async function resolveGitHubOwnerRepoFromOrigin(
  repoRoot: string,
): Promise<{ owner: string; repo: string }> {
  let remoteUrl: string;
  try {
    const result = await runGit(['remote', 'get-url', 'origin'], repoRoot);
    remoteUrl = result.stdout.trim();
  } catch {
    throw new Error(
      `Cannot resolve GitHub repository from ${repoRoot}: not a git repository or origin remote is missing`,
    );
  }

  const parsed = parseGitHubRemoteUrl(remoteUrl);
  if (!parsed) {
    throw new Error(
      `Cannot resolve GitHub repository from origin: ${remoteUrl} (expected a github.com remote URL)`,
    );
  }

  return parsed;
}

export async function resolveIssueUrl(
  input: string,
  repoRoot: string,
): Promise<string> {
  const trimmed = input.trim();

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return parseIssueUrl(trimmed).url;
  }

  const shorthandMatch = ISSUE_NUMBER_RE.exec(trimmed);
  if (shorthandMatch) {
    const number = Number(shorthandMatch[1]);
    const { owner, repo } = await resolveGitHubOwnerRepoFromOrigin(repoRoot);
    return buildIssueUrl({ owner, repo, number });
  }

  throw new Error(
    `Invalid issue reference: ${input} (expected GitHub Issue URL or issue number like 31 or #31)`,
  );
}
