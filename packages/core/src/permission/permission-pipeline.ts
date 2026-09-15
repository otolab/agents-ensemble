import type { PermissionDecision } from '../acp/types.js';
import type { ConductorInbox } from '../runtime/conductor-inbox.js';
import {
  allowOnce,
  deny,
} from './permission-broker.js';
import {
  evaluatePermissionPolicy,
  type PermissionPolicyRules,
} from './permission-policy.js';
import type { PermissionRequest } from './permission-request.js';
import {
  PendingPermissionRegistry,
  type PendingPermission,
} from './pending-permission.js';

export type PermissionPipelineOutcome =
  | { status: 'resolved'; decision: PermissionDecision }
  | { status: 'deferred' };

export interface PermissionPipelineOptions {
  policy?: PermissionPolicyRules;
  pending?: PendingPermissionRegistry;
}

/**
 * 許可パイプライン段1: 自明な policy 判定。
 * `ask` は pending に積み conductor 判断待ち（段2以降）。
 */
export class PermissionPipeline {
  readonly pending: PendingPermissionRegistry;

  constructor(private readonly options: PermissionPipelineOptions = {}) {
    this.pending = options.pending ?? new PendingPermissionRegistry();
  }

  evaluate(
    requestId: string,
    workerId: string,
    request: PermissionRequest,
  ): PermissionPipelineOutcome {
    const verdict = evaluatePermissionPolicy(request, this.options.policy);

    if (verdict === 'allow') {
      return { status: 'resolved', decision: allowOnce(request) };
    }
    if (verdict === 'deny') {
      return { status: 'resolved', decision: deny(request) };
    }

    this.pending.add({
      id: requestId,
      workerId,
      request,
      createdAt: Date.now(),
    });
    return { status: 'deferred' };
  }

  /** 段2: conductor が pending を解決し inbox へ伝播する。 */
  resolveAndFulfill(
    inbox: ConductorInbox,
    requestId: string,
    approved: boolean,
  ): PendingPermission {
    const entry = this.pending.take(requestId);
    if (!entry) {
      throw new Error(
        `Unknown pending permission (already resolved or worker failed): ${requestId}`,
      );
    }
    inbox.fulfillPermission(
      requestId,
      approved ? allowOnce(entry.request) : deny(entry.request),
    );
    return entry;
  }

  /** worker failure 時に、その worker の permission 待ちを deny して inbox waiter を解消する。 */
  denyPendingForWorker(
    inbox: ConductorInbox,
    workerId: string,
  ): PendingPermission[] {
    const entries = this.pending.takeForWorker(workerId);
    for (const entry of entries) {
      inbox.fulfillPermission(entry.id, deny(entry.request));
    }
    return entries;
  }
}
