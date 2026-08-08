import type { WorkerDispatchResult } from '../../dispatch/worker-dispatch.js';
import type { WorkerFailureRecord } from '../../runtime/types.js';
import type { PendingPermission } from '../../permission/pending-permission.js';

/** ConductorSession のイベント列に載る項目（SDK tool 結果は含めない）。 */
export type SessionEvent =
  | OperatorMessageEvent
  | WorkerCompletedEvent
  | WorkerFailedEvent
  | PermissionPendingEvent;

export interface OperatorMessageEvent {
  type: 'operator.message';
  text: string;
}

export interface WorkerCompletedEvent {
  type: 'worker.completed';
  result: WorkerDispatchResult;
}

export interface WorkerFailedEvent {
  type: 'worker.failed';
  failure: WorkerFailureRecord;
}

export interface PermissionPendingEvent {
  type: 'permission.pending';
  permission: PendingPermission;
}

export function isConductorSendEvent(
  event: SessionEvent,
): event is OperatorMessageEvent | WorkerCompletedEvent | WorkerFailedEvent | PermissionPendingEvent {
  return (
    event.type === 'operator.message' ||
    event.type === 'worker.completed' ||
    event.type === 'worker.failed' ||
    event.type === 'permission.pending'
  );
}
