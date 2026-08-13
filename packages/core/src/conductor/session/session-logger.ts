import type { WorkerDispatchResult } from '../../dispatch/worker-dispatch.js';
import type { EscalationRecord } from '../../escalation/human-inquiry.js';
import type { OpenQuestion } from '../../escalation/open-question.js';
import type { PendingPermission } from '../../permission/pending-permission.js';
import type { WorkerFailureRecord } from '../../runtime/types.js';
import type { WorkerWorktreeMode } from '../../worktree/worktree.js';
import type { IssueLoopStopReason } from '../session-policy.js';
import type { ConductorSessionResult } from '../conductor-session.js';

/** セッション終了時の exit report（`ConductorSessionResult` の別名）。 */
export type SessionSummary = ConductorSessionResult;

export type SessionLogEvent =
  | {
      type: 'harness.worktree';
      path: string;
      branch: string;
      mode: WorkerWorktreeMode;
    }
  | {
      type: 'harness.worktree.removed';
      path: string;
      branch: string;
    }
  | {
      type: 'harness.worktree.remove_skipped';
      path: string;
      branch: string;
      reason: 'dirty';
    }
  | {
      type: 'harness.worktree.remove_failed';
      path: string;
      branch: string;
      error: string;
    }
  | {
      type: 'harness.worker.prompt.started';
      name: string;
      kind: string;
      workerId: string;
      source: 'harness' | 'conductor';
    }
  | {
      type: 'harness.worker.prompt.completed';
      name: string;
      kind: string;
      workerId: string;
      source: 'harness' | 'conductor';
      stopReason: string;
    }
  | {
      type: 'harness.worker.prompt.failed';
      name: string;
      kind: string;
      workerId: string;
      source: 'harness' | 'conductor';
      error: string;
    }
  | {
      type: 'harness.worker.acp.update';
      name: string;
      kind: string;
      workerId: string;
      sessionUpdate: string;
      sessionId?: string;
    }
  | {
      type: 'operator.input';
      conductorTurn: number;
      text: string;
    }
  | {
      type: 'conductor.send.started';
      /** これから実行する send の通し番号（1 始まり）。 */
      sendCount: number;
      /** dispatch 束の source key（`operator` / `permission` / `worker:*` / `initial`）。 */
      dispatchSource?: string;
    }
  | {
      type: 'conductor.send.progress';
      sendCount: number;
      runId: string;
      tool: string;
    }
  | {
      type: 'conductor.send';
      sendCount: number;
      runId: string;
      status: string;
      result?: string;
      error?: { message: string; code?: string };
      workerDispatches: number;
      workerFailures: number;
    }
  | {
      type: 'permission.pending';
      permission: PendingPermission;
      /** worker kind など、オペレータ向けの短いラベル。 */
      workerLabel: string;
    }
  | {
      type: 'worker.round';
      dispatch: WorkerDispatchResult;
    }
  | {
      type: 'worker.failed';
      failure: WorkerFailureRecord;
    }
  | {
      type: 'worker.process.stderr';
      line: string;
      stream: 'stderr';
      workerName?: string;
    }
  | {
      type: 'session.stop';
      stopReason: IssueLoopStopReason;
    }
  | {
      type: 'open.question.enqueued';
      question: OpenQuestion;
    }
  | {
      type: 'escalation.recorded';
      record: EscalationRecord;
    }
  | {
      type: 'session.worktree.notice';
      mode: WorkerWorktreeMode;
    }
  | {
      type: 'session.continue';
      conductorAgentId: string;
    }
  | {
      type: 'session.post_loop_wait';
    }
  | {
      type: 'conductor.auth.recovery';
      agentId: string;
      hint: string;
    }
  | {
      type: 'conductor.auth.reconnect';
      agentId: string;
    }
  | {
      type: 'harness.github.update';
      itemCount: number;
    }
  | {
      type: 'harness.github.monitor_error';
      message: string;
    }
  | {
      type: 'harness.warning';
      message: string;
    };

export type SessionLogSink = (event: SessionLogEvent) => void;

export interface SessionLoggerOptions {
  issueUrl: string;
  repoRoot: string;
}

/** セッション中のイベントを時系列で記録し、終了時に SessionSummary を生成する。 */
export class SessionLogger {
  readonly workerDispatches: WorkerDispatchResult[] = [];
  readonly workerFailures: WorkerFailureRecord[] = [];

  private readonly sinks = new Set<SessionLogSink>();
  private sendCount = 0;
  private lastRunStatus = 'finished';
  private lastResult?: string;
  private lastError?: { message: string; code?: string };
  private stopReason: IssueLoopStopReason = 'completed';

  constructor(private readonly options: SessionLoggerOptions) {}

  subscribe(sink: SessionLogSink): () => void {
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  emit(event: SessionLogEvent): void {
    switch (event.type) {
      case 'conductor.send':
        this.sendCount = event.sendCount;
        this.lastRunStatus = event.status;
        this.lastResult = event.result;
        this.lastError = event.error;
        break;
      case 'worker.round':
        this.workerDispatches.push(event.dispatch);
        break;
      case 'worker.failed':
        this.workerFailures.push(event.failure);
        break;
      case 'session.stop':
        this.stopReason = event.stopReason;
        break;
      case 'harness.worktree':
      case 'harness.worktree.removed':
      case 'harness.worktree.remove_skipped':
      case 'harness.worktree.remove_failed':
      case 'harness.worker.prompt.started':
      case 'harness.worker.prompt.completed':
      case 'harness.worker.prompt.failed':
      case 'harness.worker.acp.update':
      case 'operator.input':
      case 'conductor.send.started':
      case 'conductor.send.progress':
      case 'permission.pending':
      case 'worker.process.stderr':
      case 'open.question.enqueued':
      case 'escalation.recorded':
      case 'session.worktree.notice':
      case 'session.continue':
      case 'session.post_loop_wait':
      case 'conductor.auth.recovery':
      case 'conductor.auth.reconnect':
      case 'harness.github.update':
      case 'harness.github.monitor_error':
      case 'harness.warning':
        break;
    }

    for (const sink of this.sinks) {
      sink(event);
    }
  }

  finish(stopReason: IssueLoopStopReason): void {
    this.emit({ type: 'session.stop', stopReason });
  }

  snapshot(input: {
    agentId: string;
    escalations: EscalationRecord[];
    openQuestions: OpenQuestion[];
    sessionUsage?: SessionSummary['sessionUsage'];
  }): SessionSummary {
    return {
      agentId: input.agentId,
      issueUrl: this.options.issueUrl,
      repoRoot: this.options.repoRoot,
      sendCount: this.sendCount,
      stopReason: this.stopReason,
      lastRunStatus: this.lastRunStatus,
      lastResult: this.lastResult,
      lastError: this.lastError,
      workerDispatches: [...this.workerDispatches],
      workerFailures: [...this.workerFailures],
      escalations: [...input.escalations],
      openQuestions: [...input.openQuestions],
      ...(input.sessionUsage ? { sessionUsage: input.sessionUsage } : {}),
    };
  }
}
