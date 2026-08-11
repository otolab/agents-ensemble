/**
 * @deprecated import from `./session-policy.js` instead.
 * 後方互換のため stop ポリシーのみ再 export する。
 */
export {
  DEFAULT_MAX_ISSUE_TURNS,
  resolveIssueLoopStopReason,
  shouldStopIssueLoop,
} from './session-policy.js';
export type { IssueLoopStopInput, IssueLoopStopReason } from './session-policy.js';
