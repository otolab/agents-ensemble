import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IssueRef } from '../issue/issue-ref.js';
import { runGit } from '../git/run-git.js';
import { resolveEnsemblePaths } from '../ensemble-paths.js';

/** `isolated`: Issue 専用 worktree（既定）。`in_repo`: メイン worktree で直接作業する特別モード。 */
export type WorkerWorktreeMode = 'isolated' | 'in_repo';

export interface WorktreeRef {
  path: string;
  branch: string;
  issue: IssueRef;
  /** メイン worktree での直接作業（isolated worktree を使わない）。 */
  inRepo?: boolean;
}

export interface ResolveWorkerWorkspaceOptions {
  /** Resume resolves or safely recreates this clone's Issue worktree. */
  resume?: boolean;
  onNotice?: (message: string) => void;
}

export function workerBranchName(issue: Pick<IssueRef, 'number'>): string {
  return `ensemble/issue-${issue.number}`;
}

export function workerWorktreePath(
  repoRoot: string,
  issue: Pick<IssueRef, 'number'>,
): string {
  return join(
    resolveEnsemblePaths({ repoRoot }).worktreesDir,
    `issue-${issue.number}`,
  );
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
  options: ResolveWorkerWorkspaceOptions = {},
): Promise<WorktreeRef> {
  if (mode === 'in_repo') {
    return resolveInRepoWorkspace(repoRoot, issue);
  }
  if (options.resume) {
    try {
      return await resolveWorkerWorktreeForResume(repoRoot, issue, options);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      options.onNotice?.(
        `Issue #${issue.number} の resume worktree を安全に解決できませんでした。既存の path・worktree・branch は変更していません。原因: ${detail}`,
      );
      throw error;
    }
  }
  return createWorkerWorktree(repoRoot, issue);
}

async function resolveWorkerWorktreeForResume(
  repoRoot: string,
  issue: IssueRef,
  options: ResolveWorkerWorkspaceOptions,
): Promise<WorktreeRef> {
  const expectedBranch = workerBranchName(issue);
  const existing = await resolveWorkerWorktree(repoRoot, issue);
  if (existing?.branch === expectedBranch) return existing;

  const expectedPath = resolve(workerWorktreePath(repoRoot, issue));
  const issueWorktreeDir = resolveEnsemblePaths({ repoRoot }).worktreesDir;
  options.onNotice?.(
    existing
      ? `保存済みの resume path ${expectedPath} は branch ${existing.branch} に接続されており、対象 Issue の branch ${expectedBranch} ではありません。既存 worktree はそのまま残し、別の workspace を探します。`
      : `この clone に Issue #${issue.number} の resume worktree ${expectedPath} がありません。${expectedBranch} または通常の base branch から安全な再生成を試みます。SessionResumeStore に保存時の commit SHA がないため、以前の worktree にだけある local commit / 未コミット変更は照合・復元できません。`,
  );

  const listed = await listWorktrees(repoRoot);
  const expectedBranchAttached = listed.some(
    (worktree) => worktree.branch === expectedBranch,
  );
  const branchExists = await gitBranchExists(repoRoot, expectedBranch);
  const recoveryBranch =
    expectedBranchAttached
      ? `${expectedBranch}-resume-${randomUUID().slice(0, 8)}`
      : expectedBranch;
  let startPoint = branchExists
    ? expectedBranchAttached
      ? expectedBranch
      : undefined
    : await resolveNewBranchStartPoint(repoRoot);
  if (!branchExists && !startPoint) {
    try {
      await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], repoRoot);
      startPoint = 'HEAD';
    } catch {
      throw new Error(
        `Issue #${issue.number} に安全な worktree base がありません。対象 branch ${expectedBranch} はなく、現在の clone にも利用可能な commit がありません。`,
      );
    }
  }
  if (expectedBranchAttached && startPoint) {
    try {
      await runGit(
        ['rev-parse', '--verify', `${startPoint}^{commit}`],
        repoRoot,
      );
    } catch {
      throw new Error(
        `Issue #${issue.number} に安全な worktree base がありません。使用中 branch ${expectedBranch} に利用可能な commit がありません。`,
      );
    }
  }
  let path: string;
  try {
    path = await resolveAvailableResumePath({
      issue,
      expectedPath,
      issueWorktreeDir,
      listed,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Issue #${issue.number} の worktree を安全に復旧できません: ${detail}`,
      { cause: error },
    );
  }

  try {
    if (branchExists && !expectedBranchAttached) {
      await runGit(['worktree', 'add', path, recoveryBranch], repoRoot);
    } else if (startPoint) {
      await runGit(
        ['worktree', 'add', '-b', recoveryBranch, path, startPoint],
        repoRoot,
      );
    } else {
      await runGit(['worktree', 'add', '-b', recoveryBranch, path], repoRoot);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Issue #${issue.number} の worktree を ${path} / branch ${recoveryBranch} に安全に復旧できません: ${detail}`,
      { cause: error },
    );
  }

  const result = { path, branch: recoveryBranch, issue };
  options.onNotice?.(
    `Issue #${issue.number} の resume worktree を ${path}、branch ${recoveryBranch} に再生成しました。既存の directory・worktree・branch は変更していません。`,
  );
  return result;
}

async function resolveAvailableResumePath(input: {
  issue: IssueRef;
  expectedPath: string;
  issueWorktreeDir: string;
  listed: ListedWorktree[];
}): Promise<string> {
  if (
    !(await pathExists(input.expectedPath)) &&
    !(await isListedWorktreePath(input.listed, input.expectedPath))
  ) {
    return input.expectedPath;
  }

  await mkdir(input.issueWorktreeDir, { recursive: true });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = randomUUID().slice(0, 8);
    const candidate = join(
      input.issueWorktreeDir,
      `issue-${input.issue.number}-resume-${suffix}`,
    );
    if (
      !(await pathExists(candidate)) &&
      !(await isListedWorktreePath(input.listed, candidate))
    ) {
      return candidate;
    }
  }
  throw new Error(
    `Could not find an unused recovery path for Issue ${input.issue.number}; ${input.expectedPath} is occupied.`,
  );
}

async function isListedWorktreePath(
  listed: ListedWorktree[],
  path: string,
): Promise<boolean> {
  for (const worktree of listed) {
    if (await pathsEqual(worktree.path, path)) return true;
  }
  return false;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
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
  await mkdir(resolveEnsemblePaths({ repoRoot }).worktreesDir, {
    recursive: true,
  });

  const branchExists = await gitBranchExists(repoRoot, branch);
  const startPoint = branchExists
    ? undefined
    : await resolveNewBranchStartPoint(repoRoot);
  try {
    if (branchExists) {
      await runGit(['worktree', 'add', path, branch], repoRoot);
    } else if (startPoint) {
      await runGit(['worktree', 'add', '-b', branch, path, startPoint], repoRoot);
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

export type RemoveWorkerWorktreeResult =
  | { status: 'removed'; path: string; branch: string }
  | { status: 'not_found' }
  | { status: 'skipped_dirty'; path: string; branch: string }
  | { status: 'failed'; path: string; branch: string; error: string };

/**
 * Worktree の lock が ACP / worker の終了直後まで残ることがあるため、
 * remove は短い backoff を挟んで限定的に再試行する。
 */
const WORKTREE_REMOVE_RETRY_DELAYS_MS = [100, 250] as const;

/**
 * isolated worktree を削除する。存在しない場合は no-op。
 * 未コミット変更がある場合は削除せず `skipped_dirty` を返す（`--force` は使わない）。
 */
export async function removeWorkerWorktree(
  repoRoot: string,
  issue: IssueRef,
): Promise<RemoveWorkerWorktreeResult> {
  const existing = await resolveWorkerWorktree(repoRoot, issue);
  if (!existing) {
    return { status: 'not_found' };
  }

  const dirty = await isWorktreeDirty(existing.path);
  if (dirty) {
    return {
      status: 'skipped_dirty',
      path: existing.path,
      branch: existing.branch,
    };
  }

  let lastError: string | undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await runGit(['worktree', 'remove', existing.path], repoRoot);
      return {
        status: 'removed',
        path: existing.path,
        branch: existing.branch,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const retryDelay = WORKTREE_REMOVE_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) {
        return {
          status: 'failed',
          path: existing.path,
          branch: existing.branch,
          error: lastError,
        };
      }
      await delay(retryDelay);
    }
  }
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

/** 新規ブランチ用の start-point。取得できなければ undefined（ローカル HEAD にフォールバック）。 */
async function resolveNewBranchStartPoint(
  repoRoot: string,
): Promise<string | undefined> {
  const defaultBranch = await resolveOriginDefaultBranch(repoRoot);
  if (!defaultBranch) return undefined;

  try {
    await runGit(['fetch', 'origin', defaultBranch], repoRoot);
    await runGit(
      ['rev-parse', '--verify', `refs/remotes/origin/${defaultBranch}`],
      repoRoot,
    );
    return `origin/${defaultBranch}`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `[worktree] origin/${defaultBranch} の同期に失敗しました。ローカル HEAD からブランチを切ります: ${detail}`,
    );
    return undefined;
  }
}

async function resolveOriginDefaultBranch(
  repoRoot: string,
): Promise<string | undefined> {
  try {
    await runGit(['remote', 'get-url', 'origin'], repoRoot);
  } catch {
    return undefined;
  }

  try {
    const { stdout } = await runGit(
      ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      repoRoot,
    );
    const match = stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) return match[1];
  } catch {
    // fall through
  }

  try {
    const { stdout } = await runGit(
      ['config', '--get', 'init.defaultBranch'],
      repoRoot,
    );
    const configured = stdout.trim();
    if (configured) return configured;
  } catch {
    // fall through
  }

  return 'main';
}

async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const { stdout } = await runGit(['status', '--porcelain'], worktreePath);
  return stdout.trim().length > 0;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
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

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
