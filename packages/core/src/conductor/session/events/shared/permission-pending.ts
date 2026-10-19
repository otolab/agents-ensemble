import type { PendingPermission } from '../../../../permission/pending-permission.js';
import type { PermissionBrief } from '../../../../permission/permission-brief.js';

/** `SessionEvent.permission.pending` の payload。 */
export interface PermissionPendingConductorPayload {
  permission: PendingPermission;
  /** Operator-facing worker label; `workerId` remains the harness identifier. */
  worker?: string;
  /** Structured decision context; generated from params if omitted by callers. */
  brief?: PermissionBrief;
  /** worker / tool / operation / request id を含む operator 向け要約。 */
  operatorSummary?: string;
}

/** `SessionLogEvent.permission.pending` の payload（オペレータ向けラベル付き）。 */
export interface PermissionPendingHarnessPayload
  extends PermissionPendingConductorPayload {
  /** worker kind など、オペレータ向けの短いラベル。 */
  workerLabel: string;
}
