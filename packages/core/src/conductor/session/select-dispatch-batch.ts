import type { SessionEvent } from './session-event.js';
import {
  countWorkerOutcomesInBatchCore,
  createConductorCoreState,
  eventSourceKeyCore,
  stepConductorCore,
  type ConductorCoreDispatchBatchState,
  type SelectDispatchBatchInput,
  type SelectDispatchBatchResult,
} from '../conductor-transition-core.js';
export type {
  DispatchBatch,
  SelectDispatchBatchInput,
  SelectDispatchBatchResult,
} from '../conductor-transition-core.js';

/** dispatch 束の source key（[ADR 0014](../../../docs/adr/0014-conductor-dispatch-batch-coalescing.md)）。 */
export type DispatchSourceKey = string;

export type DispatchBatchState = ConductorCoreDispatchBatchState;

/** セッションイベントの dispatch ソース key を返す。 */
export function eventSourceKey(event: SessionEvent): DispatchSourceKey {
  return eventSourceKeyCore(event);
}

/**
 * キューから次に dispatch するイベント束を選ぶ（純関数）。
 * 選択は `scheduled` 観測として reducer に記録され、send 開始とは区別される。
 */
export function selectDispatchBatch(
  input: SelectDispatchBatchInput,
): SelectDispatchBatchResult | undefined {
  const { queue, state, autonomousTurns, ...scheduleOptions } = input;
  const transition = stepConductorCore(
    createConductorCoreState({
      queue,
      dispatchBatchState: state,
      autonomousTurns,
    }),
    { type: 'dispatch.schedule', input: scheduleOptions },
  );
  return selectedDispatchBatch(transition.effects);
}

export interface SelectConductorDispatchBatchInput
  extends SelectDispatchBatchInput {
  dispatchHold: boolean;
  heldEvents: readonly SessionEvent[];
}

/**
 * Driver scheduling entry point. Queue/held arbitration is reducer-owned;
 * reservation and waiting remain execution-layer concerns.
 */
export function selectConductorDispatchBatch(
  input: SelectConductorDispatchBatchInput,
): SelectDispatchBatchResult | undefined {
  const {
    queue,
    state,
    autonomousTurns,
    dispatchHold,
    heldEvents,
    ...scheduleOptions
  } = input;
  const transition = stepConductorCore(
    createConductorCoreState({
      queue,
      dispatchBatchState: state,
      autonomousTurns,
      dispatchHold,
      heldEvents,
    }),
    { type: 'dispatch.schedule', input: scheduleOptions },
  );
  return selectedDispatchBatch(transition.effects);
}

function selectedDispatchBatch(
  effects: ReturnType<typeof stepConductorCore>['effects'],
): SelectDispatchBatchResult | undefined {
  const selected = effects.find(
    (effect) =>
      effect.kind === 'action' &&
      effect.action.type === 'dispatchSelection',
  );
  if (
    selected?.kind !== 'action' ||
    selected.action.type !== 'dispatchSelection'
  ) {
    return undefined;
  }
  return selected.action.result;
}

/** dispatch 完了後に Driver が呼ぶ。次の 1 回だけ continuation 優先を arm する。 */
export function dispatchBatchStateAfterSend(
  sourceKey: DispatchSourceKey,
): DispatchBatchState {
  return stepConductorCore(createConductorCoreState(), {
    type: 'dispatch.batchSettled',
    sourceKey,
  }).state.dispatchBatchState;
}

/** select で continuation を消費したあとに Driver がマージする。 */
export function markContinuationConsumed(
  state: DispatchBatchState,
  selected: SelectDispatchBatchResult,
): DispatchBatchState {
  return stepConductorCore(
    createConductorCoreState({ dispatchBatchState: state }),
    { type: 'dispatch.continuationConsumed', selected },
  ).state.dispatchBatchState;
}

/** 束に含まれる worker 完了 / 失敗の件数。 */
export function countWorkerOutcomesInBatch(events: SessionEvent[]): {
  workerDispatches: number;
  workerFailures: number;
} {
  return countWorkerOutcomesInBatchCore(events);
}
