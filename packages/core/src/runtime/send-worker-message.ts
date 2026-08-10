/** `sendWorkerMessage` / `prompt_worker` の受付結果。 */
export type SendWorkerMessageStatus =
  | 'sent'
  | 'queued'
  | 'preempted'
  | 'error';

export interface SendWorkerMessageOptions {
  /** true のとき進行中ターンを `session/cancel` して新指示を優先する。 */
  preempt?: boolean;
}

export interface SendWorkerMessageResult {
  status: SendWorkerMessageStatus;
  worker: string;
  /** `queued` のとき、当該 worker キュー内の位置（1 始まり）。 */
  position?: number;
  message?: string;
}
