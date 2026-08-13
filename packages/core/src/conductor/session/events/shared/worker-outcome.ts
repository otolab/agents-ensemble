import type { WorkerDispatchResult } from '../../../../dispatch/worker-dispatch.js';
import type { WorkerFailureRecord } from '../../../../runtime/types.js';

/**
 * worker ラウンド完了の共有 payload。
 * SessionLogEvent は `worker.round`（field: `dispatch`）、
 * SessionEvent は `worker.completed`（field: `result`）— 意図的な別名。
 */
export type WorkerRoundOutcome = WorkerDispatchResult;

/** worker 失敗の共有 payload（両 union で `worker.failed` / field: `failure`）。 */
export type WorkerFailureOutcome = WorkerFailureRecord;
