import type { WorkerLifecycleState } from '../runtime/worker-lifecycle-state.js';

/** Harness activity, not a progress or health guarantee. */
export type SessionWorkStatus = 'working' | 'waiting' | 'unknown';

export function classifySessionWorkStatus(input: {
  conductorSending: boolean;
  workers: Array<{ state: WorkerLifecycleState; queueDepth: number; permissionPending: boolean }>;
  shuttingDown: boolean;
  unresolvedPermissions: boolean;
}): SessionWorkStatus {
  if (input.shuttingDown || input.unresolvedPermissions) return 'unknown';
  if (input.workers.some(
    (worker) => worker.state === 'processing' && !worker.permissionPending,
  )) return 'working';
  if (
    input.conductorSending ||
    input.workers.some((worker) =>
      worker.state === 'attaching' ||
      worker.state === 'failed' ||
      worker.queueDepth > 0,
    )
  ) return 'unknown';
  return 'waiting';
}
