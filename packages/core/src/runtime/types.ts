import type { WorktreeRef } from '../worktree/worktree.js';
import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import type { WorkerPromptSource } from '../dispatch/worker-dispatch.js';
import type { PermissionRequest } from '../permission/permission-request.js';

import type { EnsembleSessionState } from '../profile/types.js';

export interface WorkerStartParams {
  name: string;
  kind: string;
  systemPrompt: string;
  issueUrl: string;
  worktree: WorktreeRef;
  sessionState: EnsembleSessionState;
  resumeAcpSessionId?: string;
}

export interface WorkerStartedInfo extends WorkerStartParams {
  workerId: string;
}

export interface WorkerFailureRecord {
  workerId: string;
  name: string;
  error: string;
  issueUrl: string;
  kind: string;
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
      name: string;
      error: string;
      issueUrl: string;
      kind: string;
    };

export type InboxListener = (message: InboxMessage) => void | Promise<void>;

export interface WorkerPromptTelemetry {
  phase: 'started' | 'completed' | 'failed';
  source: WorkerPromptSource;
  workerId: string;
  name: string;
  kind: string;
  stopReason?: string;
  error?: string;
}

export interface WorkerAcpUpdateTelemetry {
  workerId: string;
  name: string;
  kind: string;
  sessionUpdate: string;
  sessionId?: string;
}

export interface WorkerStateTelemetry {
  workerId: string;
  name: string;
  kind: string;
  state: import('./worker-status.js').WorkerHarnessState;
}
