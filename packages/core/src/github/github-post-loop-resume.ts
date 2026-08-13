import type { GitHubUpdateItem } from './github-update-types.js';
import { isMaxTurnsLimited } from '../conductor/session-policy.js';

/** `items` に actionable な Issue コメントが含まれるか。 */
export function hasActionableIssueComment(items: GitHubUpdateItem[]): boolean {
  return items.some((item) => item.kind === 'issue.comment');
}

/**
 * post-loop 待機中に GitHub 更新で SessionDriver を再開してよいか。
 * max-turns 到達時はターン回復しない（enqueue のみ）。
 */
export function canResumePostLoopForTurns(
  autonomousTurns: number,
  maxTurns: number,
): boolean {
  if (!isMaxTurnsLimited(maxTurns)) {
    return true;
  }
  return autonomousTurns < maxTurns;
}
