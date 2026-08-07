import type { PermissionDecision } from '../acp/types.js';
import type { PermissionRequest } from '../permission/permission-request.js';
import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import { ConductorInbox } from './conductor-inbox.js';

export interface InboxProcessorOptions {
  decidePermission: (
    request: PermissionRequest,
    workerId: string,
  ) => PermissionDecision | Promise<PermissionDecision>;
  onWorkerCompleted?: (result: WorkerDispatchResult) => void;
  onWorkerFailed?: (workerId: string, error: string) => void;
}

export interface InboxProcessorHandle {
  stop(): Promise<void>;
}

export function startInboxProcessor(
  inbox: ConductorInbox,
  options: InboxProcessorOptions,
): InboxProcessorHandle {
  const unsubscribe = inbox.subscribe(async (message) => {
    if (message.type === 'permission.request') {
      try {
        const decision = await options.decidePermission(
          message.request,
          message.workerId,
        );
        inbox.fulfillPermission(message.id, decision);
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
      options.onWorkerFailed?.(message.workerId, message.error);
    }
  });

  return {
    async stop() {
      await inbox.drain();
      unsubscribe();
    },
  };
}
