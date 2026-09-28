import type { GitHubUpdateKind } from './github-update-types.js';

/** CI の正規化された観測フェーズ。 */
export type PullRequestCiPhase = 'pending' | 'completed';

/** check 名ごとの、最後に観測した CI 状態。 */
export interface PullRequestCiSnapshot {
  phase: PullRequestCiPhase;
  conclusion?: string;
  headSha?: string;
}

/**
 * 旧 sidecar の CI カーソル。読み替えのためだけに残している。
 * @deprecated `PullRequestCiSnapshot` を `lastObserved` に保存する。
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
  /** check 名ごとの最後の正規化観測状態。 */
  lastObserved?: Record<string, PullRequestCiSnapshot>;
  /**
   * 旧 sidecar の check 名ごとの CI 実行カーソル。
   * @deprecated `lastObserved` へ 1 回だけ読み替える。
   */
  ciChecks?: Record<string, PullRequestCiCursor>;
  /**
   * 旧 sidecar の pending check 名。
   * @deprecated `lastObserved` へ 1 回だけ読み替える。
   */
  pendingCheckNames?: string[];
  /**
   * 旧 sidecar の完了通知済み check 名。
   * @deprecated `lastObserved` へ 1 回だけ読み替える。
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
  const hasCiState =
    cursor.lastObserved !== undefined ||
    cursor.ciChecks !== undefined ||
    cursor.pendingCheckNames !== undefined ||
    cursor.notifiedCheckNames !== undefined;
  const lastObserved = migrateCiCursor(cursor);

  return {
    ...(cursor.lastReviewId !== undefined
      ? { lastReviewId: cursor.lastReviewId }
      : {}),
    ...(cursor.lastReviewCommentId !== undefined
      ? { lastReviewCommentId: cursor.lastReviewCommentId }
      : {}),
    ...(hasCiState ? { lastObserved } : {}),
    ...(cursor.ciBootstrapPending ? { ciBootstrapPending: true } : {}),
  };
}

function migrateCiCursor(
  cursor: PullRequestMonitorCursor,
): Record<string, PullRequestCiSnapshot> {
  const lastObserved: Record<string, PullRequestCiSnapshot> = {};

  for (const [name, snapshot] of Object.entries(cursor.lastObserved ?? {})) {
    const normalized = normalizeCiSnapshot(snapshot);
    if (normalized) {
      lastObserved[name] = normalized;
    }
  }

  // Prefer the old per-check cursor, then the older name-only fields. This
  // preserves the old pending -> completed behavior during the one-time
  // migration without carrying run identities into the new cursor.
  for (const [name, ciCursor] of Object.entries(cursor.ciChecks ?? {})) {
    if (lastObserved[name] || !isCiPhase(ciCursor.status)) {
      continue;
    }
    lastObserved[name] = { phase: ciCursor.status };
  }
  for (const name of cursor.pendingCheckNames ?? []) {
    if (!lastObserved[name]) {
      lastObserved[name] = { phase: 'pending' };
    }
  }
  for (const name of cursor.notifiedCheckNames ?? []) {
    if (!lastObserved[name]) {
      lastObserved[name] = { phase: 'completed' };
    }
  }

  return lastObserved;
}

function normalizeCiSnapshot(
  snapshot: PullRequestCiSnapshot,
): PullRequestCiSnapshot | undefined {
  if (!snapshot || !isCiPhase(snapshot.phase)) {
    return undefined;
  }

  return {
    phase: snapshot.phase,
    ...(typeof snapshot.conclusion === 'string'
      ? { conclusion: snapshot.conclusion }
      : {}),
    ...(typeof snapshot.headSha === 'string' ? { headSha: snapshot.headSha } : {}),
  };
}

function isCiPhase(value: unknown): value is PullRequestCiPhase {
  return value === 'pending' || value === 'completed';
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
      Object.keys(pr.lastObserved ?? {}).length > 0 ||
      Object.keys(pr.ciChecks ?? {}).length > 0 ||
      pr.ciBootstrapPending === true
    ) {
      return false;
    }
  }
  return true;
}
