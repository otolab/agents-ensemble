export const OPERATOR_WATCH_ACK_RETRY_DELAY_MS = 5_000;
export const OPERATOR_WATCH_ACK_MAX_RETRIES = 3;

export type OperatorWatchAcknowledgementRetryResult =
  | {
      status: 'acknowledged';
      attempts: number;
      retries: number;
    }
  | {
      status: 'stopped';
      attempts: number;
      retries: number;
    }
  | {
      status: 'exhausted';
      attempts: number;
      retries: number;
      error: unknown;
    };

export async function retryOperatorWatchAcknowledgement(
  acknowledge: () => Promise<void>,
  waitBeforeRetry: (delayMs: number) => Promise<boolean>,
  onRetry: (retryNumber: number) => void = () => {},
): Promise<OperatorWatchAcknowledgementRetryResult> {
  let attempts = 0;
  let retries = 0;

  while (true) {
    attempts += 1;
    try {
      await acknowledge();
      return { status: 'acknowledged', attempts, retries };
    } catch (error) {
      if (retries >= OPERATOR_WATCH_ACK_MAX_RETRIES) {
        return {
          status: 'exhausted',
          attempts,
          retries,
          error,
        };
      }

      retries += 1;
      onRetry(retries);
      if (await waitBeforeRetry(OPERATOR_WATCH_ACK_RETRY_DELAY_MS)) {
        return { status: 'stopped', attempts, retries };
      }
    }
  }
}
