/**
 * @deprecated `conductor-session` を使用。互換のための re-export。
 */
export {
  runConductorSession,
  runConductorSession as runIssueSession,
  type RunConductorSessionOptions,
  type RunConductorSessionOptions as RunIssueSessionOptions,
  type ConductorSessionTurn,
  type ConductorSessionTurn as IssueSessionTurn,
  type ConductorSessionResult,
  type ConductorSessionResult as IssueSessionResult,
  type OperatorInputContext,
} from './conductor-session.js';
