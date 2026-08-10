import type {
  SendWorkerMessageOptions,
  SendWorkerMessageResult,
} from './send-worker-message.js';

export type WorkerOutboundHandler = (
  worker: string,
  instruction: string,
  options?: SendWorkerMessageOptions,
) => SendWorkerMessageResult;

/** conductor → worker の outbound ルーティング（1 対多）。 */
export class WorkerOutboundQueue {
  constructor(private readonly handler: WorkerOutboundHandler) {}

  enqueue(
    worker: string,
    instruction: string,
    options?: SendWorkerMessageOptions,
  ): SendWorkerMessageResult {
    return this.handler(worker, instruction, options);
  }
}
