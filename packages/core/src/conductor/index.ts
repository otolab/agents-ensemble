export { ConductorAgent } from './conductor-agent.js';
export type {
  ConductorAgentOptions,
  ConductorSendResult,
} from './conductor-agent.js';

export { runConductorSession } from './conductor-session.js';
export {
  ensureCursorSdkRipgrepPath,
  resolveBundledSdkRipgrepPath,
} from './configure-cursor-sdk-env.js';
export { runIssueSession } from './issue-session.js';
export type {
  ConductorSessionResult,
  RunConductorSessionOptions,
} from './conductor-session.js';
export type {
  OperatorInputBinding,
  OperatorInputBindingApi,
  OperatorInputContext,
  OperatorInputSubmitOptions,
} from './operator-input-binding.js';
export { submitOperatorInput } from './submit-operator-input.js';
export type { SubmitOperatorInputInput } from './submit-operator-input.js';
export { isOperatorExitCommand } from './operator-exit.js';
export {
  createOperatorPostLoopGate,
} from './operator-post-loop-gate.js';
export type {
  OperatorPostLoopAction,
  OperatorPostLoopGate,
} from './operator-post-loop-gate.js';
export type {
  IssueSessionResult,
  RunIssueSessionOptions,
} from './issue-session.js';

export {
  canDispatchConductorSend,
  autonomousTurnsAfterConductorSend,
  autonomousTurnsAfterConductorBatch,
  shouldStopIssueLoop,
  resolveIssueLoopStopReason,
  resolveMaxTurns,
  isMaxTurnsLimited,
  operatorInputMaxTurns,
  DEFAULT_MAX_ISSUE_TURNS,
} from './session-policy.js';
export type {
  IssueLoopStopInput,
  IssueLoopStopReason,
} from './session-policy.js';
export { runConductorSessionDriver } from './conductor-session-driver.js';
export type {
  ConductorSessionDriverOptions,
  ConductorSessionDriverResult,
  ConductorSendCompleteInfo,
  ConductorSendProgressInfo,
  ConductorSendStartedInfo,
} from './conductor-session-driver.js';
export {
  SessionEventQueue,
} from './session/session-event-queue.js';
export {
  formatSessionEventForConductor,
  formatSessionEventsForConductor,
} from './session/format-session-event.js';
export {
  dispatchBatchStateAfterSend,
  eventSourceKey,
  markContinuationConsumed,
  selectDispatchBatch,
  countWorkerOutcomesInBatch,
} from './session/select-dispatch-batch.js';
export type {
  DispatchBatch,
  DispatchBatchState,
  DispatchSourceKey,
} from './session/select-dispatch-batch.js';
export {
  canTriggerConductorDispatch,
  isTriggerSessionEvent,
  sessionEventDispatchMode,
  DEFAULT_SESSION_EVENT_DISPATCH_MODE,
} from './session/dispatch-mode.js';
export type { DispatchMode } from './session/dispatch-mode.js';
export {
  SessionLogger,
} from './session/session-logger.js';
export type {
  SessionSummary,
  SessionLogEvent,
  SessionLogSink,
  SessionLoggerOptions,
} from './session/session-logger.js';
export type {
  SessionEvent,
  OperatorMessageEvent,
  WorkerCompletedEvent,
  WorkerFailedEvent,
  PermissionPendingEvent,
  GitHubUpdateEvent,
  SessionEventDispatchFields,
} from './session/session-event.js';
export {
  ALL_SESSION_LOG_EVENT_TYPES,
  HARNESS_TELEMETRY_EVENT_TYPES,
  SESSION_AUXILIARY_EVENT_TYPES,
  SESSION_EVENT_TYPES,
  SESSION_OBSERVATION_EVENT_TYPES,
} from './session/events/index.js';
export type {
  SessionEventType,
  SessionLogEventType,
  WorkerRoundOutcome,
  WorkerFailureOutcome,
  PermissionPendingConductorPayload,
  PermissionPendingHarnessPayload,
  WorkerPromptLifecycleSource,
} from './session/events/index.js';

export {
  CONDUCTOR_AUTH_HINT,
  formatConductorAuthRecoveryHint,
  getConductorAuthStatus,
  hasConductorAuth,
  isBareConductorSendAuthError,
  isConductorAuthError,
  isConductorSendAuthError,
  loginConductor,
  logoutConductor,
  resolveConductorApiKey,
} from './conductor-auth.js';

export {
  CONDUCTOR_MODEL_ID_ENV,
  DEFAULT_CONDUCTOR_MODEL_ID,
  normalizeConductorModelId,
  resolveConductorModelId,
} from './resolve-conductor-model-id.js';

export { listConductorModels } from './list-conductor-models.js';
export type { ListConductorModelsOptions } from './list-conductor-models.js';
