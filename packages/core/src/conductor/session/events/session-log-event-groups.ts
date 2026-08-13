/** harness-events.md §2.1–2.3 / worktree ライフサイクル。 */
export const HARNESS_TELEMETRY_EVENT_TYPES = [
  'harness.worktree',
  'harness.worktree.removed',
  'harness.worktree.remove_skipped',
  'harness.worktree.remove_failed',
  'harness.worker.prompt.started',
  'harness.worker.prompt.completed',
  'harness.worker.prompt.failed',
  'harness.worker.acp.update',
  'harness.worker.state',
  'harness.session.workers',
  'operator.input',
  'conductor.send.started',
  'conductor.send.progress',
  'conductor.send',
  'permission.pending',
  'worker.round',
  'worker.failed',
  'session.stop',
  'harness.github.update',
  'harness.github.monitor_error',
  'harness.warning',
] as const;

/** harness-events.md §2.4 セッション観測イベント。 */
export const SESSION_OBSERVATION_EVENT_TYPES = [
  'open.question.enqueued',
  'escalation.recorded',
  'session.worktree.notice',
  'session.continue',
  'session.post_loop_wait',
  'session.operator_exit',
  'harness.teardown',
] as const;

/** session-logging.md / conductor-auth-reconnect.md の補助テレメトリ。 */
export const SESSION_AUXILIARY_EVENT_TYPES = [
  'worker.process.stderr',
  'conductor.auth.recovery',
  'conductor.auth.reconnect',
] as const;

export const ALL_SESSION_LOG_EVENT_TYPES = [
  ...HARNESS_TELEMETRY_EVENT_TYPES,
  ...SESSION_OBSERVATION_EVENT_TYPES,
  ...SESSION_AUXILIARY_EVENT_TYPES,
] as const;

export type SessionLogEventType = (typeof ALL_SESSION_LOG_EVENT_TYPES)[number];

/** harness-events.md §3 の conductor dispatch イベント。 */
export const SESSION_EVENT_TYPES = [
  'operator.message',
  'worker.completed',
  'worker.failed',
  'permission.pending',
  'github.update',
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];
