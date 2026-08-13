import type { EscalationRecord } from '../../../escalation/human-inquiry.js';
import type { OpenQuestion } from '../../../escalation/open-question.js';
import type { WorkerHarnessState } from '../../../runtime/worker-status.js';
import type { WorkerWorktreeMode } from '../../../worktree/worktree.js';
import type { IssueLoopStopReason } from '../../session-policy.js';
import type { PermissionPendingHarnessPayload } from './shared/permission-pending.js';
import type { WorkerPromptLifecycleSource } from './shared/worker-prompt-source.js';
import type {
  WorkerFailureOutcome,
  WorkerRoundOutcome,
} from './shared/worker-outcome.js';

export interface HarnessWorktreeEvent {
  type: 'harness.worktree';
  path: string;
  branch: string;
  mode: WorkerWorktreeMode;
}

export interface HarnessWorktreeRemovedEvent {
  type: 'harness.worktree.removed';
  path: string;
  branch: string;
}

export interface HarnessWorktreeRemoveSkippedEvent {
  type: 'harness.worktree.remove_skipped';
  path: string;
  branch: string;
  reason: 'dirty';
}

export interface HarnessWorktreeRemoveFailedEvent {
  type: 'harness.worktree.remove_failed';
  path: string;
  branch: string;
  error: string;
}

export interface HarnessWorkerPromptStartedEvent {
  type: 'harness.worker.prompt.started';
  name: string;
  kind: string;
  workerId: string;
  source: WorkerPromptLifecycleSource;
}

export interface HarnessWorkerPromptCompletedEvent {
  type: 'harness.worker.prompt.completed';
  name: string;
  kind: string;
  workerId: string;
  source: WorkerPromptLifecycleSource;
  stopReason: string;
}

export interface HarnessWorkerPromptFailedEvent {
  type: 'harness.worker.prompt.failed';
  name: string;
  kind: string;
  workerId: string;
  source: WorkerPromptLifecycleSource;
  error: string;
}

export interface HarnessWorkerAcpUpdateEvent {
  type: 'harness.worker.acp.update';
  name: string;
  kind: string;
  workerId: string;
  sessionUpdate: string;
  sessionId?: string;
  /** `tool_call` / `tool_call_update` 時の tool 名（あれば）。 */
  toolName?: string;
}

export interface HarnessWorkerStateEvent {
  type: 'harness.worker.state';
  name: string;
  kind: string;
  workerId: string;
  state: WorkerHarnessState;
}

export interface HarnessSessionWorkersEvent {
  type: 'harness.session.workers';
  workers: Array<{ name: string; kind: string }>;
}

export interface OperatorInputEvent {
  type: 'operator.input';
  conductorTurn: number;
  text: string;
}

export interface ConductorSendStartedEvent {
  type: 'conductor.send.started';
  /** これから実行する send の通し番号（1 始まり）。 */
  sendCount: number;
  /** dispatch 束の source key（`operator` / `permission` / `worker:*` / `initial`）。 */
  dispatchSource?: string;
}

export interface ConductorSendProgressEvent {
  type: 'conductor.send.progress';
  sendCount: number;
  runId: string;
  tool: string;
}

export interface ConductorSendEvent {
  type: 'conductor.send';
  sendCount: number;
  runId: string;
  status: string;
  result?: string;
  error?: { message: string; code?: string };
  workerDispatches: number;
  workerFailures: number;
}

export interface PermissionPendingLogEvent extends PermissionPendingHarnessPayload {
  type: 'permission.pending';
}

export interface WorkerRoundLogEvent {
  type: 'worker.round';
  dispatch: WorkerRoundOutcome;
}

export interface WorkerFailedLogEvent {
  type: 'worker.failed';
  failure: WorkerFailureOutcome;
}

export interface WorkerProcessStderrEvent {
  type: 'worker.process.stderr';
  line: string;
  stream: 'stderr';
  workerName?: string;
}

export interface SessionStopEvent {
  type: 'session.stop';
  stopReason: IssueLoopStopReason;
}

export interface OpenQuestionEnqueuedEvent {
  type: 'open.question.enqueued';
  question: OpenQuestion;
}

export interface EscalationRecordedEvent {
  type: 'escalation.recorded';
  record: EscalationRecord;
}

export interface SessionWorktreeNoticeEvent {
  type: 'session.worktree.notice';
  mode: WorkerWorktreeMode;
}

export interface SessionContinueEvent {
  type: 'session.continue';
  conductorAgentId: string;
}

export interface SessionPostLoopWaitEvent {
  type: 'session.post_loop_wait';
}

export interface SessionOperatorExitEvent {
  type: 'session.operator_exit';
}

export interface HarnessTeardownSummaryEvent {
  type: 'harness.teardown';
  force: boolean;
  durationMs: number;
  phases: Record<string, number>;
}

export interface ConductorAuthRecoveryEvent {
  type: 'conductor.auth.recovery';
  agentId: string;
  hint: string;
}

export interface ConductorAuthReconnectEvent {
  type: 'conductor.auth.reconnect';
  agentId: string;
}

export interface HarnessGitHubUpdateEvent {
  type: 'harness.github.update';
  itemCount: number;
}

export interface HarnessGitHubMonitorErrorEvent {
  type: 'harness.github.monitor_error';
  message: string;
}

export interface HarnessWarningEvent {
  type: 'harness.warning';
  message: string;
}

/** harness / TUI / snapshot 向けの時系列テレメトリイベント。 */
export type SessionLogEvent =
  | HarnessWorktreeEvent
  | HarnessWorktreeRemovedEvent
  | HarnessWorktreeRemoveSkippedEvent
  | HarnessWorktreeRemoveFailedEvent
  | HarnessWorkerPromptStartedEvent
  | HarnessWorkerPromptCompletedEvent
  | HarnessWorkerPromptFailedEvent
  | HarnessWorkerAcpUpdateEvent
  | HarnessWorkerStateEvent
  | HarnessSessionWorkersEvent
  | OperatorInputEvent
  | ConductorSendStartedEvent
  | ConductorSendProgressEvent
  | ConductorSendEvent
  | PermissionPendingLogEvent
  | WorkerRoundLogEvent
  | WorkerFailedLogEvent
  | WorkerProcessStderrEvent
  | SessionStopEvent
  | OpenQuestionEnqueuedEvent
  | EscalationRecordedEvent
  | SessionWorktreeNoticeEvent
  | SessionContinueEvent
  | SessionPostLoopWaitEvent
  | SessionOperatorExitEvent
  | HarnessTeardownSummaryEvent
  | ConductorAuthRecoveryEvent
  | ConductorAuthReconnectEvent
  | HarnessGitHubUpdateEvent
  | HarnessGitHubMonitorErrorEvent
  | HarnessWarningEvent;

export type SessionLogSink = (event: SessionLogEvent) => void;
