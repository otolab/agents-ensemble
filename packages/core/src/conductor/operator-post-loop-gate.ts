export type OperatorPostLoopAction = 'exit' | 'resume';

/** 自律ループ停止後、オペレータの `/exit` または追加指示を待つ。 */
export interface OperatorPostLoopGate {
  isWaiting(): boolean;
  /** `prepareForWait` 後・`wait` 前の短い窓で post-loop 向け notify を受け付けるか。 */
  isPreparedForWait(): boolean;
  /** `session.post_loop_wait` emit 直前に呼ぶ。`wait` 前の `/exit` レースを防ぐ。 */
  prepareForWait(): void;
  wait(signal: AbortSignal): Promise<OperatorPostLoopAction>;
  notifyExit(): void;
  notifyResume(): void;
}

export function createOperatorPostLoopGate(): OperatorPostLoopGate {
  let resolveWait: ((action: OperatorPostLoopAction) => void) | undefined;
  let preparedForWait = false;
  let pendingAction: OperatorPostLoopAction | undefined;

  const consumePendingAction = (): OperatorPostLoopAction | undefined => {
    const action = pendingAction;
    pendingAction = undefined;
    return action;
  };

  return {
    isWaiting: () => resolveWait !== undefined,
    isPreparedForWait: () => preparedForWait,
    prepareForWait() {
      if (!resolveWait) {
        preparedForWait = true;
      }
    },
    wait(signal) {
      preparedForWait = false;
      const pending = consumePendingAction();
      if (pending) {
        return Promise.resolve(pending);
      }
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
      if (resolveWait) {
        resolveWait('exit');
        return;
      }
      if (preparedForWait) {
        pendingAction = 'exit';
      }
    },
    notifyResume() {
      if (resolveWait) {
        resolveWait('resume');
        return;
      }
      if (preparedForWait) {
        pendingAction = 'resume';
      }
    },
  };
}
