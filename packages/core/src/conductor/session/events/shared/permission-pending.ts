import type { PendingPermission } from '../../../../permission/pending-permission.js';

/** `SessionEvent.permission.pending` の payload。 */
export interface PermissionPendingConductorPayload {
  permission: PendingPermission;
}

/** `SessionLogEvent.permission.pending` の payload（オペレータ向けラベル付き）。 */
export interface PermissionPendingHarnessPayload
  extends PermissionPendingConductorPayload {
  /** worker kind など、オペレータ向けの短いラベル。 */
  workerLabel: string;
}
