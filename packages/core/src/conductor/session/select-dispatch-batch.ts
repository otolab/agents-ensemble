import type { SessionEvent } from './session-event.js';
import { isConductorSendEvent } from './session-event.js';
import { canDispatchConductorSend } from '../session-policy.js';

/** dispatch 束の source key（[ADR 0014](../../../docs/adr/0014-conductor-dispatch-batch-coalescing.md)）。 */
export type DispatchSourceKey = string;

export interface DispatchBatchState {
  /** 直前 dispatch の source。 */
  lastDispatchedSourceKey?: DispatchSourceKey;
  /** `lastDispatchedSourceKey` による 1 回限りの優先を消費済みか。 */
  continuationConsumed?: boolean;
}

export interface DispatchBatch {
  events: SessionEvent[];
  sourceKey: DispatchSourceKey;
}

export interface SelectDispatchBatchInput {
  queue: readonly SessionEvent[];
  state: DispatchBatchState;
  autonomousTurns: number;
  maxTurns: number;
}

export interface SelectDispatchBatchResult {
  batch: DispatchBatch;
  /** 束に含めなかったイベント（到着順を維持）。 */
  remainingQueue: SessionEvent[];
}

const STATIC_SOURCE_PRIORITY: Record<string, number> = {
  permission: 0,
  'worker.failed': 1,
  'worker.completed': 2,
};

/** セッションイベントの dispatch ソース key を返す。 */
export function eventSourceKey(event: SessionEvent): DispatchSourceKey {
  switch (event.type) {
    case 'operator.message':
      return 'operator';
    case 'permission.pending':
      return 'permission';
    case 'worker.completed':
      return `worker:${event.result.name}`;
    case 'worker.failed':
      return `worker:${event.failure.name}`;
    default: {
      const _exhaustive: never = event;
      return String(_exhaustive);
    }
  }
}

function staticEventPriority(event: SessionEvent): number {
  switch (event.type) {
    case 'operator.message':
      return -1;
    case 'permission.pending':
      return STATIC_SOURCE_PRIORITY.permission;
    case 'worker.failed':
      return STATIC_SOURCE_PRIORITY['worker.failed'];
    case 'worker.completed':
      return STATIC_SOURCE_PRIORITY['worker.completed'];
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

function isDispatchable(
  event: SessionEvent,
  autonomousTurns: number,
  maxTurns: number,
): boolean {
  return (
    isConductorSendEvent(event) &&
    canDispatchConductorSend(event, autonomousTurns, maxTurns)
  );
}

function pickStaticSourceKey(
  queue: readonly SessionEvent[],
  eligible: SessionEvent[],
): DispatchSourceKey {
  const keys = new Map<DispatchSourceKey, { priority: number; firstIndex: number }>();

  for (const event of eligible) {
    const key = eventSourceKey(event);
    const firstIndex = queue.indexOf(event);
    const priority = staticEventPriority(event);
    const existing = keys.get(key);
    if (!existing || firstIndex < existing.firstIndex) {
      keys.set(key, { priority, firstIndex });
    }
  }

  let chosenKey: DispatchSourceKey | undefined;
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

  return chosenKey ?? eventSourceKey(eligible[0]!);
}

function isWorkerSourceKey(key: DispatchSourceKey): boolean {
  return key.startsWith('worker:');
}

function canUseWorkerContinuation(
  state: DispatchBatchState,
  eligibleKeys: ReadonlySet<DispatchSourceKey>,
): boolean {
  return (
    state.lastDispatchedSourceKey !== undefined &&
    isWorkerSourceKey(state.lastDispatchedSourceKey) &&
    !state.continuationConsumed &&
    eligibleKeys.has(state.lastDispatchedSourceKey)
  );
}

/**
 * キューから次に dispatch するイベント束を選ぶ（純関数）。
 * dispatch 可能なイベントが無ければ undefined。
 */
export function selectDispatchBatch(
  input: SelectDispatchBatchInput,
): SelectDispatchBatchResult | undefined {
  const { queue, state, autonomousTurns, maxTurns } = input;
  const eligible = queue.filter((event) =>
    isDispatchable(event, autonomousTurns, maxTurns),
  );
  if (eligible.length === 0) {
    return undefined;
  }

  const eligibleKeys = new Set(eligible.map(eventSourceKey));
  let chosenKey: DispatchSourceKey;

  if (eligibleKeys.has('operator')) {
    chosenKey = 'operator';
  } else if (eligibleKeys.has('permission')) {
    chosenKey = 'permission';
  } else if (canUseWorkerContinuation(state, eligibleKeys)) {
    chosenKey = state.lastDispatchedSourceKey!;
  } else {
    chosenKey = pickStaticSourceKey(queue, eligible);
  }

  const batchEvents = queue.filter(
    (event) =>
      isDispatchable(event, autonomousTurns, maxTurns) &&
      eventSourceKey(event) === chosenKey,
  );
  const batchSet = new Set(batchEvents);
  const remainingQueue = queue.filter((event) => !batchSet.has(event));

  return {
    batch: { events: batchEvents, sourceKey: chosenKey },
    remainingQueue,
  };
}

/** dispatch 完了後に Driver が呼ぶ。次の 1 回だけ continuation 優先を arm する。 */
export function dispatchBatchStateAfterSend(
  sourceKey: DispatchSourceKey,
): DispatchBatchState {
  return {
    lastDispatchedSourceKey: sourceKey,
    continuationConsumed: false,
  };
}

/** select で continuation を消費したあとに Driver がマージする。 */
export function markContinuationConsumed(
  state: DispatchBatchState,
  selected: SelectDispatchBatchResult,
): DispatchBatchState {
  if (
    canUseWorkerContinuation(
      state,
      new Set([selected.batch.sourceKey]),
    ) &&
    selected.batch.sourceKey === state.lastDispatchedSourceKey
  ) {
    return { ...state, continuationConsumed: true };
  }
  return state;
}

/** 束に含まれる worker 完了 / 失敗の件数。 */
export function countWorkerOutcomesInBatch(events: SessionEvent[]): {
  workerDispatches: number;
  workerFailures: number;
} {
  let workerDispatches = 0;
  let workerFailures = 0;
  for (const event of events) {
    if (event.type === 'worker.completed') {
      workerDispatches++;
    } else if (event.type === 'worker.failed') {
      workerFailures++;
    }
  }
  return { workerDispatches, workerFailures };
}
