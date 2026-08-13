/** PR 単位の GitHub 監視カーソル。 */
export interface PullRequestMonitorCursor {
  lastReviewId?: string;
  lastReviewCommentId?: string;
  /** 前回 poll 時点で pending だった check 名。 */
  pendingCheckNames?: string[];
  /** 完了通知済みの check 名（重複 wakeup 防止）。 */
  notifiedCheckNames?: string[];
}

/** sidecar に永続化する GitHub 監視カーソル。 */
export interface GitHubMonitorCursor {
  /** 最後に処理した Issue コメント ID（文字列）。 */
  lastIssueCommentId?: string;
  /** PR 番号（文字列キー）ごとのカーソル。 */
  pullRequests?: Record<string, PullRequestMonitorCursor>;
}

export function emptyGitHubMonitorCursor(): GitHubMonitorCursor {
  return { pullRequests: {} };
}

export function normalizeGitHubMonitorCursor(
  cursor?: GitHubMonitorCursor,
): GitHubMonitorCursor {
  return {
    lastIssueCommentId: cursor?.lastIssueCommentId,
    pullRequests: { ...(cursor?.pullRequests ?? {}) },
  };
}

/** 新規セッション初回 poll のカーソル初期化のみか（sidecar 復元済みなら false）。worker の init prompt とは無関係。 */
export function isEmptyGitHubMonitorCursor(cursor: GitHubMonitorCursor): boolean {
  if (cursor.lastIssueCommentId) {
    return false;
  }
  for (const pr of Object.values(cursor.pullRequests ?? {})) {
    if (
      pr.lastReviewId ||
      pr.lastReviewCommentId ||
      (pr.pendingCheckNames?.length ?? 0) > 0 ||
      (pr.notifiedCheckNames?.length ?? 0) > 0
    ) {
      return false;
    }
  }
  return true;
}
