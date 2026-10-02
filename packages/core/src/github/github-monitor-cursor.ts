import type {
  GitHubCiAggregateState,
  GitHubUpdateKind,
} from './github-update-types.js';

/**
 * 旧 sidecar の CI 正規化フェーズ。
 * @deprecated SHA 集約では `lastAggregateBySha` を使用する。
 */
export type PullRequestCiPhase = 'pending' | 'completed';

/**
 * 旧 sidecar の check 名単位 snapshot。
 * @deprecated SHA 集約では `lastAggregateBySha` を使用する。
 */
export interface PullRequestCiSnapshot {
  phase: PullRequestCiPhase;
  conclusion?: string;
  headSha?: string;
}

/**
 * 旧 sidecar の CI カーソル。読み替えのためだけに残している。
 * @deprecated 旧 sidecar の読み取り互換のためだけに残す。新 sidecar には保存しない。
 */
export interface PullRequestCiCursor {
  /** run id / commit / URL 等から作った、同一実行を表す安定キー。 */
  runKey: string;
  /** この check を最後に観測した状態。 */
  status: PullRequestCiPhase;
}

/** PR 単位の GitHub 監視カーソル。 */
export interface PullRequestMonitorCursor {
  lastReviewId?: string;
  lastReviewCommentId?: string;
  /** commit SHA ごとの最後の外部向け CI 集約状態。 */
  lastAggregateBySha?: Record<string, GitHubCiAggregateState>;
  /**
   * 旧 sidecar の check 名ごとの最後の正規化観測状態。
   * @deprecated 次回 resume 時に破棄し、現行 rollup を baseline とする。
   */
  lastObserved?: Record<string, PullRequestCiSnapshot>;
  /**
   * 旧 sidecar の check 名ごとの CI 実行カーソル。
   * @deprecated 次回 resume 時に破棄し、現行 rollup を baseline とする。
   */
  ciChecks?: Record<string, PullRequestCiCursor>;
  /**
   * 旧 sidecar の pending check 名。
   * @deprecated 次回 resume 時に破棄し、現行 rollup を baseline とする。
   */
  pendingCheckNames?: string[];
  /**
   * 旧 sidecar の完了通知済み check 名。
   * @deprecated 次回 resume 時に破棄し、現行 rollup を baseline とする。
   */
  notifiedCheckNames?: string[];
  /** CI の初回 status snapshot が失敗し、次回 bootstrap が必要な状態。 */
  ciBootstrapPending?: boolean;
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
    ...(cursor.lastAggregateBySha !== undefined
      ? { lastAggregateBySha: normalizeAggregateStates(cursor.lastAggregateBySha) }
      : {}),
    ...(cursor.ciBootstrapPending ? { ciBootstrapPending: true } : {}),
  };
}

function normalizeAggregateStates(
  states: Record<string, GitHubCiAggregateState>,
): Record<string, GitHubCiAggregateState> {
  return Object.fromEntries(
    Object.entries(states).filter(
      ([sha, state]) => sha.length > 0 && isAggregateState(state),
    ),
  );
}

function isAggregateState(value: unknown): value is GitHubCiAggregateState {
  return value === 'running' || value === 'failed' || value === 'completed';
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
      Object.keys(pr.lastAggregateBySha ?? {}).length > 0 ||
      pr.ciBootstrapPending === true
    ) {
      return false;
    }
  }
  return true;
}
