/** harness 上の worker 状態（conductor 向け読み取り専用照会）。 */

export type WorkerHarnessState =
  | 'attaching'
  | 'idle'
  | 'processing'
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
  /** ACP attach 中の worker 数（init prompt 前の接続フェーズ）。 */
  attachInFlight: number;
  workerFailureCount: number;
  workers: WorkerStatusSummary[];
}
