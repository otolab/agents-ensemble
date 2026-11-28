export type ConductorInboxHoldClass =
  | 'ordinary'
  | 'permissionStall'
  | 'githubConnectivity'
  | 'deliveryUnknown'
  | 'processResume';

export interface ConductorInboxItem {
  readonly id: string;
  readonly payload: unknown;
  readonly holdClass: ConductorInboxHoldClass;
}

export type ConductorInboxBatchStatus =
  | 'selected'
  | 'sizeChecking'
  | 'ready'
  | 'sending'
  | 'deliveryUnknown'
  | 'ackPending'
  | 'retryExhausted'
  | 'sizeBlocked';

export interface ConductorInboxBatch {
  readonly id: string;
  readonly itemIds: readonly string[];
  readonly holdClass: ConductorInboxHoldClass;
  readonly status: ConductorInboxBatchStatus;
  readonly automaticSendInvocations: number;
  readonly restartRecoveryAvailable?: boolean;
  readonly processResumeNotice?: unknown;
  readonly sendAttempt?: {
    readonly attemptId: string;
    readonly reason: 'initial' | 'restartRecovery' | 'operatorResend';
    readonly invoked: boolean;
  };
}

export type ConductorInboxStopGateKind =
  | 'ackPending'
  | 'retryExhausted'
  | 'sizeBlocked';

export interface ConductorInboxStopGate {
  readonly kind: ConductorInboxStopGateKind;
  readonly batchId: string;
}

export interface ConductorInboxCoreState {
  /** Committed items remain here until delivery acknowledgement or discard. */
  readonly pendingItems: readonly ConductorInboxItem[];
  /** Awaiting the inbox application-commit result; these are not accepted yet. */
  readonly pendingAcceptances: readonly ConductorInboxItem[];
  /** Identity tombstones prevent a committed discard from being re-imported. */
  readonly discardedItemIds: readonly string[];
  readonly batches: readonly ConductorInboxBatch[];
  readonly stopGates: readonly ConductorInboxStopGate[];
  readonly pendingDiscard?: {
    readonly batchId: string;
    readonly gateKind: 'retryExhausted' | 'sizeBlocked';
  };
}

export type ConductorInboxCoreAction =
  | { readonly type: 'persistInboxItem'; readonly item: ConductorInboxItem }
  | {
      readonly type: 'preflightInboxBatchSize';
      readonly batchId: string;
      readonly itemIds: readonly string[];
    }
  | {
      readonly type: 'startInboxBatchSend';
      readonly attemptId: string;
      readonly batchId: string;
      readonly itemIds: readonly string[];
      readonly reason: 'initial' | 'restartRecovery' | 'operatorResend';
      readonly processResumeNotice?: unknown;
    }
  | {
      readonly type: 'retryInboxSendBeforeInvocation';
      readonly batchId: string;
      readonly itemIds: readonly string[];
      readonly reason: 'initial' | 'restartRecovery' | 'operatorResend';
    }
  | {
      readonly type: 'persistInboxDeliveryAck';
      readonly batchId: string;
      readonly itemIds: readonly string[];
    }
  | { readonly type: 'retryInboxDeliveryAck'; readonly batchId: string }
  | {
      readonly type: 'persistInboxBatchDiscard';
      readonly batchId: string;
      readonly itemIds: readonly string[];
      readonly gateKind: 'retryExhausted' | 'sizeBlocked';
    }
  | {
      readonly type: 'notifyInboxOperator';
      readonly reason:
        | 'ackPending'
        | 'retryExhausted'
        | 'sizeBlocked'
        | 'discardFailed';
      readonly batchId: string;
    };

export type ConductorInboxCoreObservation =
  | { readonly type: 'inbox.accepted'; readonly item: ConductorInboxItem }
  | {
      readonly type: 'inbox.scheduled';
      readonly batchId: string;
      readonly itemIds: readonly string[];
    }
  | {
      readonly type: 'inbox.dispatched';
      readonly attemptId: string;
      readonly batchId: string;
      readonly itemIds: readonly string[];
    }
  | {
      readonly type: 'inbox.discarded';
      readonly batchId: string;
      readonly itemIds: readonly string[];
    };

export type ConductorInboxCoreEffect =
  | { readonly kind: 'action'; readonly action: ConductorInboxCoreAction }
  | {
      readonly kind: 'observation';
      readonly observation: ConductorInboxCoreObservation;
    };

export interface ConductorInboxCoreTransition {
  readonly state: ConductorInboxCoreState;
  readonly effects: readonly ConductorInboxCoreEffect[];
}

export type ConductorInboxCoreEvent =
  | { readonly type: 'inbox.accept'; readonly item: ConductorInboxItem }
  | {
      readonly type: 'inbox.accept.result';
      readonly itemId: string;
      readonly committed: boolean;
    }
  | {
      readonly type: 'inbox.restore';
      readonly pendingItems: readonly ConductorInboxItem[];
      readonly discardedItemIds?: readonly string[];
      readonly dispatchHold: boolean;
      readonly deliveryUnknownBatches?: readonly {
        readonly id: string;
        readonly itemIds: readonly string[];
        readonly automaticSendInvocations: number;
        readonly processResumeNotice: unknown;
      }[];
      readonly sizeBlockedBatches?: readonly {
        readonly id: string;
        readonly itemIds: readonly string[];
        readonly automaticSendInvocations: number;
        readonly holdClass: ConductorInboxHoldClass;
      }[];
    }
  | {
      readonly type: 'inbox.batch.select';
      readonly batchId: string;
      readonly itemIds: readonly string[];
    }
  | {
      readonly type: 'inbox.batch.start';
      readonly batchId: string;
      readonly attemptId: string;
      readonly reason: 'initial' | 'restartRecovery' | 'operatorResend';
    }
  | {
      readonly type: 'inbox.send.invoked';
      readonly attemptId: string;
    }
  | {
      readonly type: 'inbox.send.preInvocationTransientFailure';
      readonly attemptId: string;
    }
  | {
      readonly type: 'inbox.send.result';
      readonly attemptId: string;
      readonly outcome:
        | 'finished'
        | 'deliveryUnknown'
        | 'operatorResendFailureConfirmed';
    }
  | {
      readonly type: 'inbox.sizePreflight.result';
      readonly batchId: string;
      readonly withinLimit: boolean;
    }
  | {
      readonly type: 'inbox.deliveryAck.result';
      readonly batchId: string;
      readonly committed: boolean;
    }
  | {
      readonly type: 'inbox.batch.discard';
      readonly batchId: string;
      readonly gateKind: 'retryExhausted' | 'sizeBlocked';
    }
  | {
      readonly type: 'inbox.batch.discard.result';
      readonly batchId: string;
      readonly gateKind: 'retryExhausted' | 'sizeBlocked';
      readonly committed: boolean;
    };

const MAX_AUTOMATIC_SEND_INVOCATIONS = 3;
const EMPTY_EFFECTS: readonly ConductorInboxCoreEffect[] = [];

export function createConductorInboxCoreState(
  initial: Partial<ConductorInboxCoreState> = {},
): ConductorInboxCoreState {
  return {
    pendingItems: [],
    pendingAcceptances: [],
    discardedItemIds: [],
    batches: [],
    stopGates: [],
    ...initial,
  };
}

/**
 * Pure projection of ADR 0088's inbox and delivery lifecycle.
 *
 * Persistence, formatting, producer handoff, size calculation, timers, and
 * provider calls are represented only by actions and result events. The
 * process-wide dispatch hold is supplied by the owning conductor state.
 */
export function stepConductorInboxCore(
  state: ConductorInboxCoreState,
  event: ConductorInboxCoreEvent,
  dispatchHold: boolean,
): ConductorInboxCoreTransition {
  switch (event.type) {
    case 'inbox.accept': {
      if (hasItemId(state, event.item.id)) {
        return { state, effects: EMPTY_EFFECTS };
      }
      return {
        state: {
          ...state,
          pendingAcceptances: [...state.pendingAcceptances, event.item],
        },
        effects: [inboxAction({ type: 'persistInboxItem', item: event.item })],
      };
    }
    case 'inbox.accept.result': {
      const item = state.pendingAcceptances.find(
        (candidate) => candidate.id === event.itemId,
      );
      if (!item) return { state, effects: EMPTY_EFFECTS };
      const pendingAcceptances = state.pendingAcceptances.filter(
        (candidate) => candidate.id !== event.itemId,
      );
      if (!event.committed) {
        return {
          state: { ...state, pendingAcceptances },
          effects: EMPTY_EFFECTS,
        };
      }
      return {
        state: {
          ...state,
          pendingAcceptances,
          pendingItems: [...state.pendingItems, item],
        },
        effects: [
          inboxObservation({ type: 'inbox.accepted', item }),
        ],
      };
    }
    case 'inbox.restore': {
      const batches: ConductorInboxBatch[] = [
        ...(event.deliveryUnknownBatches ?? []).map((batch) => ({
          ...batch,
          holdClass: 'deliveryUnknown' as const,
          restartRecoveryAvailable:
            batch.automaticSendInvocations <
            MAX_AUTOMATIC_SEND_INVOCATIONS,
          status:
            batch.automaticSendInvocations >=
            MAX_AUTOMATIC_SEND_INVOCATIONS
              ? ('retryExhausted' as const)
              : ('deliveryUnknown' as const),
        })),
        ...(event.sizeBlockedBatches ?? []).map((batch) => ({
          ...batch,
          status: 'sizeBlocked' as const,
        })),
      ];
      const stopGates = batches.flatMap<ConductorInboxStopGate>((batch) =>
        batch.status === 'retryExhausted'
          ? [{ kind: 'retryExhausted', batchId: batch.id }]
          : batch.status === 'sizeBlocked'
            ? [{ kind: 'sizeBlocked', batchId: batch.id }]
            : [],
      );
      return {
        state: {
          ...state,
          pendingItems: [...event.pendingItems],
          pendingAcceptances: [],
          discardedItemIds: [...(event.discardedItemIds ?? [])],
          batches,
          stopGates,
          pendingDiscard: undefined,
        },
        effects: EMPTY_EFFECTS,
      };
    }
    case 'inbox.batch.select': {
      if (
        state.stopGates.length > 0 ||
        findBatch(state, event.batchId) !== undefined ||
        event.itemIds.length === 0 ||
        new Set(event.itemIds).size !== event.itemIds.length ||
        !event.itemIds.every((id) =>
          state.pendingItems.some((item) => item.id === id),
        ) ||
        event.itemIds.some((id) =>
          state.batches.some((batch) => batch.itemIds.includes(id)),
        ) ||
        (dispatchHold &&
          !event.itemIds.every((id) => {
            const item = state.pendingItems.find(
              (candidate) => candidate.id === id,
            );
            return item !== undefined && isHoldExempt(item.holdClass);
          }))
      ) {
        return { state, effects: EMPTY_EFFECTS };
      }
      const items = event.itemIds.map(
        (id) => state.pendingItems.find((item) => item.id === id)!,
      );
      const batch: ConductorInboxBatch = {
        id: event.batchId,
        itemIds: [...event.itemIds],
        holdClass: holdClassForBatch(items),
        status: 'sizeChecking',
        automaticSendInvocations: 0,
      };
      return {
        state: { ...state, batches: [...state.batches, batch] },
        effects: [
          inboxAction({
            type: 'preflightInboxBatchSize',
            batchId: batch.id,
            itemIds: batch.itemIds,
          }),
          inboxObservation({
            type: 'inbox.scheduled',
            batchId: batch.id,
            itemIds: batch.itemIds,
          }),
        ],
      };
    }
    case 'inbox.batch.start': {
      const batch = findBatch(state, event.batchId);
      if (
        !batch ||
        !canStartBatch(state, batch, event.reason) ||
        batch.sendAttempt !== undefined ||
        (dispatchHold && !isHoldExempt(batch.holdClass))
      ) {
        return { state, effects: EMPTY_EFFECTS };
      }
      const processResumeNotice =
        event.reason === 'restartRecovery'
          ? batch.processResumeNotice
          : undefined;
      const updatedBatch: ConductorInboxBatch = {
        ...batch,
        status: 'sending',
        sendAttempt: {
          attemptId: event.attemptId,
          reason: event.reason,
          invoked: false,
        },
        ...(event.reason === 'restartRecovery'
          ? { restartRecoveryAvailable: false }
          : {}),
      };
      return {
        state: replaceBatch(state, updatedBatch),
        effects: [
          inboxAction({
            type: 'startInboxBatchSend',
            attemptId: event.attemptId,
            batchId: batch.id,
            itemIds: batch.itemIds,
            reason: event.reason,
            ...(processResumeNotice === undefined
              ? {}
              : { processResumeNotice }),
          }),
        ],
      };
    }
    case 'inbox.send.invoked': {
      const batch = state.batches.find(
        (candidate) =>
          candidate.sendAttempt?.attemptId === event.attemptId,
      );
      const active = batch?.sendAttempt;
      if (!batch || !active || active.invoked) {
        return { state, effects: EMPTY_EFFECTS };
      }
      const updatedBatch: ConductorInboxBatch = {
        ...batch,
        ...(active.reason === 'operatorResend'
          ? {}
          : {
              automaticSendInvocations:
                batch.automaticSendInvocations + 1,
            }),
        sendAttempt: { ...active, invoked: true },
      };
      return {
        state: {
          ...state,
          batches: state.batches.map((candidate) =>
            candidate.id === batch.id ? updatedBatch : candidate,
          ),
        },
        effects: [
          inboxObservation({
            type: 'inbox.dispatched',
            attemptId: active.attemptId,
            batchId: updatedBatch.id,
            itemIds: updatedBatch.itemIds,
          }),
        ],
      };
    }
    case 'inbox.send.preInvocationTransientFailure': {
      const batch = state.batches.find(
        (candidate) =>
          candidate.sendAttempt?.attemptId === event.attemptId,
      );
      const attempt = batch?.sendAttempt;
      if (!batch || !attempt || attempt.invoked) {
        return { state, effects: EMPTY_EFFECTS };
      }
      const updated: ConductorInboxBatch = {
        ...batch,
        status:
          attempt.reason === 'initial'
            ? 'ready'
            : attempt.reason === 'restartRecovery'
              ? 'deliveryUnknown'
              : 'retryExhausted',
        sendAttempt: undefined,
        ...(attempt.reason === 'restartRecovery'
          ? { restartRecoveryAvailable: true }
          : {}),
      };
      return {
        state: replaceBatch(state, updated),
        effects: [
          inboxAction({
            type: 'retryInboxSendBeforeInvocation',
            batchId: batch.id,
            itemIds: batch.itemIds,
            reason: attempt.reason,
          }),
        ],
      };
    }
    case 'inbox.send.result': {
      const batch = state.batches.find(
        (candidate) =>
          candidate.sendAttempt?.attemptId === event.attemptId,
      );
      const active = batch?.sendAttempt;
      if (!batch || !active || !active.invoked) {
        return { state, effects: EMPTY_EFFECTS };
      }
      if (
        event.outcome === 'operatorResendFailureConfirmed' &&
        active.reason !== 'operatorResend'
      ) {
        return { state, effects: EMPTY_EFFECTS };
      }
      if (event.outcome === 'finished') {
        const updated = {
          ...batch,
          sendAttempt: undefined,
          status: 'ackPending' as const,
        };
        return {
          state: {
            ...replaceBatch(state, updated),
            stopGates: addStopGate(state.stopGates, {
              kind: 'ackPending',
              batchId: batch.id,
            }),
          },
          effects: [
            inboxAction({
              type: 'persistInboxDeliveryAck',
              batchId: batch.id,
              itemIds: batch.itemIds,
            }),
          ],
        };
      }
      const retryExhausted =
        active.reason === 'operatorResend' ||
        event.outcome === 'operatorResendFailureConfirmed' ||
        batch.automaticSendInvocations >=
          MAX_AUTOMATIC_SEND_INVOCATIONS;
      const updated = {
        ...batch,
        sendAttempt: undefined,
        status: retryExhausted
          ? ('retryExhausted' as const)
          : ('deliveryUnknown' as const),
      };
      return {
        state: {
          ...replaceBatch(state, updated),
          stopGates: retryExhausted
            ? addStopGate(state.stopGates, {
                kind: 'retryExhausted',
                batchId: batch.id,
              })
            : state.stopGates,
        },
        effects: retryExhausted
          ? [
              inboxAction({
                type: 'notifyInboxOperator',
                reason: 'retryExhausted',
                batchId: batch.id,
              }),
            ]
          : EMPTY_EFFECTS,
      };
    }
    case 'inbox.sizePreflight.result': {
      const batch = findBatch(state, event.batchId);
      if (!batch || batch.status !== 'sizeChecking') {
        return { state, effects: EMPTY_EFFECTS };
      }
      if (event.withinLimit) {
        return {
          state: replaceBatch(state, { ...batch, status: 'ready' }),
          effects: EMPTY_EFFECTS,
        };
      }
      const updated = { ...batch, status: 'sizeBlocked' as const };
      return {
        state: {
          ...replaceBatch(state, updated),
          stopGates: addStopGate(state.stopGates, {
            kind: 'sizeBlocked',
            batchId: batch.id,
          }),
        },
        effects: [
          inboxAction({
            type: 'notifyInboxOperator',
            reason: 'sizeBlocked',
            batchId: batch.id,
          }),
        ],
      };
    }
    case 'inbox.deliveryAck.result': {
      const batch = findBatch(state, event.batchId);
      if (!batch || batch.status !== 'ackPending') {
        return { state, effects: EMPTY_EFFECTS };
      }
      if (!event.committed) {
        return {
          state,
          effects: [
            inboxAction({
              type: 'retryInboxDeliveryAck',
              batchId: batch.id,
            }),
            inboxAction({
              type: 'notifyInboxOperator',
              reason: 'ackPending',
              batchId: batch.id,
            }),
          ],
        };
      }
      return {
        state: {
          ...removeBatchAndItems(state, batch),
          stopGates: state.stopGates.filter(
            (gate) =>
              gate.batchId !== batch.id ||
              (gate.kind !== 'ackPending' &&
                gate.kind !== 'retryExhausted'),
          ),
        },
        effects: EMPTY_EFFECTS,
      };
    }
    case 'inbox.batch.discard': {
      const batch = findBatch(state, event.batchId);
      const gate = state.stopGates.find(
        (candidate) =>
          candidate.kind === event.gateKind &&
          candidate.batchId === event.batchId,
      );
      if (
        !batch ||
        !gate ||
        (batch.status !== 'retryExhausted' &&
          batch.status !== 'sizeBlocked') ||
        state.pendingDiscard !== undefined
      ) {
        return { state, effects: EMPTY_EFFECTS };
      }
      return {
        state: {
          ...state,
          pendingDiscard: {
            batchId: batch.id,
            gateKind: event.gateKind,
          },
        },
        effects: [
          inboxAction({
            type: 'persistInboxBatchDiscard',
            batchId: batch.id,
            itemIds: batch.itemIds,
            gateKind: event.gateKind,
          }),
        ],
      };
    }
    case 'inbox.batch.discard.result': {
      const pending = state.pendingDiscard;
      const batch = findBatch(state, event.batchId);
      if (
        !pending ||
        pending.batchId !== event.batchId ||
        pending.gateKind !== event.gateKind ||
        !batch
      ) {
        return { state, effects: EMPTY_EFFECTS };
      }
      if (!event.committed) {
        return {
          state: { ...state, pendingDiscard: undefined },
          effects: [
            inboxAction({
              type: 'notifyInboxOperator',
              reason: 'discardFailed',
              batchId: batch.id,
            }),
          ],
        };
      }
      return {
        state: {
          ...removeBatchAndItems(state, batch),
          discardedItemIds: [
            ...new Set([...state.discardedItemIds, ...batch.itemIds]),
          ],
          pendingDiscard: undefined,
          stopGates: removeStopGate(
            state.stopGates,
            event.gateKind,
            batch.id,
          ),
        },
        effects: [
          inboxObservation({
            type: 'inbox.discarded',
            batchId: batch.id,
            itemIds: batch.itemIds,
          }),
        ],
      };
    }
  }
}

function isHoldExempt(holdClass: ConductorInboxHoldClass): boolean {
  return holdClass !== 'ordinary';
}

function holdClassForBatch(
  items: readonly ConductorInboxItem[],
): ConductorInboxHoldClass {
  if (items.some((item) => !isHoldExempt(item.holdClass))) {
    return 'ordinary';
  }
  for (const holdClass of [
    'deliveryUnknown',
    'processResume',
    'githubConnectivity',
    'permissionStall',
  ] as const) {
    if (items.some((item) => item.holdClass === holdClass)) return holdClass;
  }
  return 'ordinary';
}

function canStartBatch(
  state: ConductorInboxCoreState,
  batch: ConductorInboxBatch,
  reason: 'initial' | 'restartRecovery' | 'operatorResend',
): boolean {
  if (reason === 'operatorResend') {
    return (
      batch.status === 'retryExhausted' &&
      state.stopGates.some(
        (gate) =>
          gate.kind === 'retryExhausted' && gate.batchId === batch.id,
      ) &&
      state.stopGates.every(
        (gate) =>
          gate.kind === 'retryExhausted' && gate.batchId === batch.id,
      )
    );
  }
  if (state.stopGates.length > 0) return false;
  return reason === 'initial'
    ? batch.status === 'ready'
    : batch.status === 'deliveryUnknown' &&
        batch.restartRecoveryAvailable === true;
}

function hasItemId(state: ConductorInboxCoreState, id: string): boolean {
  return (
    state.pendingItems.some((item) => item.id === id) ||
    state.pendingAcceptances.some((item) => item.id === id) ||
    state.discardedItemIds.includes(id) ||
    state.batches.some((batch) => batch.itemIds.includes(id))
  );
}

function findBatch(
  state: ConductorInboxCoreState,
  batchId: string,
): ConductorInboxBatch | undefined {
  return state.batches.find((batch) => batch.id === batchId);
}

function replaceBatch(
  state: ConductorInboxCoreState,
  batch: ConductorInboxBatch,
): ConductorInboxCoreState {
  return {
    ...state,
    batches: state.batches.map((candidate) =>
      candidate.id === batch.id ? batch : candidate,
    ),
  };
}

function removeBatchAndItems(
  state: ConductorInboxCoreState,
  batch: ConductorInboxBatch,
): ConductorInboxCoreState {
  const itemIds = new Set(batch.itemIds);
  return {
    ...state,
    batches: state.batches.filter((candidate) => candidate.id !== batch.id),
    pendingItems: state.pendingItems.filter((item) => !itemIds.has(item.id)),
  };
}

function addStopGate(
  gates: readonly ConductorInboxStopGate[],
  gate: ConductorInboxStopGate,
): ConductorInboxStopGate[] {
  return gates.some(
    (candidate) =>
      candidate.kind === gate.kind && candidate.batchId === gate.batchId,
  )
    ? [...gates]
    : [...gates, gate];
}

function removeStopGate(
  gates: readonly ConductorInboxStopGate[],
  kind: ConductorInboxStopGateKind,
  batchId: string,
): ConductorInboxStopGate[] {
  return gates.filter(
    (gate) => gate.kind !== kind || gate.batchId !== batchId,
  );
}

function inboxAction(
  action: ConductorInboxCoreAction,
): ConductorInboxCoreEffect {
  return { kind: 'action', action };
}

function inboxObservation(
  observation: ConductorInboxCoreObservation,
): ConductorInboxCoreEffect {
  return { kind: 'observation', observation };
}
