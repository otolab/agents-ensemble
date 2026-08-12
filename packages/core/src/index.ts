/** Shared orchestration types and logic for agents-ensemble. */

export const PACKAGE_NAME = '@agents-ensemble/core';

export {
  NdJsonLineBuffer,
  parseMessage,
  serializeMessage,
  isJsonRpcResponse,
  isJsonRpcRequest,
  isJsonRpcNotification,
} from './acp/json-rpc.js';
export type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcError,
} from './acp/json-rpc.js';

export { JsonRpcPeer } from './acp/json-rpc-peer.js';
export type {
  JsonRpcPeerOptions,
  NotificationHandler,
  RequestHandler,
} from './acp/json-rpc-peer.js';

export { AcpClient, terminateChildProcess } from './acp/acp-client.js';
export type {
  AcpClientOptions,
  AcpClientStreams,
  SessionUpdateHandler,
} from './acp/acp-client.js';

export { spawnAcpProcess, runAcpSession } from './acp/acp-process.js';
export type {
  SpawnAcpProcessOptions,
  RunAcpSessionOptions,
  ChildProcess,
} from './acp/acp-process.js';

export { AcpBridge } from './acp/acp-bridge.js';
export type {
  AcpBridgeConnectOptions,
  AcpBridgeRunSessionOptions,
} from './acp/acp-bridge.js';

export {
  DEFAULT_PERMISSION_DECISION,
} from './acp/types.js';
export type {
  AcpPromptBlock,
  AcpTextPromptBlock,
  SessionUpdateNotification,
  PromptResult,
  LlmUsageSnapshot,
  PermissionDecision,
  PermissionHandler,
} from './acp/types.js';

export { FakeAcpServer, startFakeAcpServer } from './acp/testing/fake-acp-server.js';
export type {
  FakeAcpServerOptions,
  FakeAcpPromptResult,
} from './acp/testing/fake-acp-server.js';

export { createInProcessStreamPair } from './acp/testing/stream-pair.js';
export type { InProcessStreamPair } from './acp/testing/stream-pair.js';

export { parseIssueUrl, buildIssueUrl } from './issue/issue-ref.js';
export type { IssueRef } from './issue/issue-ref.js';
export {
  resolveIssueUrl,
  parseGitHubRemoteUrl,
} from './issue/resolve-issue-url.js';

export { runGit } from './git/run-git.js';

export {
  workerBranchName,
  workerWorktreePath,
  resolveWorkerWorktree,
  resolveWorkerWorkspace,
  resolveInRepoWorkspace,
  createWorkerWorktree,
  listWorktrees,
  removeWorkerWorktree,
} from './worktree/worktree.js';
export type {
  RemoveWorkerWorktreeResult,
  WorktreeRef,
  WorkerWorktreeMode,
} from './worktree/worktree.js';

export { buildWorkerPrompt } from './prompt/build-worker-prompt.js';
export type { WorkerPromptOptions } from './prompt/build-worker-prompt.js';

export { buildWorkerDispatchResult } from './dispatch/worker-dispatch.js';
export { attachWorker } from './dispatch/attach-worker.js';
export type {
  ConnectWorkerAcpFn,
  WorkerAcpSession,
} from './dispatch/worker-acp-session.js';
export type {
  WorkerDispatchResult,
  WorkerPromptSource,
} from './dispatch/worker-dispatch.js';

export { runGh } from './github/run-gh.js';
export {
  fetchIssueContext,
} from './github/issue-context.js';
export {
  formatIssueContextForPrompt,
  formatIssueContextYaml,
} from './github/format-issue-context-prompt.js';
export type {
  IssueContext,
  IssueComment,
} from './github/issue-context.js';
export {
  createGitHubMonitor,
  DEFAULT_GITHUB_MONITOR_DEBOUNCE_MS,
  DEFAULT_GITHUB_MONITOR_POLL_INTERVAL_MS,
  DEFAULT_GITHUB_MONITOR_ACTIVE_POLL_INTERVAL_MS,
} from './github/github-monitor.js';
export type { GitHubMonitor, GitHubMonitorOptions } from './github/github-monitor.js';
export {
  emptyGitHubMonitorCursor,
  isEmptyGitHubMonitorCursor,
  normalizeGitHubMonitorCursor,
} from './github/github-monitor-cursor.js';
export type {
  GitHubMonitorCursor,
  PullRequestMonitorCursor,
} from './github/github-monitor-cursor.js';
export type {
  GitHubUpdateItem,
  GitHubUpdateKind,
  GitHubUpdatePayload,
} from './github/github-update-types.js';
export { fetchGitHubUpdates } from './github/fetch-github-updates.js';
export type {
  FetchGitHubUpdatesInput,
  FetchGitHubUpdatesResult,
} from './github/fetch-github-updates.js';

export { ConductorAgent } from './conductor/conductor-agent.js';
export type {
  ConductorAgentOptions,
  ConductorSendResult,
} from './conductor/conductor-agent.js';

export {
  loadProfile,
  loadProfileFromFile,
  parseProfile,
  resolveProfilePath,
  resolveProfile,
  resolveProfileFilePath,
  resolveDefaultProfilePath,
  profileDirectoryPath,
  corePackageRoot,
  bundledProfilesRoot,
  bundledProfilePath,
  bundledDefaultProfilePath,
  PROFILES_DIR,
  PROFILE_FILE,
  DEFAULT_PROFILE_NAME,
} from './profile/load-profile.js';
export type {
  Profile,
  ProfileMaterial,
  AgentDefinition,
  ProfileWorkerEntry,
  ProfileWorkerRef,
  SessionWorkerSpec,
  EnsembleSessionState,
} from './profile/types.js';
export {
  profileWorkersToSessionSpecs,
  resolveAgentSystemPrompt,
  normalizeProfileWorker,
  normalizeProfileWorkers,
  sessionStateFromProfile,
} from './profile/types.js';

export { WorkerSession } from './runtime/worker-session.js';
export type { WorkerSessionOptions } from './runtime/worker-session.js';

export { runConductorSession } from './conductor/conductor-session.js';
export {
  ensureCursorSdkRipgrepPath,
  resolveBundledSdkRipgrepPath,
} from './conductor/configure-cursor-sdk-env.js';
export { runIssueSession } from './conductor/issue-session.js';
export type {
  ConductorSessionResult,
  RunConductorSessionOptions,
} from './conductor/conductor-session.js';
export type {
  OperatorInputBinding,
  OperatorInputBindingApi,
  OperatorInputContext,
  OperatorInputSubmitOptions,
} from './conductor/operator-input-binding.js';
export { submitOperatorInput } from './conductor/submit-operator-input.js';
export type { SubmitOperatorInputInput } from './conductor/submit-operator-input.js';
export { isOperatorExitCommand } from './conductor/operator-exit.js';
export {
  createOperatorPostLoopGate,
} from './conductor/operator-post-loop-gate.js';
export type {
  OperatorPostLoopAction,
  OperatorPostLoopGate,
} from './conductor/operator-post-loop-gate.js';
export type {
  IssueSessionResult,
  RunIssueSessionOptions,
} from './conductor/issue-session.js';

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
} from './conductor/session-policy.js';
export type {
  IssueLoopStopInput,
  IssueLoopStopReason,
} from './conductor/session-policy.js';
export { runConductorSessionDriver } from './conductor/conductor-session-driver.js';
export type {
  ConductorSessionDriverOptions,
  ConductorSessionDriverResult,
  ConductorSendCompleteInfo,
  ConductorSendStartedInfo,
} from './conductor/conductor-session-driver.js';
export { createTestOperatorInputBinding } from './conductor/testing/test-operator-input-binding.js';
export type { TestOperatorInputBinding } from './conductor/testing/test-operator-input-binding.js';
export {
  SessionEventQueue,
} from './conductor/session/session-event-queue.js';
export {
  formatSessionEventForConductor,
  formatSessionEventsForConductor,
} from './conductor/session/format-session-event.js';
export {
  dispatchBatchStateAfterSend,
  eventSourceKey,
  markContinuationConsumed,
  selectDispatchBatch,
  countWorkerOutcomesInBatch,
} from './conductor/session/select-dispatch-batch.js';
export type {
  DispatchBatch,
  DispatchBatchState,
  DispatchSourceKey,
} from './conductor/session/select-dispatch-batch.js';
export {
  SessionLogger,
} from './conductor/session/session-logger.js';
export type {
  SessionSummary,
  SessionLogEvent,
  SessionLogSink,
  SessionLoggerOptions,
} from './conductor/session/session-logger.js';
export type {
  SessionEvent,
  OperatorMessageEvent,
  WorkerCompletedEvent,
  WorkerFailedEvent,
  PermissionPendingEvent,
  GitHubUpdateEvent,
} from './conductor/session/session-event.js';

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
} from './conductor/conductor-auth.js';

export {
  CONDUCTOR_MODEL_ID_ENV,
  DEFAULT_CONDUCTOR_MODEL_ID,
  normalizeConductorModelId,
  resolveConductorModelId,
} from './conductor/resolve-conductor-model-id.js';

export { listConductorModels } from './conductor/list-conductor-models.js';
export type { ListConductorModelsOptions } from './conductor/list-conductor-models.js';

export {
  PermissionBroker,
  allowOnce,
  deny,
} from './permission/permission-broker.js';
export type {
  PermissionAskHandler,
  PermissionBrokerOptions,
} from './permission/permission-broker.js';
export {
  evaluatePermissionPolicy,
} from './permission/permission-policy.js';
export type {
  PermissionPolicyRules,
  PermissionVerdict,
} from './permission/permission-policy.js';
export {
  parsePermissionRequest,
} from './permission/permission-request.js';
export type { PermissionRequest } from './permission/permission-request.js';

export { PermissionPipeline } from './permission/permission-pipeline.js';
export type {
  PermissionPipelineOptions,
  PermissionPipelineOutcome,
} from './permission/permission-pipeline.js';
export {
  PendingPermissionRegistry,
} from './permission/pending-permission.js';
export type { PendingPermission } from './permission/pending-permission.js';
export { createResolvePermissionTool } from './permission/resolve-permission-tool.js';
export type { ResolvePermissionToolOptions } from './permission/resolve-permission-tool.js';
export { formatPendingPermissionSummaries } from './permission/format-pending-permissions.js';
export {
  extractPermissionOperationSummary,
  formatPermissionSummaryForOperator,
} from './permission/format-permission-summary-for-operator.js';
export type { FormatPermissionSummaryForOperatorOptions } from './permission/format-permission-summary-for-operator.js';
export type { PermissionOperationSummary } from './permission/format-permission-summary-for-operator.js';

export {
  SessionUsageTracker,
  resetSessionUsageRoundCounter,
} from './usage/session-usage-tracker.js';
export type { SessionUsageTrackerOptions } from './usage/session-usage-tracker.js';
export { estimateTokenUsageFromText } from './usage/estimate-token-usage.js';
export type {
  LlmTokenCounts,
  LlmUsageRecord,
  LlmUsageSource,
  SessionContextUtilization,
  SessionUsageAgentKind,
  SessionUsageAgentTotals,
  SessionUsageRound,
  SessionUsageSummary,
} from './usage/types.js';
export { createSessionUsageTools } from './dispatch/session-usage-tool.js';
export type { SessionUsageToolOptions } from './dispatch/session-usage-tool.js';

export {
  EscalationUnavailableError,
} from './escalation/escalation-unavailable-error.js';

export type {
  HumanInquiryKind,
  HumanInquiryResponseType,
  HumanInquiryRequest,
  HumanInquiryResponse,
  HumanInquiryHandler,
  EscalationRecord,
} from './escalation/human-inquiry.js';

export {
  ESCALATION_RESPONSE_ENV,
  readEscalationEnvFallback,
  parseEnvInquiryResponse,
  resolveHumanInquiryFromEnv,
  escalationUnavailableMessage,
  createEnvFallbackHumanInquiryHandler,
} from './escalation/resolve-human-inquiry.js';

export { permissionRequestToHumanInquiry } from './escalation/permission-inquiry.js';

export { createPermissionAskHandler } from './escalation/create-permission-ask-handler.js';

export { createAskHumanTool } from './escalation/ask-human-tool.js';
export type { AskHumanToolOptions } from './escalation/ask-human-tool.js';

export { createAnswerOpenQuestionTool } from './escalation/answer-open-question-tool.js';
export type { AnswerOpenQuestionToolOptions } from './escalation/answer-open-question-tool.js';

export {
  OpenQuestionRegistry,
} from './escalation/open-question.js';
export type {
  OpenQuestion,
  OpenQuestionStatus,
  OpenQuestionSource,
  OpenQuestionAnsweredBy,
  EnqueueOpenQuestionInput,
  AnswerOpenQuestionInput,
  OpenQuestionRegistrySnapshot,
} from './escalation/open-question.js';

export {
  SESSION_SIDECAR_VERSION,
  assertSessionSidecarMatches,
  findLatestSessionSidecarForIssue,
  listSessionSidecars,
  loadSessionSidecar,
  requireSessionSidecarForResume,
  saveSessionSidecar,
  sessionSidecarDir,
  sessionSidecarPath,
  SessionSidecarNotFoundError,
} from './session/session-sidecar.js';
export type {
  FindLatestSessionSidecarInput,
  SessionSidecar,
  WorkerSessionSidecar,
} from './session/session-sidecar.js';
export {
  formatOpenQuestionEnqueuedReport,
  formatOpenQuestionAnsweredReport,
  joinOperatorInput,
} from './escalation/format-registry-update.js';
export { createOpenQuestionListTools } from './escalation/open-question-list-tools.js';
export type { OpenQuestionListToolsOptions } from './escalation/open-question-list-tools.js';
export { applyOperatorMessage } from './escalation/apply-operator-message.js';
export type { ApplyOperatorMessageResult } from './escalation/apply-operator-message.js';
export { recordOpenQuestionAnswer } from './escalation/record-open-question-answer.js';
export type { RecordOpenQuestionAnswerInput } from './escalation/record-open-question-answer.js';
export { openQuestionToEscalationRecord } from './escalation/open-question-to-escalation.js';

export { ensureMaxTurnsOpenQuestion, MAX_TURNS_OPEN_QUESTION_TEXT } from './escalation/enqueue-max-turns-question.js';
export type { EnsureMaxTurnsOpenQuestionInput } from './escalation/enqueue-max-turns-question.js';

export { ConductorInbox } from './runtime/conductor-inbox.js';
export { startInboxProcessor } from './runtime/inbox-processor.js';
export type {
  InboxProcessorHandle,
  InboxProcessorOptions,
} from './runtime/inbox-processor.js';
export { WorkerRuntime } from './runtime/worker-runtime.js';
export type { WorkerRuntimeOptions } from './runtime/worker-runtime.js';
export type {
  InboxListener,
  InboxMessage,
  WorkerStartParams,
  WorkerStartedInfo,
  WorkerFailureRecord,
} from './runtime/types.js';
