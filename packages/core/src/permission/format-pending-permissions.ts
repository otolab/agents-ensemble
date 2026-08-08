import type { PendingPermission } from './pending-permission.js';

export function formatPendingPermissionSummaries(
  pending: PendingPermission[],
): string[] {
  if (pending.length === 0) {
    return ['(なし)'];
  }

  return pending.map((entry) => {
    const session = entry.request.sessionId
      ? ` session=${entry.request.sessionId}`
      : '';
    return `- id=${entry.id} worker=${entry.workerId} tool=${entry.request.toolName}${session}`;
  });
}
