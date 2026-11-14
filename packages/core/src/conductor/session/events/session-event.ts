import type { GitHubUpdateItem } from '../../../github/github-update-types.js';
import type { WorkerDispatchResult } from '../../../dispatch/worker-dispatch.js';
import type { WorkerSessionRecoveryReason } from '../../../dispatch/worker-acp-session.js';
import type { SessionEventDispatchFields } from './shared/dispatch-fields.js';
import type { PermissionPendingConductorPayload } from './shared/permission-pending.js';
import type { WorkerFailureOutcome } from './shared/worker-outcome.js';

export type { SessionEventDispatchFields } from './shared/dispatch-fields.js';

/** ConductorSession のイベント列に載る項目（SDK tool 結果は含めない）。 */
export type SessionEvent =
  | OperatorMessageEvent
  | OperatorReconnectEvent
  | WorkerCompletedEvent
  | WorkerFailedEvent
  | WorkerSessionRecoveredEvent
  | PermissionPendingEvent
  | PermissionStallEvent
  | HarnessConnectivityRecoveredEvent
  | ConductorRecoveryReportEvent
  | GitHubUpdateEvent;

export interface OperatorMessageEvent extends SessionEventDispatchFields {
  type: 'operator.message';
  text: string;
  /** Original operator-authored text when `text` also includes harness context. */
  operatorInput?: string;
  delivery?: OperatorMessageDelivery;
  /** Open Question の回答を含む入力。 */
  openQuestionAnswer?: boolean;
  /** 表示用の回答。conductor に渡す text は変更しない。 */
  answerPreview?: string;
}

export type OperatorMessageDelivery = 'idle' | 'next' | 'interrupt';

/** Conductor に送らず、現在の conductor agent だけを再接続する操作。 */
export interface OperatorReconnectEvent extends SessionEventDispatchFields {
  type: 'operator.reconnect';
}

export interface WorkerCompletedEvent extends SessionEventDispatchFields {
  type: 'worker.completed';
  result: WorkerDispatchResult;
}

export interface WorkerFailedEvent extends SessionEventDispatchFields {
  type: 'worker.failed';
  failure: WorkerFailureOutcome;
}

/** worker が保存済み ACP thread を復元できず、新しい thread に切り替えた通知。 */
export interface WorkerSessionRecoveredEvent
  extends SessionEventDispatchFields {
  type: 'worker.session.recovered';
  name: string;
  kind: string;
  reason: WorkerSessionRecoveryReason;
}

export interface PermissionPendingEvent
  extends SessionEventDispatchFields,
    PermissionPendingConductorPayload {
  type: 'permission.pending';
}

/** pending permission の長時間停滞を伝える低優先度の harness 通知。 */
export interface PermissionStallEvent extends SessionEventDispatchFields {
  type: 'permission.stall';
  message: string;
  pendingPermissionIds: string[];
  pendingPermissionCount: number;
  oldestPermissionCreatedAt: number;
  stallAgeMs: number;
  stallThresholdMs: number;
}

/** GitHub monitor が retryable poll エラー後に復旧したことを伝える。 */
export interface HarnessConnectivityRecoveredEvent
  extends SessionEventDispatchFields {
  type: 'harness.connectivity.recovered';
  source: 'github_monitor';
  suppressedErrorCount: number;
}

/**
 * @deprecated Legacy model-facing recovery event retained for compatibility.
 * Built-in workflows use a local operator warning and do not enqueue it.
 */
export interface ConductorRecoveryReportEvent
  extends SessionEventDispatchFields {
  type: 'conductor.recovery.report';
  recoveryId: string;
  failedDispatch: {
    sendCount: number;
    runId: string;
    sourceKey: string;
    eventTypes: string[];
    eventCount: number;
    eventReferences: Array<{
      /** failed dispatch 内の1始まりの位置。同じ参照が重なっても位置を保つ。 */
      eventIndex: number;
      type: string;
      /** 機密を含まない照合用の参照。元 event の本文は保持しない。 */
      reference?: string;
    }>;
    eventReferencesTruncated: boolean;
  };
  failure: {
    kind: 'pi_api_key_resolution';
    automaticRetryAttempts: 0 | 1;
    toolCallStarted: boolean;
  };
  reconnect: {
    kind: 'manual';
    succeeded: true;
  };
}

export interface GitHubUpdateEvent extends SessionEventDispatchFields {
  type: 'github.update';
  items: GitHubUpdateItem[];
}
