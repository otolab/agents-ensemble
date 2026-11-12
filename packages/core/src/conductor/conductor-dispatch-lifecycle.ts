import type { ConductorSendResult } from './conductor-agent.js';
import {
  classifyConductorRecoveryFailure,
  type ConductorRecoveryAttemptMetadata,
  type ConductorRecoveryBackend,
  type ConductorRecoveryFailureClass,
  type ConductorRecoveryReservation,
  type ConductorRecoverySnapshotSummary,
  type ConductorRecoveryWorkflow,
  ConductorRecoveryInbox,
  CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT,
} from './conductor-recovery-inbox.js';

export type ConductorDispatchState =
  | 'ready'
  | 'in_flight'
  | 'reconnecting'
  | 'unavailable'
  | 'attention';

export interface ConductorDispatchLease<T> {
  readonly id: number;
  readonly attemptId: string;
  readonly kind: 'send';
  readonly payload: T;
  readonly token: symbol;
}

export interface ConductorReconnectLease {
  readonly id: number;
  readonly attemptId: string;
  readonly kind: 'reconnect';
  readonly token: symbol;
}

interface ActiveLease {
  token: symbol;
  kind: 'send' | 'reconnect';
  id: number;
}

export interface SettleConductorDispatchInput<T> {
  lifecycle: ConductorDispatchLifecycle<T>;
  lease: ConductorDispatchLease<T>;
  inbox?: ConductorRecoveryInbox;
  reservation?: ConductorRecoveryReservation;
  workflow: ConductorRecoveryWorkflow;
  backend: ConductorRecoveryBackend;
  sendCount: number;
  sourceKey: string;
  eventTypes: readonly string[];
  operatorInputTexts: readonly string[];
  result: ConductorSendResult;
  automaticReconnect?: ConductorRecoveryAttemptMetadata['automaticReconnect'];
  toolCallStarted: boolean;
  /** Shutdown does not leave process-local recovery content behind. */
  captureFailure?: boolean;
  /** A workflow-specific retry can keep its existing settlement contract. */
  requiresConfirmation?: boolean;
  failureClass?: ConductorRecoveryFailureClass;
  /** A rejected send closes the handle until an explicit reconnect. */
  agentAvailable?: boolean;
}

export interface SettleConductorDispatchResult {
  completed: boolean;
  failureClass?: ConductorRecoveryFailureClass;
  snapshot?: ConductorRecoverySnapshotSummary;
}

/**
 * Applies one final send result to the shared lifecycle and optional inbox.
 * Workflow queues retain their own event-specific acknowledgement behavior.
 */
export function settleConductorDispatch<T>(
  input: SettleConductorDispatchInput<T>,
): SettleConductorDispatchResult {
  const completed =
    input.result.status === 'finished' ||
    input.result.status === 'completed' ||
    // The Issue workflow has historically treated `running` as a normal
    // nonterminal result and continues consuming later events. The
    // operator-agent workflow keeps its narrower acknowledgement contract so
    // watched reports can retry while user input waits for confirmation.
    (input.workflow === 'issue' && input.result.status === 'running');
  if (completed) {
    if (input.reservation) input.inbox?.release(input.reservation);
    input.lifecycle.settleSend(input.lease, { completed: true });
    return { completed: true };
  }

  const failureClass = classifyConductorRecoveryFailure(input.result);
  let snapshot: ConductorRecoverySnapshotSummary | undefined;
  const shouldCapture = input.captureFailure !== false;
  if (shouldCapture && input.operatorInputTexts.length > 0) {
    if (!input.inbox || !input.reservation) {
      throw new Error(
        'Operator input failed without an admitted recovery inbox reservation.',
      );
    }
    if (
      input.operatorInputTexts.reduce(
        (total, text) => total + Buffer.byteLength(text, 'utf8'),
        0,
      ) > CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT
    ) {
      throw new Error(
        'Operator input exceeded the recovery admission limit after selection.',
      );
    }
    const metadata: ConductorRecoveryAttemptMetadata = {
      recoveryId: `conductor-recovery-${input.lease.attemptId}`,
      workflow: input.workflow,
      backend: input.backend,
      sendCount: input.sendCount,
      ...(input.result.runId ? { runId: input.result.runId } : {}),
      sourceKey: input.sourceKey,
      eventTypes: [...new Set(input.eventTypes)],
      status: input.result.status,
      failureClass,
      ...(input.automaticReconnect
        ? { automaticReconnect: { ...input.automaticReconnect } }
        : {}),
      automaticRetryAttempts: 0,
      toolCallStarted: input.toolCallStarted,
    };
    snapshot = input.inbox.commit(
      input.reservation,
      metadata,
      input.operatorInputTexts,
    );
    if (!snapshot) {
      throw new Error(
        'Could not commit a reserved operator input to the recovery inbox.',
      );
    }
  } else if (input.reservation) {
    input.inbox?.release(input.reservation);
  }

  input.lifecycle.settleSend(input.lease, {
    completed: false,
    failureClass,
    ...(input.agentAvailable !== undefined
      ? { agentAvailable: input.agentAvailable }
      : {}),
    ...(input.requiresConfirmation !== undefined
      ? { requiresConfirmation: input.requiresConfirmation }
      : {}),
  });
  return { completed: false, failureClass, ...(snapshot ? { snapshot } : {}) };
}

/**
 * Owns the single in-flight conductor operation and its post-failure gate.
 * Workflow queues keep their selectors and settle their own event types.
 */
export class ConductorDispatchLifecycle<T> {
  private sequence = 0;
  private activeLease: ActiveLease | undefined;
  private agentAvailable = true;
  private attentionAttemptId: string | undefined;
  private lastFailureClass: ConductorRecoveryFailureClass | undefined;
  private readonly listeners = new Set<() => void>();

  get state(): ConductorDispatchState {
    if (this.activeLease?.kind === 'send') return 'in_flight';
    if (this.activeLease?.kind === 'reconnect') return 'reconnecting';
    if (!this.agentAvailable) return 'unavailable';
    if (this.attentionAttemptId !== undefined) return 'attention';
    return 'ready';
  }

  get available(): boolean {
    return this.agentAvailable;
  }

  get confirmationRequired(): boolean {
    return this.attentionAttemptId !== undefined;
  }

  get pendingAttemptId(): string | undefined {
    return this.attentionAttemptId;
  }

  get lastFailure(): ConductorRecoveryFailureClass | undefined {
    return this.lastFailureClass;
  }

  get canDispatch(): boolean {
    return (
      this.activeLease === undefined &&
      this.agentAvailable &&
      this.attentionAttemptId === undefined
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginSend(payload: T): ConductorDispatchLease<T> | undefined {
    if (!this.canDispatch) return undefined;
    const id = ++this.sequence;
    const token = Symbol(`conductor-send-${id}`);
    this.activeLease = { token, kind: 'send', id };
    this.notify();
    return {
      id,
      attemptId: String(id),
      kind: 'send',
      payload,
      token,
    };
  }

  beginReconnect(): ConductorReconnectLease | undefined {
    if (this.activeLease !== undefined) return undefined;
    const id = ++this.sequence;
    const token = Symbol(`conductor-reconnect-${id}`);
    this.activeLease = { token, kind: 'reconnect', id };
    this.notify();
    return { id, attemptId: String(id), kind: 'reconnect', token };
  }

  settleSend(
    lease: ConductorDispatchLease<T>,
    outcome: {
      completed: boolean;
      failureClass?: ConductorRecoveryFailureClass;
      /** Omit to preserve availability reported by an automatic reconnect. */
      agentAvailable?: boolean;
      /** Report-only retries keep their existing workflow-specific contract. */
      requiresConfirmation?: boolean;
    },
  ): void {
    this.assertActiveLease(lease, 'send');
    this.activeLease = undefined;
    if (outcome.agentAvailable !== undefined) {
      this.agentAvailable = outcome.agentAvailable;
    }
    if (outcome.completed) {
      this.attentionAttemptId = undefined;
      this.lastFailureClass = undefined;
    } else if (outcome.requiresConfirmation !== false) {
      this.attentionAttemptId = lease.attemptId;
      this.lastFailureClass = outcome.failureClass;
    } else {
      this.lastFailureClass = outcome.failureClass;
    }
    this.notify();
  }

  settleReconnect(
    lease: ConductorReconnectLease,
    succeeded: boolean,
  ): void {
    this.assertActiveLease(lease, 'reconnect');
    this.activeLease = undefined;
    this.agentAvailable = succeeded;
    this.notify();
  }

  setAgentAvailable(available: boolean): void {
    if (this.agentAvailable === available) return;
    this.agentAvailable = available;
    this.notify();
  }

  /** Explicit operator confirmation releases the later-dispatch gate. */
  confirmRecovery(): boolean {
    if (this.activeLease !== undefined || this.attentionAttemptId === undefined) {
      return false;
    }
    this.attentionAttemptId = undefined;
    this.notify();
    return true;
  }

  wake(): void {
    this.notify();
  }

  private assertActiveLease(
    lease: { token: symbol; id: number; kind: 'send' | 'reconnect' },
    kind: 'send' | 'reconnect',
  ): void {
    if (
      this.activeLease?.token !== lease.token ||
      this.activeLease.id !== lease.id ||
      this.activeLease.kind !== kind ||
      lease.kind !== kind
    ) {
      throw new Error(`Cannot settle inactive conductor ${kind} lease.`);
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
