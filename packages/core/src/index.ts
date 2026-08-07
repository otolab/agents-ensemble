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

export { runGit } from './git/run-git.js';

export {
  workerBranchName,
  workerWorktreePath,
  resolveWorkerWorktree,
  createWorkerWorktree,
  listWorktrees,
} from './worktree/worktree.js';
export type { WorktreeRef } from './worktree/worktree.js';

export { buildWorkerPrompt, buildReviewerPrompt } from './prompt/build-prompt.js';
export type {
  WorkerPromptOptions,
  ReviewerPromptOptions,
} from './prompt/build-prompt.js';

export { dispatchWorker } from './dispatch/worker-dispatch.js';
export type {
  WorkerDispatchOptions,
  WorkerDispatchResult,
} from './dispatch/worker-dispatch.js';

export { dispatchReviewer } from './dispatch/reviewer-dispatch.js';
export type {
  ReviewerDispatchOptions,
  ReviewerDispatchResult,
} from './dispatch/reviewer-dispatch.js';

export { runGh } from './github/run-gh.js';
export {
  fetchIssueContext,
  formatIssueContextForPrompt,
} from './github/issue-context.js';
export type {
  IssueContext,
  IssueComment,
} from './github/issue-context.js';

export { ConductorAgent } from './conductor/conductor-agent.js';
export type {
  ConductorAgentOptions,
  ConductorSendResult,
} from './conductor/conductor-agent.js';

export { createDispatchTools } from './conductor/dispatch-tools.js';
export type { DispatchToolsOptions } from './conductor/dispatch-tools.js';

export { buildConductorPrompt } from './conductor/build-conductor-prompt.js';
export type {
  BuildConductorPromptOptions,
  ConductorMaterial,
} from './conductor/build-conductor-prompt.js';
export { loadConductorMaterialFromFile } from './conductor/prompt/materials.js';

export { runIssueSession } from './conductor/issue-session.js';
export type {
  IssueSessionResult,
  IssueSessionTurn,
  RunIssueSessionOptions,
} from './conductor/issue-session.js';

export {
  buildConductorFollowUpPrompt,
} from './conductor/build-conductor-follow-up-prompt.js';
export type { BuildConductorFollowUpPromptOptions } from './conductor/build-conductor-follow-up-prompt.js';

export {
  DEFAULT_MAX_ISSUE_TURNS,
  resolveIssueLoopStopReason,
  shouldStopIssueLoop,
} from './conductor/issue-loop.js';
export type { IssueLoopStopReason } from './conductor/issue-loop.js';

export {
  CONDUCTOR_AUTH_HINT,
  getConductorAuthStatus,
  hasConductorAuth,
  loginConductor,
  resolveConductorApiKey,
} from './conductor/conductor-auth.js';

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

export { buildHumanGuidancePrompt } from './escalation/build-human-guidance-prompt.js';

export { buildMaxTurnsEscalationRequest } from './escalation/build-max-turns-escalation.js';

export { ConductorInbox } from './runtime/conductor-inbox.js';
export { startInboxProcessor } from './runtime/inbox-processor.js';
export type {
  InboxProcessorHandle,
  InboxProcessorOptions,
} from './runtime/inbox-processor.js';
export { WorkerRuntime } from './runtime/worker-runtime.js';
export type { WorkerDispatchFn, WorkerRuntimeOptions } from './runtime/worker-runtime.js';
export type {
  InboxListener,
  InboxMessage,
  WorkerStartParams,
  WorkerStartedInfo,
} from './runtime/types.js';
