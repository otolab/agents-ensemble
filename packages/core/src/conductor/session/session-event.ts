import type { WorkerDispatchResult } from '../../dispatch/worker-dispatch.js';
import type { GitHubUpdateItem } from '../../github/github-update-types.js';
import type { WorkerFailureRecord } from '../../runtime/types.js';
import type { PendingPermission } from '../../permission/pending-permission.js';
import type { DispatchMode } from './dispatch-mode.js';

/** SessionEvent に載せうる dispatch モード（#148）。既定は trigger。 */
export interface SessionEventDispatchFields {
  dispatchMode?: DispatchMode;
}

/** ConductorSession のイベント列に載る項目（SDK tool 結果は含めない）。 */
export type SessionEvent =
  | OperatorMessageEvent
  | WorkerCompletedEvent
  | WorkerFailedEvent
  | PermissionPendingEvent
  | GitHubUpdateEvent;

export interface OperatorMessageEvent extends SessionEventDispatchFields {
  type: 'operator.message';
  text: string;
}

export interface WorkerCompletedEvent extends SessionEventDispatchFields {
  type: 'worker.completed';
  result: WorkerDispatchResult;
}

export interface WorkerFailedEvent extends SessionEventDispatchFields {
  type: 'worker.failed';
  failure: WorkerFailureRecord;
}

export interface PermissionPendingEvent extends SessionEventDispatchFields {
  type: 'permission.pending';
  permission: PendingPermission;
}

export interface GitHubUpdateEvent extends SessionEventDispatchFields {
  type: 'github.update';
  items: GitHubUpdateItem[];
}

export function isConductorSendEvent(
  event: SessionEvent,
): event is
  | OperatorMessageEvent
  | WorkerCompletedEvent
  | WorkerFailedEvent
  | PermissionPendingEvent
  | GitHubUpdateEvent {
  return (
    event.type === 'operator.message' ||
    event.type === 'worker.completed' ||
    event.type === 'worker.failed' ||
    event.type === 'permission.pending' ||
    event.type === 'github.update'
  );
}
