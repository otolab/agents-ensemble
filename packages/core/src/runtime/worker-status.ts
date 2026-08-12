/** harness 上の worker 状態（conductor 向け読み取り専用照会）。 */

export type WorkerHarnessState =
  | 'bootstrapping'
  | 'idle'
  | 'prompting'
  | 'failed';

export interface WorkerStatusSummary {
  name: string;
  kind: string;
  state: WorkerHarnessState;
  queueDepth: number;
  worktreePath?: string;
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
  bootstrapInFlight: number;
  workerFailureCount: number;
  workers: WorkerStatusSummary[];
}
