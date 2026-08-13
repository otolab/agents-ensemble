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
} from './session-sidecar.js';
export type {
  FindLatestSessionSidecarInput,
  SessionSidecar,
  WorkerSessionSidecar,
} from './session-sidecar.js';
