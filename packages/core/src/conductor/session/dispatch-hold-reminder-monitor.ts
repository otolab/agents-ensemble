/** dispatch hold の operator 向けリマインド間隔（ms）。 */
export const DEFAULT_DISPATCH_HOLD_REMINDER_MS = 1_800_000;

/** dispatch hold reminder の poll 間隔（ms）。 */
export const DEFAULT_DISPATCH_HOLD_REMINDER_POLL_MS = 5_000;

export interface DispatchHoldReminderSnapshot {
  hold: boolean;
  heldEventCount: number;
}

export interface DispatchHoldReminderOptions {
  getSnapshot: () => DispatchHoldReminderSnapshot;
  onReminder: (snapshot: DispatchHoldReminderSnapshot) => void;
  reminderIntervalMs?: number;
  pollIntervalMs?: number;
  shutdownSignal?: AbortSignal;
  now?: () => number;
}

export interface DispatchHoldReminderMonitor {
  start(): void;
  stop(): void;
  onHoldChanged(hold: boolean): void;
}

/**
 * dispatch hold が続いている間、一定間隔で operator 向け reminder を発火する。
 * hold の episode は DispatchHoldChange で同期的に更新し、件数は発火時に snapshot から読む。
 */
export function createDispatchHoldReminderMonitor(
  options: DispatchHoldReminderOptions,
): DispatchHoldReminderMonitor {
  const reminderIntervalMs =
    options.reminderIntervalMs ?? DEFAULT_DISPATCH_HOLD_REMINDER_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_DISPATCH_HOLD_REMINDER_POLL_MS;
  const now = options.now ?? Date.now;

  let started = false;
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let holdActive = false;
  let nextReminderAt: number | undefined;

  const observeHold = (hold: boolean): void => {
    if (!hold) {
      holdActive = false;
      nextReminderAt = undefined;
      return;
    }
    if (!holdActive) {
      holdActive = true;
      nextReminderAt = now() + reminderIntervalMs;
    }
  };

  const check = (): void => {
    const snapshot = options.getSnapshot();
    observeHold(snapshot.hold);
    if (!snapshot.hold || nextReminderAt === undefined) return;

    const currentTime = now();
    if (currentTime < nextReminderAt) return;

    options.onReminder(snapshot);
    nextReminderAt = currentTime + reminderIntervalMs;
  };

  const schedulePoll = (): void => {
    if (stopped || !started) return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      check();
      schedulePoll();
    }, pollIntervalMs);
  };

  const stopMonitor = (): void => {
    if (stopped) return;
    stopped = true;
    started = false;
    options.shutdownSignal?.removeEventListener('abort', onAbort);
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  };

  const onAbort = (): void => {
    stopMonitor();
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      options.shutdownSignal?.addEventListener('abort', onAbort, {
        once: true,
      });
      schedulePoll();
    },
    stop() {
      stopMonitor();
    },
    onHoldChanged(hold) {
      observeHold(hold);
    },
  };
}

export function formatDispatchHoldReminderMessage(
  heldEventCount: number,
  reminderIntervalMs: number = DEFAULT_DISPATCH_HOLD_REMINDER_MS,
): string {
  const seconds = Math.round(reminderIntervalMs / 1000);
  const elapsed =
    seconds >= 60 && seconds % 60 === 0
      ? `${seconds / 60} 分`
      : `${seconds} 秒`;
  return `conductor dispatch の保留が ${elapsed} 続いています。held buffer に現在 ${heldEventCount} 件あります。可能であれば set_dispatch_hold({ hold: false }) で解除してください。`;
}
