/** `sendWorkerMessage` / `prompt_worker` の受付結果。 */
export type SendWorkerMessageStatus = 'sent' | 'queued' | 'error';

export interface SendWorkerMessageResult {
  status: SendWorkerMessageStatus;
  worker: string;
  /** `queued` のとき、当該 worker キュー内の位置（1 始まり）。 */
  position?: number;
  message?: string;
}
