import type { GitHubUpdateKind } from './github-update-types.js';

/** CI の現在の実行単位を表すカーソル状態。 */
export interface PullRequestCiCursor {
  /** run id / commit / URL 等から作った、同一実行を表す安定キー。 */
  runKey: string;
  /** この check を最後に観測した状態。 */
  status: 'pending' | 'completed';
}

/** PR 単位の GitHub 監視カーソル。 */
export interface PullRequestMonitorCursor {
  lastReviewId?: string;
  lastReviewCommentId?: string;
  /**
   * 後方互換用の pending check 名。新しいカーソルでは `ciChecks` から導出する。
   * @deprecated run 単位の `ciChecks` を使う。
   */
  pendingCheckNames?: string[];
  /**
   * 後方互換用の完了通知済み check 名。
   * @deprecated run 単位の `ciChecks` を使う。
   */
  notifiedCheckNames?: string[];
  /** check 名ごとの現在の CI 実行カーソル。 */
  ciChecks?: Record<string, PullRequestCiCursor>;
}

/** 明示的に登録された PR の監視設定。 */
export interface ExplicitPullRequestWatch {
  registeredAt: string;
  kinds?: GitHubUpdateKind[];
}

/** 明示登録で監視する PR 更新の既定種別。 */
export const DEFAULT_GITHUB_WATCH_KINDS: GitHubUpdateKind[] = [
  'pr.review',
  'pr.review_comment',
  'ci.completed',
];

/** sidecar に永続化する GitHub 監視カーソル。 */
export interface GitHubMonitorCursor {
  /** 最後に処理した Issue コメント ID（文字列）。 */
  lastIssueCommentId?: string;
  /** PR 番号（文字列キー）ごとのカーソル。 */
  pullRequests?: Record<string, PullRequestMonitorCursor>;
  /** search 以外で明示登録された PR 番号（文字列キー）。 */
  explicitPullRequests?: Record<string, ExplicitPullRequestWatch>;
}

export function emptyGitHubMonitorCursor(): GitHubMonitorCursor {
  return { pullRequests: {}, explicitPullRequests: {} };
}

export function normalizeGitHubMonitorCursor(
  cursor?: GitHubMonitorCursor,
): GitHubMonitorCursor {
  return {
    lastIssueCommentId: cursor?.lastIssueCommentId,
    pullRequests: Object.fromEntries(
      Object.entries(cursor?.pullRequests ?? {}).map(([prNumber, prCursor]) => [
        prNumber,
        normalizePullRequestMonitorCursor(prCursor),
      ]),
    ),
    explicitPullRequests: Object.fromEntries(
      Object.entries(cursor?.explicitPullRequests ?? {}).map(
        ([prNumber, watch]) => [
          prNumber,
          {
            registeredAt: watch.registeredAt,
            ...(watch.kinds ? { kinds: [...watch.kinds] } : {}),
          },
        ],
      ),
    ),
  };
}

function normalizePullRequestMonitorCursor(
  cursor: PullRequestMonitorCursor,
): PullRequestMonitorCursor {
  return {
    ...(cursor.lastReviewId !== undefined
      ? { lastReviewId: cursor.lastReviewId }
      : {}),
    ...(cursor.lastReviewCommentId !== undefined
      ? { lastReviewCommentId: cursor.lastReviewCommentId }
      : {}),
    ...(cursor.pendingCheckNames !== undefined
      ? { pendingCheckNames: [...cursor.pendingCheckNames] }
      : {}),
    ...(cursor.notifiedCheckNames !== undefined
      ? { notifiedCheckNames: [...cursor.notifiedCheckNames] }
      : {}),
    ...(cursor.ciChecks !== undefined
      ? {
          ciChecks: Object.fromEntries(
            Object.entries(cursor.ciChecks).map(([name, ciCursor]) => [
              name,
              {
                runKey: ciCursor.runKey,
                status: ciCursor.status,
              },
            ]),
          ),
        }
      : {}),
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
      (pr.notifiedCheckNames?.length ?? 0) > 0 ||
      Object.keys(pr.ciChecks ?? {}).length > 0
    ) {
      return false;
    }
  }
  return true;
}
