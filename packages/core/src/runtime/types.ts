import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import type { PermissionRequest } from '../permission/permission-request.js';

export interface WorkerStartParams {
  issueUrl: string;
  skillName: string;
  repoRoot: string;
}

export interface WorkerStartedInfo extends WorkerStartParams {
  workerId: string;
}

export type InboxMessage =
  | {
      type: 'permission.request';
      id: string;
      workerId: string;
      request: PermissionRequest;
    }
  | {
      type: 'worker.completed';
      workerId: string;
      result: WorkerDispatchResult;
    }
  | {
      type: 'worker.failed';
      workerId: string;
      error: string;
    };

export type InboxListener = (message: InboxMessage) => void | Promise<void>;
