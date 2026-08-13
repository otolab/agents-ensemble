/** harness runtime 上の worker ライフサイクル状態（`list_workers` / `get_worker_status` の正本語彙）。 */
export type WorkerLifecycleState =
  | 'attaching'
  | 'idle'
  | 'processing'
  | 'failed';
