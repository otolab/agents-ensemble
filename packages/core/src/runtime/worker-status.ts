import type { WorkerLifecycleState } from './worker-lifecycle-state.js';

/** @deprecated Use {@link WorkerLifecycleState}. */
export type WorkerHarnessState = WorkerLifecycleState;

export interface WorkerStatusSummary {
  name: string;
  kind: string;
  state: WorkerLifecycleState;
  queueDepth: number;
  worktreePath?: string;
  /** ACP 起動 cwd（要約）。profile `workspace` 指定時は Issue worktree と異なることがある。 */
  workspacePath?: string;
  acpSessionId?: string;
  /** attach 失敗時のみ */
  error?: string;
}

export interface WorkerStatusDetail extends WorkerStatusSummary {
  workerId?: string;
  queuePreview: string[];
  preemptPending: boolean;
  cancelInFlight: boolean;
}

export interface WorkerSessionStatusSummary {
  runningCount: number;
  attachedCount: number;
  /** ACP attach 中の worker 数（init prompt 前の接続フェーズ）。 */
  attachInFlight: number;
  workerFailureCount: number;
  workers: WorkerStatusSummary[];
}
