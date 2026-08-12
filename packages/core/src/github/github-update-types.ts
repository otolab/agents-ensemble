/** GitHub 監視で検知する更新の種別。 */
export type GitHubUpdateKind =
  | 'issue.comment'
  | 'pr.review'
  | 'pr.review_comment'
  | 'ci.completed';

/** 1 件の GitHub 更新（debounce 前の単位）。 */
export interface GitHubUpdateItem {
  /** 安定 ID（comment / review / check の識別子）。 */
  id: string;
  kind: GitHubUpdateKind;
  /** conductor 向け 1 行要約。 */
  summary: string;
  url?: string;
  author?: string;
  /** 本文プレビュー（先頭数百文字）。 */
  bodyPreview?: string;
  prNumber?: number;
  checkName?: string;
  checkConclusion?: string;
}

/** debounce 後に SessionEvent へ載せるペイロード。 */
export interface GitHubUpdatePayload {
  items: GitHubUpdateItem[];
}
