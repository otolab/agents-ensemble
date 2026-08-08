import type { SDKCustomTool } from '@cursor/sdk';
import type { ConductorInbox } from '../runtime/conductor-inbox.js';
import type { PermissionPipeline } from './permission-pipeline.js';
import type { PendingPermission } from './pending-permission.js';

export interface ResolvePermissionToolOptions {
  pipeline: PermissionPipeline;
  inbox: ConductorInbox;
  onResolved?: (input: {
    entry: PendingPermission;
    approved: boolean;
    reason?: string;
  }) => void;
}

export function createResolvePermissionTool(
  options: ResolvePermissionToolOptions,
): Record<string, SDKCustomTool> {
  return {
    resolve_permission: {
      description:
        'Resolve a pending worker permission request. When the operator already answered in dialogue, use answer_open_question first, then call this.',
      inputSchema: {
        type: 'object',
        properties: {
          requestId: {
            type: 'string',
            description: 'Pending permission id from the session state',
          },
          decision: {
            type: 'string',
            enum: ['allow', 'deny'],
            description: 'allow or deny the worker tool request',
          },
          reason: {
            type: 'string',
            description: 'Optional rationale recorded for the session',
          },
        },
        required: ['requestId', 'decision'],
      },
      async execute(args) {
        const requestId = String(args.requestId ?? '').trim();
        if (!requestId) {
          throw new Error('resolve_permission requires requestId');
        }

        const decision = String(args.decision ?? '').trim().toLowerCase();
        if (decision !== 'allow' && decision !== 'deny') {
          throw new Error('resolve_permission decision must be allow or deny');
        }

        const approved = decision === 'allow';
        const reason = args.reason ? String(args.reason) : undefined;
        const entry = options.pipeline.resolveAndFulfill(
          options.inbox,
          requestId,
          approved,
        );
        options.onResolved?.({ entry, approved, reason });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  requestId,
                  decision,
                  workerId: entry.workerId,
                  toolName: entry.request.toolName,
                  ...(reason ? { reason } : {}),
                },
                null,
                2,
              ),
            },
          ],
          structuredContent: {
            requestId,
            decision,
            workerId: entry.workerId,
            toolName: entry.request.toolName,
            ...(reason ? { reason } : {}),
          },
        };
      },
    },
  };
}
