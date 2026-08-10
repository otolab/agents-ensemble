import { mkdir } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IssueRef } from '../issue/issue-ref.js';
import { runGit } from '../git/run-git.js';

/** `isolated`: Issue 専用 worktree（既定）。`in_repo`: メイン worktree で直接作業する特別モード。 */
export type WorkerWorktreeMode = 'isolated' | 'in_repo';

export interface WorktreeRef {
  path: string;
  branch: string;
  issue: IssueRef;
  /** メイン worktree での直接作業（isolated worktree を使わない）。 */
  inRepo?: boolean;
}

export function workerBranchName(issue: Pick<IssueRef, 'number'>): string {
  return `ensemble/issue-${issue.number}`;
}

export function workerWorktreePath(
  repoRoot: string,
  issue: Pick<IssueRef, 'number'>,
): string {
  return join(repoRoot, '.ensemble', 'worktrees', `issue-${issue.number}`);
}

export async function resolveWorkerWorktree(
  repoRoot: string,
  issue: IssueRef,
): Promise<WorktreeRef | undefined> {
  const path = resolve(workerWorktreePath(repoRoot, issue));
  const listed = await listWorktrees(repoRoot);
  for (const entry of listed) {
    if (await pathsEqual(entry.path, path)) {
      return { path, branch: entry.branch, issue };
    }
  }
  return undefined;
}

/** Conductor / one-shot dispatch が Issue 向け作業ディレクトリを 1 回だけ決める。 */
export async function resolveWorkerWorkspace(
  repoRoot: string,
  issue: IssueRef,
  mode: WorkerWorktreeMode = 'isolated',
): Promise<WorktreeRef> {
  if (mode === 'in_repo') {
    return resolveInRepoWorkspace(repoRoot, issue);
  }
  return createWorkerWorktree(repoRoot, issue);
}

/** メイン worktree（repo root）で直接作業する。通常の isolated worktree は作らない。 */
export async function resolveInRepoWorkspace(
  repoRoot: string,
  issue: IssueRef,
): Promise<WorktreeRef> {
  const path = resolve(await realpathSafe(repoRoot));
  const branch = await currentBranch(repoRoot);
  return { path, branch, issue, inRepo: true };
}

export async function createWorkerWorktree(
  repoRoot: string,
  issue: IssueRef,
): Promise<WorktreeRef> {
  const existing = await resolveWorkerWorktree(repoRoot, issue);
  if (existing) return existing;

  const branch = workerBranchName(issue);
  const path = resolve(workerWorktreePath(repoRoot, issue));
  await mkdir(join(repoRoot, '.ensemble', 'worktrees'), { recursive: true });

  const branchExists = await gitBranchExists(repoRoot, branch);
  try {
    if (branchExists) {
      await runGit(['worktree', 'add', path, branch], repoRoot);
    } else {
      await runGit(['worktree', 'add', '-b', branch, path], repoRoot);
    }
  } catch (error) {
    const recovered = await resolveWorkerWorktree(repoRoot, issue);
    if (recovered) return recovered;

    const branchNowExists = await gitBranchExists(repoRoot, branch);
    if (!branchExists && branchNowExists) {
      try {
        await runGit(['worktree', 'add', path, branch], repoRoot);
        return { path, branch, issue };
      } catch (retryError) {
        const recoveredAfterRetry = await resolveWorkerWorktree(repoRoot, issue);
        if (recoveredAfterRetry) return recoveredAfterRetry;
        throw retryError;
      }
    }

    throw error;
  }

  return { path, branch, issue };
}

interface ListedWorktree {
  path: string;
  branch: string;
}

export async function listWorktrees(repoRoot: string): Promise<ListedWorktree[]> {
  const { stdout } = await runGit(['worktree', 'list', '--porcelain'], repoRoot);
  const entries: ListedWorktree[] = [];
  let currentPath: string | undefined;
  let currentBranch: string | undefined;

  const flush = () => {
    if (!currentPath) return;
    entries.push({
      path: currentPath,
      branch: currentBranch ?? 'detached',
    });
    currentPath = undefined;
    currentBranch = undefined;
  };

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      currentPath = line.slice('worktree '.length);
      continue;
    }
    if (line.startsWith('branch ')) {
      currentBranch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }

  flush();
  return entries;
}

async function currentBranch(repoRoot: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  return stdout.trim();
}

async function gitBranchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await runGit(['show-ref', '--verify', `refs/heads/${branch}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

async function pathsEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([realpathSafe(a), realpathSafe(b)]);
  return left === right;
}

async function realpathSafe(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}
