import type { WorkerWorktreeMode } from '@agents-ensemble/core';

/** CLI `--worktree` 引数を `WorkerWorktreeMode` に変換する。 */
export function parseWorktreeMode(value: string): WorkerWorktreeMode {
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (normalized === 'isolated') return 'isolated';
  if (normalized === 'in-repo') return 'in_repo';
  throw new Error(
    `Invalid --worktree: ${value}. Use isolated (default) or in-repo.`,
  );
}
