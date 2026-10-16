import type { PendingPermission } from '../../../../permission/pending-permission.js';

/** `SessionEvent.permission.pending` の payload。 */
export interface PermissionPendingConductorPayload {
  permission: PendingPermission;
  /** worker / tool / operation / request id を含む operator 向け要約。 */
  operatorSummary?: string;
}

/** `SessionLogEvent.permission.pending` の payload（オペレータ向けラベル付き）。 */
export interface PermissionPendingHarnessPayload
  extends PermissionPendingConductorPayload {
  /** worker kind など、オペレータ向けの短いラベル。 */
  workerLabel: string;
}
