import type { SessionEvent } from './session-event.js';
import type { SessionEventQueue } from './session-event-queue.js';
import {
  createConductorCoreState,
  stepConductorCore,
} from '../conductor-transition-core.js';

/** Driver 内だけで生存する dispatch 保留状態。SessionResumeStore には保存しない。 */
export interface DispatchHoldState {
  dispatchHold: boolean;
  /** 保留中の trigger と、それに同梱する接続復旧 inform（operator 入力を除く）。到着順を維持する。 */
  heldEvents: SessionEvent[];
}

export type DispatchHoldChangeStatus = 'enabled' | 'updated' | 'released';

export interface DispatchHoldChange {
  status: DispatchHoldChangeStatus;
  hold: boolean;
  /** held buffer に積まれた trigger の件数（permission.pending は含み、permission.stall は含まない）。 */
  heldEventCount: number;
  flushedEventCount?: number;
}

export interface BufferDispatchHoldEventsOptions {
  state: DispatchHoldState;
  eventQueue: SessionEventQueue;
  onChanged?: (change: DispatchHoldChange) => void;
}

export interface PruneStalePermissionEventsOptions {
  state: DispatchHoldState;
  eventQueue: SessionEventQueue;
  /** PermissionPipeline.pending を authoritative source として参照する。 */
  isPermissionPending: (requestId: string) => boolean;
  onChanged?: (change: DispatchHoldChange) => void;
}

export function createDispatchHoldState(): DispatchHoldState {
  return {
    dispatchHold: false,
    heldEvents: [],
  };
}

/**
 * hold 中に queue へ到着した hold 対象 trigger を、同じ同期区間で held buffer へ移す。
 * release tool からも呼び出すため、OFF の件数確定前に queue を回収できる。
 */
export function bufferDispatchHoldEvents(
  options: BufferDispatchHoldEventsOptions,
): number {
  const queue = options.eventQueue.snapshot();
  const transition = stepConductorCore(
    createConductorCoreState({
      dispatchHold: options.state.dispatchHold,
      heldEvents: options.state.heldEvents,
      queue,
    }),
    { type: 'dispatchHold.buffer', queue },
  );
  const heldEventCount =
    transition.state.heldEvents.length - options.state.heldEvents.length;
  if (heldEventCount === 0) return 0;

  options.state.heldEvents.push(
    ...transition.state.heldEvents.slice(options.state.heldEvents.length),
  );
  options.eventQueue.replaceQueue([...transition.state.queue]);
  const changed = transition.effects.find(
    (effect) =>
      effect.kind === 'action' &&
      effect.action.type === 'dispatchHoldChanged',
  );
  if (
    changed?.kind === 'action' &&
    changed.action.type === 'dispatchHoldChanged'
  ) {
    options.onChanged?.({
      status: changed.action.status,
      hold: changed.action.hold,
      heldEventCount: changed.action.heldEventCount,
      ...(changed.action.flushedEventCount !== undefined
        ? { flushedEventCount: changed.action.flushedEventCount }
        : {}),
    });
  }
  return heldEventCount;
}

/**
 * cleanup 済みの permission.pending を dispatch 前に queue / held buffer から除去する。
 *
 * PermissionPipeline.pending を owner として参照する処理は adapter に残し、
 * reducer には生存している request ID の投影だけを渡す。
 */
export function pruneStalePermissionEvents(
  options: PruneStalePermissionEventsOptions,
): number {
  const queue = options.eventQueue.snapshot();
  const candidateEvents = [...queue, ...options.state.heldEvents];
  const pendingPermissionIds = [
    ...new Set(
      candidateEvents.flatMap((event) =>
        event.type === 'permission.pending' &&
        options.isPermissionPending(event.permission.id)
          ? [event.permission.id]
          : [],
      ),
    ),
  ];
  const transition = stepConductorCore(
    createConductorCoreState({
      dispatchHold: options.state.dispatchHold,
      heldEvents: options.state.heldEvents,
      queue,
    }),
    { type: 'permissions.prune', queue, pendingPermissionIds },
  );
  const removedFromQueue = queue.length - transition.state.queue.length;
  const removedFromHeld =
    options.state.heldEvents.length - transition.state.heldEvents.length;
  if (removedFromQueue > 0) {
    options.eventQueue.replaceQueue([...transition.state.queue]);
  }
  if (removedFromHeld > 0) {
    options.state.heldEvents = [...transition.state.heldEvents];
  }
  if (removedFromHeld > 0) {
    const changed = transition.effects.find(
      (effect) =>
        effect.kind === 'action' &&
        effect.action.type === 'dispatchHoldChanged',
    );
    if (
      changed?.kind === 'action' &&
      changed.action.type === 'dispatchHoldChanged'
    ) {
      options.onChanged?.({
        status: changed.action.status,
        hold: changed.action.hold,
        heldEventCount: changed.action.heldEventCount,
      });
    }
  }
  return removedFromQueue + removedFromHeld;
}
