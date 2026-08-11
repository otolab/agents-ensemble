export type OperatorPostLoopAction = 'exit' | 'resume';

/** 自律ループ停止後、オペレータの `/exit` または追加指示を待つ。 */
export interface OperatorPostLoopGate {
  isWaiting(): boolean;
  wait(signal: AbortSignal): Promise<OperatorPostLoopAction>;
  notifyExit(): void;
  notifyResume(): void;
}

export function createOperatorPostLoopGate(): OperatorPostLoopGate {
  let resolveWait: ((action: OperatorPostLoopAction) => void) | undefined;

  return {
    isWaiting: () => resolveWait !== undefined,
    wait(signal) {
      if (signal.aborted) {
        return Promise.resolve('exit');
      }
      return new Promise((resolve) => {
        const finish = (action: OperatorPostLoopAction) => {
          signal.removeEventListener('abort', onAbort);
          resolveWait = undefined;
          resolve(action);
        };
        const onAbort = () => finish('exit');
        signal.addEventListener('abort', onAbort, { once: true });
        resolveWait = finish;
      });
    },
    notifyExit() {
      resolveWait?.('exit');
    },
    notifyResume() {
      resolveWait?.('resume');
    },
  };
}
