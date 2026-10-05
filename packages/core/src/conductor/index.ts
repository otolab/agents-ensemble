export type {
  ConductorAgent,
  ConductorAgentCreateOptions,
  ConductorPiResourceOptions,
  ConductorAgentFactory,
  ConductorAgentOptions,
  ConductorAgentUsage,
  ConductorSendCallbacks,
  ConductorSendError,
  ConductorSendResult,
  ConductorTokenUsage,
  ConductorToolCallStartedInfo,
  ConductorUsageCost,
} from './conductor-agent.js';
export {
  CursorSdkConductorAgent,
  createCursorSdkConductorAgentFactory,
} from './cursor-sdk-conductor-agent.js';
export {
  PiConductorAgent,
  createPiConductorAgentFactory,
  resolvePiModelConfig,
} from './pi-conductor-agent.js';
export type { PiResolvedModel } from './pi-conductor-agent.js';
export {
  loadPiResources,
  resolvePiResourceRoots,
} from './pi-resource-loader.js';
export type {
  PiAuthFile,
  PiModelCost,
  PiModelCostTier,
  PiModelDefinition,
  PiModelOverride,
  PiModelsFile,
  PiPromptResource,
  PiProviderConfig,
  PiResourceLoaderOptions,
  PiResourceRoots,
  PiResources,
  PiSkillResource,
  PiSettingsFile,
  PiThemeResource,
} from './pi-resource-loader.js';
export {
  createPiConductorAuthContext,
  getPiConductorAuthStatus,
  hasPiConductorAuth,
  hasPiProviderAuth,
  isPiConductorOAuthProvider,
  listPiConductorModels,
  loginPiConductor,
  logoutPiConductor,
  resolvePiConductorApiKey,
  resolvePiConductorProvider,
} from './conductor-pi-auth.js';
export type {
  PiConductorAuthContext,
  PiConductorAuthOptions,
  PiConductorAuthStatus,
  PiConductorLoginResult,
  PiConductorLogoutResult,
  PiConductorModelListEntry,
  PiProviderAuthStatus,
} from './conductor-pi-auth.js';
export {
  ConductorToolRegistry,
} from './conductor-tool.js';
export type {
  ConductorJsonValue,
  ConductorTool,
  ConductorToolExecute,
  ConductorToolInputSchema,
  ConductorToolResult,
  ConductorToolSet,
  ConductorToolTextContent,
} from './conductor-tool.js';
export {
  toSdkCustomTools,
} from './conductor-tool-sdk-adapter.js';
export type { SdkCustomTools } from './conductor-tool-sdk-adapter.js';
export {
  toPiCodingAgentTools,
} from './conductor-tool-pi-adapter.js';

export {
  createConductorAgentFactory,
  runConductorSession,
} from './conductor-session.js';
export {
  ensureCursorSdkProxy,
  ensureCursorSdkRipgrepPath,
  readCursorSettings,
  resolveBundledSdkRipgrepPath,
  resolveCursorSettingsPath,
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
export { isOperatorReconnectCommand } from './operator-reconnect.js';
export {
  reconnectConductorAgent,
  sendConductorWithReconnect,
  isConductorSendTransportError,
} from './conductor-send-reconnect.js';
export type {
  ConductorAgentHandle,
  ConductorReconnectCompleteInfo,
  ConductorReconnectOptions,
  ConductorSendReconnectOptions,
} from './conductor-send-reconnect.js';
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
  bufferDispatchHoldEvents,
  createDispatchHoldState,
  pruneStalePermissionEvents,
} from './session/dispatch-hold.js';
export type {
  BufferDispatchHoldEventsOptions,
  DispatchHoldChange,
  DispatchHoldChangeStatus,
  PruneStalePermissionEventsOptions,
  DispatchHoldState,
} from './session/dispatch-hold.js';
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
  OperatorReconnectEvent,
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
  PermissionCleanupEvent,
  WorkerPromptLifecycleSource,
} from './session/events/index.js';

export {
  CONDUCTOR_AUTH_HINT,
  resolveConductorAuthBackend,
  formatConductorAuthRecoveryHint,
  type ConductorAuthOptions,
  type ConductorAuthRecoveryOptions,
  type ConductorAuthStatus,
  type ConductorLoginResult,
  type ConductorLogoutResult,
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
