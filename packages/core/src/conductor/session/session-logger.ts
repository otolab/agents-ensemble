import type { WorkerDispatchResult } from '../../dispatch/worker-dispatch.js';
import type { EscalationRecord } from '../../escalation/human-inquiry.js';
import type { OpenQuestion } from '../../escalation/open-question.js';
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
      type: 'operator.input';
      conductorTurn: number;
      text: string;
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
      type: 'worker.round';
      dispatch: WorkerDispatchResult;
    }
  | {
      type: 'worker.failed';
      failure: WorkerFailureRecord;
    }
  | {
      type: 'session.stop';
      stopReason: IssueLoopStopReason;
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
      case 'operator.input':
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
    };
  }
}
