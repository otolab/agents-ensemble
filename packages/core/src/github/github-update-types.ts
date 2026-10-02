/** GitHub 監視で検知する更新の種別。 */
export type GitHubUpdateKind =
  | 'issue.comment'
  | 'pr.review'
  | 'pr.review_comment'
  | 'ci.completed';

/** PR の 1 commit SHA に対する CI 集約状態（外部通知はこの 3 値のみ）。 */
export type GitHubCiAggregateState = 'running' | 'failed' | 'completed';

/** 1 件の GitHub 更新（debounce 前の単位）。 */
export interface GitHubUpdateItem {
  /** 安定 ID（comment / review / CI 状態差分の識別子）。 */
  id: string;
  kind: GitHubUpdateKind;
  /** conductor 向け 1 行要約。 */
  summary: string;
  url?: string;
  author?: string;
  /** 本文プレビュー（先頭数百文字）。 */
  bodyPreview?: string;
  prNumber?: number;
  /** CI 集約を通知した commit SHA（`ci.completed` の新しい意味）。 */
  commitSha?: string;
  /** CI 集約状態。check 単位の状態は外部 payload に載せない。 */
  aggregateState?: GitHubCiAggregateState;
  /** `failed` 集約時に調査対象を示す check 名。 */
  failedCheckNames?: string[];
  /** @deprecated CI 集約では使用しない。旧 payload 互換のため型だけ残す。 */
  checkName?: string;
  /** @deprecated CI 集約では使用しない。旧 payload 互換のため型だけ残す。 */
  checkConclusion?: string;
}

/** debounce 後に SessionEvent へ載せるペイロード。 */
export interface GitHubUpdatePayload {
  items: GitHubUpdateItem[];
}
