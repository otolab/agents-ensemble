import type { EscalationRecord } from '../../escalation/human-inquiry.js';
import type { OpenQuestion } from '../../escalation/open-question.js';
import type { WorkerDispatchResult } from '../../dispatch/worker-dispatch.js';
import type { WorkerFailureRecord } from '../../runtime/types.js';
import type { IssueLoopStopReason } from '../session-policy.js';
import type { ConductorSessionResult } from '../conductor-session.js';
import type { SessionLogEvent } from './events/session-log-event.js';

export type {
  SessionLogEvent,
  SessionLogSink,
} from './events/session-log-event.js';

/** セッション終了時の exit report（`ConductorSessionResult` の別名）。 */
export type SessionSummary = ConductorSessionResult;

export interface SessionLoggerOptions {
  issueUrl: string;
  repoRoot: string;
}

/** セッション中のイベントを時系列で記録し、終了時に SessionSummary を生成する。 */
export class SessionLogger {
  readonly workerDispatches: WorkerDispatchResult[] = [];
  readonly workerFailures: WorkerFailureRecord[] = [];

  private readonly sinks = new Set<
    (event: SessionLogEvent) => void
  >();
  private sendCount = 0;
  private lastRunStatus = 'finished';
  private lastResult?: string;
  private lastError?: { message: string; code?: string };
  private stopReason: IssueLoopStopReason = 'completed';

  constructor(private readonly options: SessionLoggerOptions) {}

  subscribe(sink: (event: SessionLogEvent) => void): () => void {
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
