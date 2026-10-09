import type { PermissionPipeline } from './permission-pipeline.js';

/** pending permission が継続したとみなす閾値（ms）。Issue #416 / harness-events.md §6。 */
export const DEFAULT_PERMISSION_DEADLOCK_STALL_MS = 300_000;

/** デッドロック検知の poll 間隔（ms）。 */
export const DEFAULT_PERMISSION_DEADLOCK_POLL_MS = 5_000;

export interface PermissionDeadlockActivitySnapshot {
  attachInFlight: number;
  hasProcessingWorker: boolean;
}

/** conductor に届ける permission 停滞通知の追加コンテキスト。 */
export interface PermissionDeadlockStall {
  message: string;
  pendingPermissionIds: string[];
  pendingPermissionCount: number;
  oldestPermissionCreatedAt: number;
  stallAgeMs: number;
  stallThresholdMs: number;
}

export interface PermissionDeadlockMonitorOptions {
  pipeline: PermissionPipeline;
  getActivitySnapshot: () => PermissionDeadlockActivitySnapshot;
  onWarning: (message: string) => void;
  /** `harness.warning` と同じ検知時に conductor 通知を受け取る。 */
  onStall?: (stall: PermissionDeadlockStall) => void;
  stallThresholdMs?: number;
  pollIntervalMs?: number;
  shutdownSignal?: AbortSignal;
  now?: () => number;
}

export interface PermissionDeadlockMonitor {
  start(): void;
  stop(): void;
}

export function formatPermissionDeadlockWarningMessage(
  stallThresholdMs: number = DEFAULT_PERMISSION_DEADLOCK_STALL_MS,
): string {
  const seconds = Math.round(stallThresholdMs / 1000);
  return `init prompt / prompt 実行中の permission が未解消のまま ${seconds}s 以上継続しています。conductor が resolve_permission していない可能性（ADR 0016 参照）`;
}

export function isPermissionDeadlockRisk(
  activity: PermissionDeadlockActivitySnapshot,
  pendingCount: number,
): boolean {
  if (pendingCount === 0) {
    return false;
  }
  return activity.attachInFlight > 0 || activity.hasProcessingWorker;
}

export function createPermissionDeadlockMonitor(
  options: PermissionDeadlockMonitorOptions,
): PermissionDeadlockMonitor {
  const stallThresholdMs =
    options.stallThresholdMs ?? DEFAULT_PERMISSION_DEADLOCK_STALL_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_PERMISSION_DEADLOCK_POLL_MS;
  const now = options.now ?? Date.now;

  let started = false;
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let warnedForCurrentStall = false;

  const schedulePoll = () => {
    if (stopped || !started) return;
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
    }
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      check();
      schedulePoll();
    }, pollIntervalMs);
  };

  const check = () => {
    const pending = options.pipeline.pending.list();
    if (pending.length === 0) {
      warnedForCurrentStall = false;
      return;
    }

    const activity = options.getActivitySnapshot();
    if (!isPermissionDeadlockRisk(activity, pending.length)) {
      warnedForCurrentStall = false;
      return;
    }

    const oldestPermissionCreatedAt = Math.min(
      ...pending.map((entry) => entry.createdAt),
    );
    const stallAgeMs = now() - oldestPermissionCreatedAt;
    if (stallAgeMs < stallThresholdMs) {
      return;
    }

    if (warnedForCurrentStall) {
      return;
    }

    warnedForCurrentStall = true;
    const message = formatPermissionDeadlockWarningMessage(stallThresholdMs);
    options.onWarning(message);
    options.onStall?.({
      message,
      pendingPermissionIds: pending.map((entry) => entry.id),
      pendingPermissionCount: pending.length,
      oldestPermissionCreatedAt,
      stallAgeMs,
      stallThresholdMs,
    });
  };

  const stopMonitor = () => {
    if (stopped) return;
    stopped = true;
    started = false;
    options.shutdownSignal?.removeEventListener('abort', onAbort);
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  };

  const onAbort = () => {
    stopMonitor();
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      options.shutdownSignal?.addEventListener('abort', onAbort, { once: true });
      schedulePoll();
    },
    stop() {
      stopMonitor();
    },
  };
}
