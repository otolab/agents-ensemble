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
import {
  canDispatchConductorCore,
  createConductorCoreState,
  dispatchStateFromCore,
  isConductorDispatchCompletedCore,
  stepConductorCore,
  type ConductorCoreState,
} from './conductor-transition-core.js';

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
  const completed = isConductorDispatchCompletedCore(
    input.result.status,
    input.workflow,
  );
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
  private coreState: ConductorCoreState = createConductorCoreState();
  private activeToken: symbol | undefined;
  private readonly listeners = new Set<() => void>();

  get state(): ConductorDispatchState {
    return dispatchStateFromCore(this.coreState);
  }

  get available(): boolean {
    return this.coreState.agentAvailable;
  }

  get confirmationRequired(): boolean {
    return this.coreState.attentionAttemptId !== undefined;
  }

  get pendingAttemptId(): string | undefined {
    return this.coreState.attentionAttemptId;
  }

  get lastFailure(): ConductorRecoveryFailureClass | undefined {
    return this.coreState.lastFailureClass;
  }

  get canDispatch(): boolean {
    return canDispatchConductorCore(this.coreState);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginSend(payload: T): ConductorDispatchLease<T> | undefined {
    if (!this.canDispatch) return undefined;
    const id = this.sequence + 1;
    const attemptId = String(id);
    const token = Symbol(`conductor-send-${id}`);
    const transition = stepConductorCore(this.coreState, {
      type: 'send.requested',
      attemptId,
      id,
      payload,
    });
    if (
      !transition.effects.some(
        (effect) =>
          effect.kind === 'action' &&
          effect.action.type === 'startSend' &&
          effect.action.attemptId === attemptId,
      )
    ) {
      return undefined;
    }
    this.sequence = id;
    this.coreState = transition.state;
    this.activeToken = token;
    this.notify();
    return {
      id,
      attemptId,
      kind: 'send',
      payload,
      token,
    };
  }

  beginReconnect(): ConductorReconnectLease | undefined {
    if (this.coreState.lease !== undefined) return undefined;
    const id = this.sequence + 1;
    const attemptId = String(id);
    const token = Symbol(`conductor-reconnect-${id}`);
    const transition = stepConductorCore(this.coreState, {
      type: 'reconnect.requested',
      attemptId,
      id,
    });
    if (
      !transition.effects.some(
        (effect) =>
          effect.kind === 'action' &&
          effect.action.type === 'startReconnect' &&
          effect.action.attemptId === attemptId,
      )
    ) {
      return undefined;
    }
    this.sequence = id;
    this.coreState = transition.state;
    this.activeToken = token;
    this.notify();
    return { id, attemptId, kind: 'reconnect', token };
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
    this.applyCoreEvent({
      type: 'send.result',
      attemptId: lease.attemptId,
      completed: outcome.completed,
      ...(outcome.failureClass
        ? { failureClass: outcome.failureClass }
        : {}),
      ...(outcome.agentAvailable !== undefined
        ? { agentAvailable: outcome.agentAvailable }
        : {}),
      ...(outcome.requiresConfirmation !== undefined
        ? { requiresConfirmation: outcome.requiresConfirmation }
        : {}),
    });
    this.activeToken = undefined;
    this.notify();
  }

  settleReconnect(
    lease: ConductorReconnectLease,
    succeeded: boolean,
  ): void {
    this.assertActiveLease(lease, 'reconnect');
    this.applyCoreEvent({
      type: 'reconnect.result',
      attemptId: lease.attemptId,
      succeeded,
    });
    this.activeToken = undefined;
    this.notify();
  }

  setAgentAvailable(available: boolean): void {
    const previousState = this.coreState;
    this.applyCoreEvent({ type: 'agent.availability', available });
    if (this.coreState === previousState) return;
    this.notify();
  }

  /** Explicit operator confirmation releases the later-dispatch gate. */
  confirmRecovery(expectedAttemptId?: string): boolean {
    const previousState = this.coreState;
    this.applyCoreEvent({
      type: 'recovery.confirm',
      ...(expectedAttemptId !== undefined ? { expectedAttemptId } : {}),
    });
    if (this.coreState === previousState) return false;
    this.notify();
    return true;
  }

  wake(): void {
    this.notify();
  }

  private assertActiveLease(
    lease: {
      token: symbol;
      id: number;
      attemptId: string;
      kind: 'send' | 'reconnect';
    },
    kind: 'send' | 'reconnect',
  ): void {
    const activeLease = this.coreState.lease;
    if (
      this.activeToken !== lease.token ||
      activeLease === undefined ||
      activeLease.id !== lease.id ||
      activeLease.attemptId !== lease.attemptId ||
      activeLease.kind !== kind ||
      lease.kind !== kind
    ) {
      throw new Error(`Cannot settle inactive conductor ${kind} lease.`);
    }
  }

  private applyCoreEvent(
    event: Parameters<typeof stepConductorCore>[1],
  ): void {
    this.coreState = stepConductorCore(this.coreState, event).state;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
