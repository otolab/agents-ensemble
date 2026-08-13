import type { GitHubUpdateItem } from '../../../github/github-update-types.js';
import type { WorkerDispatchResult } from '../../../dispatch/worker-dispatch.js';
import type { SessionEventDispatchFields } from './shared/dispatch-fields.js';
import type { PermissionPendingConductorPayload } from './shared/permission-pending.js';
import type { WorkerFailureOutcome } from './shared/worker-outcome.js';

export type { SessionEventDispatchFields } from './shared/dispatch-fields.js';

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
  failure: WorkerFailureOutcome;
}

export interface PermissionPendingEvent
  extends SessionEventDispatchFields,
    PermissionPendingConductorPayload {
  type: 'permission.pending';
}

export interface GitHubUpdateEvent extends SessionEventDispatchFields {
  type: 'github.update';
  items: GitHubUpdateItem[];
}
