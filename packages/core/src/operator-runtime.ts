/**
 * Small public surface for role runtimes that reuse conductor configuration
 * and the embedded backend without depending on the Issue session harness.
 */
export { loadEnsembleConfig } from './config/load-ensemble-config.js';
export type { EnsembleConfig } from './config/types.js';
export {
  resolveConductorBackendSetting,
  resolveConductorPiResourcePaths,
} from './config/resolve-settings.js';
export type { ConductorBackend } from './config/types.js';
export { resolveConductorModelId } from './conductor/resolve-conductor-model-id.js';
export { createConductorAgentFactory } from './conductor/conductor-agent-factory.js';
export { isOperatorCommand } from './conductor/operator-command.js';
export type {
  ConductorAgent,
  ConductorAgentCreateOptions,
  ConductorAgentFactory,
  ConductorSendResult,
} from './conductor/conductor-agent.js';
export type {
  ConductorJsonValue,
  ConductorTool,
  ConductorToolSet,
} from './conductor/conductor-tool.js';
export { loadProfile } from './profile/load-profile.js';
export type {
  ResolvedProfile,
  ResolvedProfileMaterial,
} from './profile/types.js';
export {
  filterMaterialsForKind,
  resolveAgentPromptModule,
  sessionStateFromProfile,
} from './profile/types.js';
export { profilePromptModule } from './prompt/modules/shared/profile-prompt-module.js';
export { renderCompiledPrompt } from './prompt/render-compiled-prompt.js';
export {
  loadSessionSidecar,
  listSessionSidecars,
  type SessionLifecycle,
  type SessionSidecar,
} from './session/session-sidecar.js';
export {
  OPEN_QUESTION_CONTROL_METHODS,
  OpenQuestionControlRemoteError,
  OpenQuestionControlTransportError,
  sendOpenQuestionControlRequest,
} from './session/open-question-control.js';
export type {
  OpenQuestionControlAnswerResult,
  OpenQuestionControlErrorData,
  OpenQuestionControlListItem,
} from './session/open-question-control.js';
export {
  loadSessionStateStore,
  sessionStateStorePath,
  type SessionStateStore,
  type SessionStatusLine,
} from './session/session-state-store.js';
export { parseIssueUrl } from './issue/issue-ref.js';
export type { IssueRef } from './issue/issue-ref.js';
