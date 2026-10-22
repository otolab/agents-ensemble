/** @deprecated Use the SessionResumeState exports; retained until the next major release. */
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
} from './session-resume-store.js';
/** @deprecated Use SessionResumeState; retained until the next major release. */
export type {
  FindLatestSessionSidecarInput,
  SessionSidecar,
  SessionSidecarPathOptions,
  WorkerSessionSidecar,
} from './session-resume-store.js';
export {
  SESSION_RESUME_STATE_VERSION,
  assertSessionResumeStateMatches,
  findLatestSessionResumeStateForIssue,
  listSessionResumeStates,
  loadSessionResumeState,
  requireSessionResumeStateForResume,
  saveSessionResumeState,
  sessionResumeStoreDir,
  sessionResumeStorePath,
  SessionResumeStateNotFoundError,
} from './session-resume-store.js';
export type {
  FindLatestSessionResumeStateInput,
  SessionLifecycle,
  SessionResumeState,
  WorkerSessionResumeState,
} from './session-resume-store.js';
export {
  loadOpenQuestionsStore,
  OPEN_QUESTIONS_STORE_VERSION,
  openQuestionsStorePath,
  saveOpenQuestionsStore,
} from './open-questions-store.js';
export type { OpenQuestionsStoreDocument } from './open-questions-store.js';
export {
  OPEN_QUESTION_CONTROL_METHODS,
  OpenQuestionControlOperationError,
  OpenQuestionControlRemoteError,
  OpenQuestionControlTransportError,
  sendOpenQuestionControlRequest,
  startOpenQuestionControlServer,
} from './open-question-control.js';
export type {
  OpenQuestionControlAnswerResult,
  OpenQuestionControlAnswer,
  OpenQuestionControlErrorData,
  OpenQuestionControlLastConductorMessage,
  OpenQuestionControlListItem,
  OpenQuestionControlServer,
  OpenQuestionControlServerOptions,
  SessionObservationSnapshot,
} from './open-question-control.js';
export {
  loadSessionStateStore,
  saveSessionStatusLine,
  SESSION_STATE_STORE_MAX_BYTES,
  SESSION_STATE_STORE_VERSION,
  SESSION_STATUS_HISTORY_MAX_ENTRIES,
  SESSION_STATUS_LINE_MAX_LENGTH,
  sessionStateStorePath,
} from './session-state-store.js';
export type {
  SessionStateStore,
  SessionStatePathOptions,
  SessionStatusLine,
} from './session-state-store.js';
