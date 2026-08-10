/**
 * @deprecated `conductor-session` を使用。互換のための re-export。
 */
export {
  runConductorSession,
  runConductorSession as runIssueSession,
  type RunConductorSessionOptions,
  type RunConductorSessionOptions as RunIssueSessionOptions,
  type ConductorSessionResult,
  type ConductorSessionResult as IssueSessionResult,
  type OperatorInputContext,
  type OperatorInputBinding,
  type OperatorInputBindingApi,
} from './conductor-session.js';
