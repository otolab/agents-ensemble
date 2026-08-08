import type { PermissionDecision } from '../acp/types.js';
import type { PermissionRequest } from '../permission/permission-request.js';
import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import type { WorkerFailureRecord } from './types.js';
import { ConductorInbox } from './conductor-inbox.js';

export type PermissionDecisionOutcome =
  | PermissionDecision
  | null;

export interface InboxProcessorOptions {
  inbox: ConductorInbox;
  decidePermission: (
    request: PermissionRequest,
    workerId: string,
    requestId: string,
  ) => PermissionDecisionOutcome | Promise<PermissionDecisionOutcome>;
  onWorkerCompleted?: (result: WorkerDispatchResult) => void;
  onWorkerFailed?: (failure: WorkerFailureRecord) => void;
}

export interface InboxProcessorHandle {
  stop(): Promise<void>;
}

export function startInboxProcessor(
  options: InboxProcessorOptions,
): InboxProcessorHandle {
  const { inbox } = options;
  const unsubscribe = inbox.subscribe(async (message) => {
    if (message.type === 'permission.request') {
      try {
        const decision = await options.decidePermission(
          message.request,
          message.workerId,
          message.id,
        );
        if (decision !== null) {
          inbox.fulfillPermission(message.id, decision);
        }
      } catch (error) {
        inbox.rejectPermission(message.id, error);
      }
      return;
    }

    if (message.type === 'worker.completed') {
      options.onWorkerCompleted?.(message.result);
      return;
    }

    if (message.type === 'worker.failed') {
      options.onWorkerFailed?.({
        workerId: message.workerId,
        name: message.name,
        error: message.error,
        issueUrl: message.issueUrl,
        kind: message.kind,
      });
    }
  });

  return {
    async stop() {
      await inbox.drain();
      unsubscribe();
    },
  };
}
