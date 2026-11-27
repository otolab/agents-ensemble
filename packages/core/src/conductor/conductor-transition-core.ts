import type { ConductorRecoveryFailureClass } from './conductor-recovery-inbox.js';
import { CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT } from './conductor-recovery-constants.js';
import type { SessionEvent } from './session/session-event.js';

export type ConductorCoreLease =
  | { readonly kind: 'send'; readonly attemptId: string; readonly id: number }
  | {
      readonly kind: 'reconnect';
      readonly attemptId: string;
      readonly id: number;
    };

export interface ConductorCoreDispatchBatchState {
  readonly lastDispatchedSourceKey?: string;
  readonly continuationConsumed?: boolean;
}

export interface ConductorCoreState {
  readonly lease?: ConductorCoreLease;
  readonly agentAvailable: boolean;
  readonly attentionAttemptId?: string;
  readonly lastFailureClass?: ConductorRecoveryFailureClass;
  readonly issueLoop?: IssueLoopStopInput;
  readonly queue: readonly SessionEvent[];
  readonly shutdownMode?: 'close' | 'exit' | 'signal';
  readonly sendStartedAttemptId?: string;
  readonly dispatchHold: boolean;
  readonly heldEvents: readonly SessionEvent[];
  readonly dispatchBatchState: ConductorCoreDispatchBatchState;
  readonly autonomousTurns: number;
  readonly recoveryConfirmationRequired: boolean;
  readonly operatorCanInspectRecovery: boolean;
  readonly continueAfterIssueLoopStop: boolean;
  readonly workerInboxDrained: boolean;
  readonly postLoopWaiting: boolean;
  /** 非同期 inbox drain 前に得た idle operator message 適格性。 */
  readonly idleOperatorMessageReady?: boolean;
  /** idle stop check 開始時点で queue が空だったか。drain 後の再判定に使う。 */
  readonly idleStopCheckQueueEmpty?: boolean;
  readonly cursorBootstrap: CursorBootstrapProjection;
}

export interface CursorBootstrapProjection {
  readonly backend: 'cursor' | 'other';
  readonly status?: 'unknown' | 'saving' | 'complete' | 'incomplete';
  readonly persistedComplete?: boolean;
  readonly skipInitialSend: boolean;
  readonly completedThisDriver: boolean;
}

export type ConductorCoreObservation =
  | { type: 'accepted'; event: SessionEvent; stored: boolean }
  | {
      type: 'scheduled';
      sourceKey: string;
      events: readonly SessionEvent[];
    }
  | {
      type: 'dispatched';
      attemptId: string;
      sourceKey: string;
      events: readonly SessionEvent[];
    }
  | {
      type: 'send.result';
      attemptId: string;
      completed: boolean;
      failureClass?: ConductorRecoveryFailureClass;
    }
  | { type: 'reconnect.result'; attemptId: string; succeeded: boolean };

export type ConductorCoreAction =
  | { type: 'startSend'; attemptId: string; payload: unknown }
  | { type: 'startReconnect'; attemptId: string }
  | { type: 'dispatchSelection'; result?: SelectDispatchBatchResult }
  | { type: 'dispatchGate'; allowed: boolean }
  | {
      type: 'issueLoopStop';
      shouldStop: boolean;
      stopReason: IssueLoopStopReason;
    }
  | {
      type: 'issueLoopDecision';
      decision: 'stop' | 'continue' | 'drainWorkerInbox';
      stopReason: IssueLoopStopReason;
      notifyIssueLoopStop?: boolean;
      idleOperatorMessageReady?: boolean;
      idleStopCheckQueueEmpty?: boolean;
    }
  | {
      type: 'issueLoopConfirmationGate';
      shouldStop: boolean;
      stopReason?: IssueLoopStopReason;
    }
  | { type: 'idleOperatorMessageGate'; allowed: boolean }
  | {
      type: 'cursorBootstrapDecision';
      needsDecision: boolean;
      pending: boolean;
    }
  | {
      type: 'dispatchHoldChanged';
      status: 'enabled' | 'updated' | 'released';
      hold: boolean;
      heldEventCount: number;
      flushedEventCount?: number;
    }
  | { type: 'turnsUpdated'; autonomousTurns: number };

export type ConductorCoreEffect =
  | { kind: 'action'; action: ConductorCoreAction }
  | { kind: 'observation'; observation: ConductorCoreObservation };

export interface ConductorCoreTransition {
  state: ConductorCoreState;
  effects: readonly ConductorCoreEffect[];
}

export interface DispatchBatch {
  events: SessionEvent[];
  sourceKey: string;
}

export interface SelectDispatchBatchResult {
  batch: DispatchBatch;
  remainingQueue: SessionEvent[];
}

export interface SelectDispatchBatchInput {
  queue: readonly SessionEvent[];
  state: ConductorCoreDispatchBatchState;
  autonomousTurns: number;
  maxTurns: number;
  allowIdleOperatorMessages?: boolean;
  maxOperatorInputBytes?: number;
}

export type DispatchScheduleOptions = Omit<
  SelectDispatchBatchInput,
  'queue' | 'state' | 'autonomousTurns'
>;

export interface IssueLoopStopInput {
  autonomousTurns: number;
  maxTurns: number;
  lastStatus: string;
  dispatchesThisTurn: number;
  runningWorkers?: number;
  pendingPermissions?: number;
  openQuestions?: number;
  continueOnConductorError?: boolean;
  stopOnUnansweredInput?: boolean;
}

export type IssueLoopStopReason =
  | 'completed'
  | 'error'
  | 'cancelled'
  | 'max_turns'
  | 'interrupted';

export type ConductorCoreEvent =
  | { type: 'queue.arrival'; event: SessionEvent; waiterMatched: boolean }
  | { type: 'queue.remove'; events: readonly SessionEvent[] }
  | { type: 'session.shutdown'; mode: 'close' | 'exit' | 'signal' }
  | { type: 'dispatch.schedule'; input: DispatchScheduleOptions }
  | {
      type: 'send.requested';
      attemptId: string;
      id: number;
      payload: unknown;
    }
  | {
      type: 'send.started';
      attemptId: string;
      sourceKey: string;
      events: readonly SessionEvent[];
    }
  | {
      type: 'send.result';
      attemptId: string;
      completed: boolean;
      failureClass?: ConductorRecoveryFailureClass;
      agentAvailable?: boolean;
      requiresConfirmation?: boolean;
    }
  | { type: 'reconnect.requested'; attemptId: string; id: number }
  | { type: 'reconnect.result'; attemptId: string; succeeded: boolean }
  | { type: 'agent.availability'; available: boolean }
  | { type: 'recovery.confirm'; expectedAttemptId?: string }
  | { type: 'dispatchHold.set'; enabled: boolean }
  | { type: 'dispatchHold.buffer'; queue: readonly SessionEvent[] }
  | {
      type: 'permissions.prune';
      queue: readonly SessionEvent[];
      pendingPermissionIds: readonly string[];
    }
  | { type: 'dispatch.continuationConsumed'; selected: SelectDispatchBatchResult }
  | { type: 'dispatch.batchSettled'; sourceKey: string }
  | {
      type: 'dispatch.turnsAfterSend';
      event: SessionEvent;
    }
  | { type: 'dispatch.turnsAfterBatch'; events: readonly SessionEvent[] }
  | {
      type: 'dispatch.canSend';
      event: SessionEvent;
      maxTurns: number;
    }
  | { type: 'dispatch.idleOperatorMessageGate' }
  | { type: 'cursorBootstrap.status'; status?: CursorBootstrapProjection['status'] }
  | { type: 'cursorBootstrap.check' }
  | {
      type: 'cursorBootstrap.dispatchResult';
      status: string;
      bootstrapIncluded: boolean;
    }
  | { type: 'issueLoop.stopCheck' }
  | { type: 'issueLoop.confirmationGate' }
  | {
      type: 'issueLoop.driverStopCheck';
      phase?: 'afterSend' | 'idle';
    };

const EMPTY_EFFECTS: readonly ConductorCoreEffect[] = [];

const STATIC_SOURCE_PRIORITY: Record<string, number> = {
  permission: 0,
  'operator.reconnect': 0,
  'worker.failed': 1,
  'worker.session.recovered': 1,
  'worker.completed': 2,
  github: 3,
  'permission.stall': 4,
  'github.recovered': 5,
  'conductor.recovery.report': 0,
};

export function createConductorCoreState(
  initial: Partial<ConductorCoreState> = {},
): ConductorCoreState {
  return {
    agentAvailable: true,
    queue: [],
    dispatchHold: false,
    heldEvents: [],
    dispatchBatchState: {},
    autonomousTurns: 0,
    recoveryConfirmationRequired: false,
    operatorCanInspectRecovery: false,
    continueAfterIssueLoopStop: false,
    workerInboxDrained: false,
    postLoopWaiting: false,
    cursorBootstrap: {
      backend: 'other',
      skipInitialSend: false,
      completedThisDriver: false,
    },
    ...initial,
  };
}

/**
 * Pure conductor lifecycle and dispatch transition.
 *
 * SessionEvent object references identify items only within the current
 * process. They are not stable or persistent event IDs.
 */
export function stepConductorCore(
  state: ConductorCoreState,
  event: ConductorCoreEvent,
): ConductorCoreTransition {
  switch (event.type) {
    case 'queue.arrival': {
      const queue = event.waiterMatched
        ? state.queue
        : [...state.queue, event.event];
      return {
        state: { ...state, queue },
        effects: [
          observation({
            type: 'accepted',
            event: event.event,
            stored: !event.waiterMatched,
          }),
        ],
      };
    }
    case 'queue.remove': {
      const selected = new Set(event.events);
      const queue = state.queue.filter((item) => !selected.has(item));
      return queue.length === state.queue.length
        ? { state, effects: EMPTY_EFFECTS }
        : { state: { ...state, queue }, effects: EMPTY_EFFECTS };
    }
    case 'session.shutdown': {
      const sendHasNotStarted =
        state.lease?.kind === 'send' &&
        state.sendStartedAttemptId !== state.lease.attemptId;
      return {
        state: {
          ...state,
          shutdownMode: state.shutdownMode ?? event.mode,
          ...(sendHasNotStarted ? { lease: undefined } : {}),
          ...(sendHasNotStarted ? { sendStartedAttemptId: undefined } : {}),
        },
        effects: EMPTY_EFFECTS,
      };
    }
    case 'dispatch.schedule': {
      if (state.shutdownMode !== undefined) {
        return {
          state,
          effects: [action({ type: 'dispatchSelection' })],
        };
      }
      const result = selectDispatchBatchCore({
        queue: state.queue,
        state: state.dispatchBatchState,
        autonomousTurns: state.autonomousTurns,
        ...event.input,
      });
      const effects: ConductorCoreEffect[] = [
        action({ type: 'dispatchSelection', ...(result ? { result } : {}) }),
      ];
      if (result) {
        effects.push(
          observation({
            type: 'scheduled',
            sourceKey: result.batch.sourceKey,
            events: result.batch.events,
          }),
        );
      }
      return { state, effects };
    }
    case 'send.requested': {
      if (!canDispatchConductorCore(state)) {
        return { state, effects: EMPTY_EFFECTS };
      }
      return {
        state: {
          ...state,
          lease: { kind: 'send', attemptId: event.attemptId, id: event.id },
        },
        effects: [
          action({
            type: 'startSend',
            attemptId: event.attemptId,
            payload: event.payload,
          }),
        ],
      };
    }
    case 'send.started': {
      if (
        state.shutdownMode !== undefined ||
        state.lease?.kind !== 'send' ||
        state.lease.attemptId !== event.attemptId
      ) {
        return { state, effects: EMPTY_EFFECTS };
      }
      return {
        state: { ...state, sendStartedAttemptId: event.attemptId },
        effects: [
          observation({
            type: 'dispatched',
            attemptId: event.attemptId,
            sourceKey: event.sourceKey,
            events: event.events,
          }),
        ],
      };
    }
    case 'send.result': {
      if (
        state.lease?.kind !== 'send' ||
        state.lease.attemptId !== event.attemptId
      ) {
        return { state, effects: EMPTY_EFFECTS };
      }
      const nextState: ConductorCoreState = {
        ...state,
        lease: undefined,
        sendStartedAttemptId: undefined,
        ...(event.agentAvailable !== undefined
          ? { agentAvailable: event.agentAvailable }
          : {}),
        attentionAttemptId: event.completed
          ? undefined
          : event.requiresConfirmation === false
            ? state.attentionAttemptId
            : event.attemptId,
        lastFailureClass: event.completed ? undefined : event.failureClass,
      };
      return {
        state: nextState,
        effects: [
          observation({
            type: 'send.result',
            attemptId: event.attemptId,
            completed: event.completed,
            ...(event.failureClass ? { failureClass: event.failureClass } : {}),
          }),
        ],
      };
    }
    case 'reconnect.requested': {
      if (state.shutdownMode !== undefined || state.lease !== undefined) {
        return { state, effects: EMPTY_EFFECTS };
      }
      return {
        state: {
          ...state,
          lease: {
            kind: 'reconnect',
            attemptId: event.attemptId,
            id: event.id,
          },
        },
        effects: [
          action({ type: 'startReconnect', attemptId: event.attemptId }),
        ],
      };
    }
    case 'reconnect.result': {
      if (
        state.lease?.kind !== 'reconnect' ||
        state.lease.attemptId !== event.attemptId
      ) {
        return { state, effects: EMPTY_EFFECTS };
      }
      return {
        state: {
          ...state,
          lease: undefined,
          agentAvailable: event.succeeded,
        },
        effects: [
          observation({
            type: 'reconnect.result',
            attemptId: event.attemptId,
            succeeded: event.succeeded,
          }),
        ],
      };
    }
    case 'agent.availability':
      return event.available === state.agentAvailable
        ? { state, effects: EMPTY_EFFECTS }
        : {
            state: { ...state, agentAvailable: event.available },
            effects: EMPTY_EFFECTS,
          };
    case 'recovery.confirm': {
      if (
        state.lease !== undefined ||
        state.attentionAttemptId === undefined ||
        (event.expectedAttemptId !== undefined &&
          event.expectedAttemptId !== state.attentionAttemptId)
      ) {
        return { state, effects: EMPTY_EFFECTS };
      }
      const nextState = { ...state, attentionAttemptId: undefined };
      return { state: nextState, effects: EMPTY_EFFECTS };
    }
    case 'dispatchHold.set': {
      const status = event.enabled
        ? state.dispatchHold
          ? 'updated'
          : 'enabled'
        : 'released';
      const nextState = { ...state, dispatchHold: event.enabled };
      return {
        state: nextState,
        effects: [
          action({
            type: 'dispatchHoldChanged',
            status,
            hold: event.enabled,
            heldEventCount: state.heldEvents.length,
            ...(!event.enabled
              ? { flushedEventCount: state.heldEvents.length }
              : {}),
          }),
        ],
      };
    }
    case 'dispatchHold.buffer': {
      if (!state.dispatchHold) return { state, effects: EMPTY_EFFECTS };
      const held = event.queue.filter(isHoldableDispatchEvent);
      if (held.length === 0) return { state, effects: EMPTY_EFFECTS };
      const heldSet = new Set(held);
      const queue = event.queue.filter((item) => !heldSet.has(item));
      const heldEvents = [...state.heldEvents, ...held];
      return {
        state: { ...state, queue, heldEvents },
        effects: [
          action({
            type: 'dispatchHoldChanged',
            status: 'updated',
            hold: true,
            heldEventCount: heldEvents.length,
          }),
        ],
      };
    }
    case 'permissions.prune': {
      const pending = new Set(event.pendingPermissionIds);
      const queue = filterActivePermissionEvents(event.queue, pending);
      const heldEvents = filterActivePermissionEvents(state.heldEvents, pending);
      const heldChanged = heldEvents.length !== state.heldEvents.length;
      const nextState =
        queue.length === event.queue.length && !heldChanged
          ? state
          : { ...state, queue, heldEvents };
      return {
        state: nextState,
        effects:
          heldChanged
            ? [
                action({
                  type: 'dispatchHoldChanged',
                  status: 'updated',
                  hold: state.dispatchHold,
                  heldEventCount: heldEvents.length,
                }),
              ]
            : EMPTY_EFFECTS,
      };
    }
    case 'dispatch.continuationConsumed':
      return {
        state: {
          ...state,
          dispatchBatchState: markContinuationConsumedCore(
            state.dispatchBatchState,
            event.selected,
          ),
        },
        effects: EMPTY_EFFECTS,
      };
    case 'dispatch.batchSettled':
      return {
        state: {
          ...state,
          dispatchBatchState: {
            lastDispatchedSourceKey: event.sourceKey,
            continuationConsumed: false,
          },
        },
        effects: EMPTY_EFFECTS,
      };
    case 'dispatch.turnsAfterBatch': {
      const autonomousTurns = autonomousTurnsAfterConductorBatchCore(
        event.events,
        state.autonomousTurns,
      );
      return {
        state: { ...state, autonomousTurns },
        effects: [action({ type: 'turnsUpdated', autonomousTurns })],
      };
    }
    case 'dispatch.turnsAfterSend': {
      const autonomousTurns = autonomousTurnsAfterConductorSendCore(
        event.event,
        state.autonomousTurns,
      );
      return {
        state: { ...state, autonomousTurns },
        effects: [action({ type: 'turnsUpdated', autonomousTurns })],
      };
    }
    case 'dispatch.canSend':
      return {
        state,
        effects: [
          action({
            type: 'dispatchGate',
            allowed: canDispatchConductorSendCore(
              event.event,
              state.autonomousTurns,
              event.maxTurns,
            ),
          }),
        ],
      };
    case 'dispatch.idleOperatorMessageGate': {
      return {
        state,
        effects: [
          action({
            type: 'idleOperatorMessageGate',
            allowed:
              state.shutdownMode === undefined &&
              canDispatchIdleOperatorMessageCore(state),
          }),
        ],
      };
    }
    case 'cursorBootstrap.status':
      return {
        state: {
          ...state,
          cursorBootstrap: {
            ...state.cursorBootstrap,
            status: event.status,
          },
        },
        effects: EMPTY_EFFECTS,
      };
    case 'cursorBootstrap.check': {
      const bootstrap = state.cursorBootstrap;
      const needsDecision =
        (bootstrap.status === 'unknown' || bootstrap.status === 'saving');
      const pending =
        bootstrap.backend === 'cursor' &&
        !bootstrap.completedThisDriver &&
        (bootstrap.status === undefined
          ? bootstrap.persistedComplete === undefined
            ? !bootstrap.skipInitialSend
            : !bootstrap.persistedComplete
          : bootstrap.status === 'incomplete');
      return {
        state,
        effects: [
          action({
            type: 'cursorBootstrapDecision',
            needsDecision,
            pending,
          }),
        ],
      };
    }
    case 'cursorBootstrap.dispatchResult':
      if (
        !event.bootstrapIncluded ||
        state.cursorBootstrap.backend !== 'cursor' ||
        !isConductorDispatchCompletedCore(event.status, 'issue')
      ) {
        return { state, effects: EMPTY_EFFECTS };
      }
      return {
        state: {
          ...state,
          cursorBootstrap: {
            ...state.cursorBootstrap,
            completedThisDriver: true,
          },
        },
        effects: EMPTY_EFFECTS,
      };
    case 'issueLoop.stopCheck': {
      const input = state.issueLoop;
      return {
        state,
        effects: [
          action({
            type: 'issueLoopStop',
            shouldStop: input ? shouldStopIssueLoopCore(input) : false,
            stopReason: input
              ? resolveIssueLoopStopReasonCore(input)
              : 'completed',
          }),
        ],
      };
    }
    case 'issueLoop.confirmationGate': {
      const shouldStop =
        state.recoveryConfirmationRequired &&
        !state.operatorCanInspectRecovery;
      const stopReason =
        state.issueLoop?.lastStatus === 'cancelled' ? 'cancelled' : 'error';
      return {
        state,
        effects: [
          action({
            type: 'issueLoopConfirmationGate',
            shouldStop,
            ...(shouldStop ? { stopReason } : {}),
          }),
        ],
      };
    }
    case 'issueLoop.driverStopCheck': {
      const input = state.issueLoop;
      const phase = event.phase ?? 'afterSend';
      if (!input) {
        return {
          state,
          effects: [
            action({
              type: 'issueLoopDecision',
              decision: 'continue',
              stopReason: 'completed',
            }),
          ],
        };
      }

      let stopReason = resolveIssueLoopStopReasonCore(input);
      const shouldStop = shouldStopIssueLoopCore(input);
      if (state.shutdownMode !== undefined) {
        return {
          state,
          effects: [
            action({
              type: 'issueLoopDecision',
              decision: 'stop',
              stopReason: 'interrupted',
            }),
          ],
        };
      }
      if (
        state.recoveryConfirmationRequired &&
        !state.operatorCanInspectRecovery
      ) {
        stopReason = input.lastStatus === 'cancelled' ? 'cancelled' : 'error';
        return {
          state,
          effects: [
            action({
              type: 'issueLoopDecision',
              decision: 'stop',
              stopReason,
            }),
          ],
        };
      }

      const idleStopCheckQueueEmpty =
        phase === 'idle'
          ? (state.idleStopCheckQueueEmpty ?? (state.queue.length === 0))
          : undefined;
      if (
        phase === 'idle' &&
        (!idleStopCheckQueueEmpty ||
          (input.runningWorkers ?? 0) !== 0 ||
          (state.heldEvents.length > 0 &&
            input.stopOnUnansweredInput !== true))
      ) {
        return {
          state: {
            ...state,
            idleStopCheckQueueEmpty,
            postLoopWaiting: false,
          },
          effects: [
            action({
              type: 'issueLoopDecision',
              decision: 'continue',
              stopReason,
            }),
          ],
        };
      }

      const holdBlocksStop =
        state.heldEvents.length > 0 &&
        input.stopOnUnansweredInput !== true &&
        input.lastStatus !== 'error' &&
        input.lastStatus !== 'send_rejected' &&
        input.lastStatus !== 'cancelled';
      if (holdBlocksStop) {
        return {
          state: { ...state, postLoopWaiting: false },
          effects: [
            action({
              type: 'issueLoopDecision',
              decision: 'continue',
              stopReason,
            }),
          ],
        };
      }
      if (!shouldStop) {
        return {
          state: { ...state, postLoopWaiting: false },
          effects: [
            action({
              type: 'issueLoopDecision',
              decision: 'continue',
              stopReason,
            }),
          ],
        };
      }

      if (
        state.operatorCanInspectRecovery &&
        state.recoveryConfirmationRequired
      ) {
        return {
          state: { ...state, postLoopWaiting: true },
          effects: [
            action({
              type: 'issueLoopDecision',
              decision: 'continue',
              stopReason,
              ...(!state.postLoopWaiting
                ? { notifyIssueLoopStop: true }
                : {}),
            }),
          ],
        };
      }

      const canHavePendingWorkerOutcome =
        input.lastStatus === 'finished' &&
        input.dispatchesThisTurn === 0 &&
        (input.pendingPermissions ?? 0) === 0 &&
        (input.openQuestions ?? 0) === 0;
      if (canHavePendingWorkerOutcome && !state.workerInboxDrained) {
        const idleOperatorMessageReady = hasIdleOperatorMessageReadyCore(
          state,
          input.maxTurns,
        );
        return {
          state: {
            ...state,
            idleOperatorMessageReady,
            ...(idleStopCheckQueueEmpty === undefined
              ? {}
              : { idleStopCheckQueueEmpty }),
          },
          effects: [
            action({
              type: 'issueLoopDecision',
              decision: 'drainWorkerInbox',
              stopReason,
              idleOperatorMessageReady,
              ...(idleStopCheckQueueEmpty === undefined
                ? {}
                : { idleStopCheckQueueEmpty }),
            }),
          ],
        };
      }
      if (
        canHavePendingWorkerOutcome &&
        (hasDispatchableWorkerOutcomeCore(state, input.maxTurns) ||
          (input.runningWorkers ?? 0) !== 0)
      ) {
        return {
          state: { ...state, postLoopWaiting: false },
          effects: [
            action({
              type: 'issueLoopDecision',
              decision: 'continue',
              stopReason,
            }),
          ],
        };
      }
      if (!state.continueAfterIssueLoopStop) {
        const deferForIdleOperatorMessage =
          input.stopOnUnansweredInput !== true &&
          (state.idleOperatorMessageReady ??
            hasIdleOperatorMessageReadyCore(state, input.maxTurns));
        return {
          state,
          effects: [
            action({
              type: 'issueLoopDecision',
              decision: deferForIdleOperatorMessage ? 'continue' : 'stop',
              stopReason,
            }),
          ],
        };
      }

      return {
        state: { ...state, postLoopWaiting: true },
        effects: [
          action({
            type: 'issueLoopDecision',
            decision: 'continue',
            stopReason,
            ...(!state.postLoopWaiting ? { notifyIssueLoopStop: true } : {}),
          }),
        ],
      };
    }
  }
}

export function canDispatchConductorCore(state: ConductorCoreState): boolean {
  return (
    state.shutdownMode === undefined &&
    state.lease === undefined &&
    state.agentAvailable &&
    state.attentionAttemptId === undefined
  );
}

export function dispatchStateFromCore(
  state: ConductorCoreState,
): 'ready' | 'in_flight' | 'reconnecting' | 'unavailable' | 'attention' {
  if (state.lease?.kind === 'send') return 'in_flight';
  if (state.lease?.kind === 'reconnect') return 'reconnecting';
  if (!state.agentAvailable) return 'unavailable';
  if (state.attentionAttemptId !== undefined) return 'attention';
  return 'ready';
}

export function sessionEventDispatchModeCore(
  event: SessionEvent,
): 'telemetry' | 'inform' | 'trigger' {
  if ('dispatchMode' in event && event.dispatchMode) {
    return event.dispatchMode;
  }
  return 'trigger';
}

export function canTriggerConductorDispatchCore(
  mode: 'telemetry' | 'inform' | 'trigger',
): boolean {
  return mode === 'trigger';
}

export function isTriggerSessionEventCore(event: SessionEvent): boolean {
  return canTriggerConductorDispatchCore(sessionEventDispatchModeCore(event));
}

export function eventSourceKeyCore(event: SessionEvent): string {
  switch (event.type) {
    case 'operator.message':
      return 'operator';
    case 'operator.reconnect':
      return 'operator.reconnect';
    case 'permission.pending':
      return 'permission';
    case 'permission.stall':
      return 'permission.stall';
    case 'worker.completed':
      return `worker:${event.result.name}`;
    case 'worker.failed':
      return `worker:${event.failure.name}`;
    case 'worker.session.recovered':
      return `worker:${event.name}`;
    case 'github.update':
      return 'github';
    case 'harness.connectivity.recovered':
      return 'github';
    case 'conductor.recovery.report':
      return 'conductor.recovery.report';
    default: {
      const _exhaustive: never = event;
      return String(_exhaustive);
    }
  }
}

export function dispatchBatchStateAfterSendCore(
  sourceKey: string,
): ConductorCoreDispatchBatchState {
  return {
    lastDispatchedSourceKey: sourceKey,
    continuationConsumed: false,
  };
}

export function autonomousTurnsAfterConductorBatchCore(
  events: readonly SessionEvent[],
  autonomousTurns: number,
): number {
  if (
    events.every(
      (event) =>
        event.type === 'operator.reconnect' ||
        event.type === 'conductor.recovery.report',
    )
  ) {
    return autonomousTurns;
  }
  if (events.some((event) => event.type === 'operator.message')) {
    return 0;
  }
  return autonomousTurns + 1;
}

export function autonomousTurnsAfterConductorSendCore(
  event: SessionEvent,
  autonomousTurns: number,
): number {
  return event.type === 'operator.message' ? 0 : autonomousTurns + 1;
}

export function isMaxTurnsLimitedCore(maxTurns: number): boolean {
  return maxTurns > 0;
}

export function canDispatchConductorSendCore(
  event: SessionEvent,
  autonomousTurns: number,
  maxTurns: number,
): boolean {
  if (
    event.type === 'operator.message' ||
    event.type === 'operator.reconnect' ||
    event.type === 'permission.pending' ||
    event.type === 'permission.stall' ||
    event.type === 'conductor.recovery.report'
  ) {
    return true;
  }
  return !isMaxTurnsLimitedCore(maxTurns) || autonomousTurns < maxTurns;
}

export function shouldStopIssueLoopCore(input: IssueLoopStopInput): boolean {
  if (
    input.lastStatus === 'cancelled' ||
    input.lastStatus === 'send_rejected'
  ) {
    return true;
  }
  if (input.lastStatus === 'error') {
    return !input.continueOnConductorError;
  }
  if (
    input.stopOnUnansweredInput &&
    ((input.pendingPermissions ?? 0) > 0 || (input.openQuestions ?? 0) > 0)
  ) {
    return true;
  }
  if ((input.runningWorkers ?? 0) > 0) return false;
  if ((input.pendingPermissions ?? 0) > 0) return false;
  if ((input.openQuestions ?? 0) > 0) return false;
  if (input.dispatchesThisTurn === 0 && input.lastStatus === 'finished') {
    return true;
  }
  return false;
}

export function resolveIssueLoopStopReasonCore(
  input: IssueLoopStopInput,
): IssueLoopStopReason {
  if (input.lastStatus === 'cancelled') return 'cancelled';
  if (input.lastStatus === 'error' || input.lastStatus === 'send_rejected') {
    return 'error';
  }
  return 'completed';
}

export function isConductorDispatchCompletedCore(
  status: string,
  workflow: 'issue' | 'operator-agent',
): boolean {
  return (
    status === 'finished' ||
    status === 'completed' ||
    (workflow === 'issue' && status === 'running')
  );
}

export function selectDispatchBatchCore(
  input: SelectDispatchBatchInput,
): SelectDispatchBatchResult | undefined {
  const {
    queue,
    state,
    autonomousTurns,
    maxTurns,
    allowIdleOperatorMessages = true,
    maxOperatorInputBytes,
  } = input;
  const eligible = queue.filter((event) =>
    isDispatchable(
      event,
      autonomousTurns,
      maxTurns,
      allowIdleOperatorMessages,
    ),
  );
  if (eligible.length === 0) return undefined;

  const eligibleKeys = new Set(eligible.map(eventSourceKeyCore));
  let chosenKey: string;
  if (eligibleKeys.has('operator')) {
    chosenKey = 'operator';
  } else if (eligibleKeys.has('permission')) {
    chosenKey = 'permission';
  } else if (canUseWorkerContinuationCore(state, eligibleKeys)) {
    chosenKey = state.lastDispatchedSourceKey!;
  } else {
    chosenKey = pickStaticSourceKey(queue, eligible);
  }

  let batchEvents = queue.filter((event) => {
    if (eventSourceKeyCore(event) !== chosenKey) return false;
    if (
      isDispatchable(
        event,
        autonomousTurns,
        maxTurns,
        allowIdleOperatorMessages,
      )
    ) {
      return true;
    }
    return (
      sessionEventDispatchModeCore(event) === 'inform' &&
      canDispatchConductorSendCore(event, autonomousTurns, maxTurns)
    );
  });
  const operatorInputByteLimit =
    maxOperatorInputBytes ?? CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT;
  if (chosenKey === 'operator' && operatorInputByteLimit >= 0) {
    const boundedEvents: SessionEvent[] = [];
    let inputBytes = 0;
    for (const event of batchEvents) {
      if (event.type !== 'operator.message') break;
      const eventBytes = Buffer.byteLength(
        event.operatorInput ?? event.text,
        'utf8',
      );
      if (eventBytes > operatorInputByteLimit) break;
      if (
        boundedEvents.length > 0 &&
        inputBytes + eventBytes > operatorInputByteLimit
      ) {
        break;
      }
      boundedEvents.push(event);
      inputBytes += eventBytes;
    }
    batchEvents = boundedEvents;
  }
  if (batchEvents.length === 0) return undefined;
  const batchSet = new Set(batchEvents);
  return {
    batch: { events: batchEvents, sourceKey: chosenKey },
    remainingQueue: queue.filter((event) => !batchSet.has(event)),
  };
}

export function markContinuationConsumedCore(
  state: ConductorCoreDispatchBatchState,
  selected: SelectDispatchBatchResult,
): ConductorCoreDispatchBatchState {
  if (
    canUseWorkerContinuationCore(
      state,
      new Set([selected.batch.sourceKey]),
    ) &&
    selected.batch.sourceKey === state.lastDispatchedSourceKey
  ) {
    return { ...state, continuationConsumed: true };
  }
  return state;
}

export function countWorkerOutcomesInBatchCore(events: readonly SessionEvent[]): {
  workerDispatches: number;
  workerFailures: number;
} {
  let workerDispatches = 0;
  let workerFailures = 0;
  for (const event of events) {
    if (event.type === 'worker.completed') workerDispatches++;
    else if (event.type === 'worker.failed') workerFailures++;
  }
  return { workerDispatches, workerFailures };
}

function action(
  value: ConductorCoreAction,
): ConductorCoreEffect {
  return { kind: 'action', action: value };
}

function observation(
  value: ConductorCoreObservation,
): ConductorCoreEffect {
  return { kind: 'observation', observation: value };
}

function hasDispatchableWorkerOutcomeCore(
  state: ConductorCoreState,
  maxTurns: number,
): boolean {
  return (
    selectDispatchBatchCore({
      queue: state.queue.filter(
        (event) =>
          event.type === 'worker.completed' || event.type === 'worker.failed',
      ),
      state: state.dispatchBatchState,
      autonomousTurns: state.autonomousTurns,
      maxTurns,
    }) !== undefined
  );
}

function canDispatchIdleOperatorMessageCore(
  state: ConductorCoreState,
): boolean {
  const maxTurns = state.issueLoop?.maxTurns ?? 0;
  if ((state.issueLoop?.runningWorkers ?? 0) > 0) return false;

  const heldWorkReady =
    !state.dispatchHold &&
    state.heldEvents.length > 0 &&
    (state.heldEvents.every((event) =>
      canDispatchConductorSendCore(
        event,
        state.autonomousTurns,
        maxTurns,
      ),
    ) ||
      selectDispatchBatchCore({
        queue: state.heldEvents,
        state: state.dispatchBatchState,
        autonomousTurns: state.autonomousTurns,
        maxTurns,
      }) !== undefined);
  const nonOperatorTriggers = state.queue.filter(
    (event) =>
      event.type !== 'operator.message' &&
      event.type !== 'operator.reconnect',
  );
  return (
    !heldWorkReady &&
    selectDispatchBatchCore({
      queue: nonOperatorTriggers,
      state: state.dispatchBatchState,
      autonomousTurns: state.autonomousTurns,
      maxTurns,
    }) === undefined
  );
}

function hasIdleOperatorMessageReadyCore(
  state: ConductorCoreState,
  maxTurns: number,
): boolean {
  if (!canDispatchIdleOperatorMessageCore(state)) return false;
  return (
    selectDispatchBatchCore({
      queue: state.queue,
      state: state.dispatchBatchState,
      autonomousTurns: state.autonomousTurns,
      maxTurns,
      allowIdleOperatorMessages: true,
    })?.batch.events.some(
      (event) =>
        event.type === 'operator.message' && event.delivery === 'idle',
    ) ?? false
  );
}

function isDispatchable(
  event: SessionEvent,
  autonomousTurns: number,
  maxTurns: number,
  allowIdleOperatorMessages = true,
): boolean {
  return (
    (event.type !== 'operator.message' ||
      event.delivery !== 'idle' ||
      allowIdleOperatorMessages) &&
    isTriggerSessionEventCore(event) &&
    canDispatchConductorSendCore(event, autonomousTurns, maxTurns)
  );
}

function pickStaticSourceKey(
  queue: readonly SessionEvent[],
  eligible: readonly SessionEvent[],
): string {
  const keys = new Map<string, { priority: number; firstIndex: number }>();
  for (const event of eligible) {
    const key = eventSourceKeyCore(event);
    const firstIndex = queue.indexOf(event);
    const priority = staticEventPriority(event);
    const existing = keys.get(key);
    if (!existing) {
      keys.set(key, { priority, firstIndex });
    } else {
      existing.priority = Math.min(existing.priority, priority);
      existing.firstIndex = Math.min(existing.firstIndex, firstIndex);
    }
  }

  let chosenKey: string | undefined;
  let bestPriority = Number.MAX_SAFE_INTEGER;
  let bestIndex = Number.MAX_SAFE_INTEGER;
  for (const [key, meta] of keys) {
    if (
      meta.priority < bestPriority ||
      (meta.priority === bestPriority && meta.firstIndex < bestIndex)
    ) {
      chosenKey = key;
      bestPriority = meta.priority;
      bestIndex = meta.firstIndex;
    }
  }
  return chosenKey ?? eventSourceKeyCore(eligible[0]!);
}

function staticEventPriority(event: SessionEvent): number {
  switch (event.type) {
    case 'operator.message':
      return -1;
    case 'operator.reconnect':
      return STATIC_SOURCE_PRIORITY['operator.reconnect'];
    case 'permission.pending':
      return STATIC_SOURCE_PRIORITY.permission;
    case 'permission.stall':
      return STATIC_SOURCE_PRIORITY['permission.stall'];
    case 'worker.failed':
      return STATIC_SOURCE_PRIORITY['worker.failed'];
    case 'worker.session.recovered':
      return STATIC_SOURCE_PRIORITY['worker.session.recovered'];
    case 'worker.completed':
      return STATIC_SOURCE_PRIORITY['worker.completed'];
    case 'github.update':
      return STATIC_SOURCE_PRIORITY.github;
    case 'harness.connectivity.recovered':
      return STATIC_SOURCE_PRIORITY['github.recovered'];
    case 'conductor.recovery.report':
      return STATIC_SOURCE_PRIORITY['conductor.recovery.report'];
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

function canUseWorkerContinuationCore(
  state: ConductorCoreDispatchBatchState,
  eligibleKeys: ReadonlySet<string>,
): boolean {
  return (
    state.lastDispatchedSourceKey?.startsWith('worker:') === true &&
    !state.continuationConsumed &&
    eligibleKeys.has(state.lastDispatchedSourceKey)
  );
}

function filterActivePermissionEvents(
  events: readonly SessionEvent[],
  pendingPermissionIds: ReadonlySet<string>,
): SessionEvent[] {
  return events.filter(
    (event) =>
      event.type !== 'permission.pending' ||
      pendingPermissionIds.has(event.permission.id),
  );
}

function isHoldableDispatchEvent(event: SessionEvent): boolean {
  return (
    event.type === 'harness.connectivity.recovered' ||
    (isTriggerSessionEventCore(event) &&
      event.type !== 'operator.message' &&
      event.type !== 'operator.reconnect' &&
      event.type !== 'permission.stall')
  );
}
