import { OperatorLockTimeoutError } from '../workspace/operator-workspace-lock.js';

export function createOperatorWaiters(
  sendSuppression: AbortController,
  inputEnding: AbortController,
  isInputEnded: () => boolean,
  writeChannelLine: (channel: 'harness', detail: string) => void,
) {
  const waitForAcknowledgementRetry = (delayMs: number, stopOnInputEnd = false) =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const abort = () => finish(true);
      const finish = (stopped: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sendSuppression.signal.removeEventListener('abort', abort);
        inputEnding.signal.removeEventListener('abort', abort);
        resolve(stopped);
      };
      timer = setTimeout(() => finish(false), delayMs);
      sendSuppression.signal.addEventListener('abort', abort);
      if (stopOnInputEnd) inputEnding.signal.addEventListener('abort', abort);
      if (sendSuppression.signal.aborted || (stopOnInputEnd && inputEnding.signal.aborted)) abort();
    });
  const retryWatchLock = async <T>(
    operation: () => Promise<T>,
    description: string,
    stopWhenInputEnded = false,
  ): Promise<{ stopped: true } | { stopped: false; value: T }> => {
    const inputAlreadyEnded = isInputEnded();
    while (true) {
      try {
        const value = await operation();
        if (
          sendSuppression.signal.aborted ||
          (isInputEnded() && (stopWhenInputEnded || !inputAlreadyEnded))
        ) return { stopped: true };
        return { stopped: false, value };
      } catch (error) {
        if (!(error instanceof OperatorLockTimeoutError)) throw error;
        writeChannelLine(
          'harness',
          `監視報告の${description}は lock の競合で待機中です。1 秒後に再試行します。`,
        );
        if (await waitForAcknowledgementRetry(1_000, true)) return { stopped: true };
      }
    }
  };
  return { waitForAcknowledgementRetry, retryWatchLock };
}
