import type { SessionEvent } from './session-event.js';
import { isTriggerSessionEvent } from './dispatch-mode.js';
import type { SessionEventQueue } from './session-event-queue.js';

/** Driver 内だけで生存する dispatch 保留状態。sidecar には保存しない。 */
export interface DispatchHoldState {
  dispatchHold: boolean;
  /** 保留中の trigger SessionEvent（operator.message / operator.reconnect を除く）。到着順を維持する。 */
  heldEvents: SessionEvent[];
}

export type DispatchHoldChangeStatus = 'enabled' | 'updated' | 'released';

export interface DispatchHoldChange {
  status: DispatchHoldChangeStatus;
  hold: boolean;
  /** held buffer に積まれた trigger の全件数（permission.pending を含む）。 */
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
  if (!options.state.dispatchHold) {
    return 0;
  }

  const queue = options.eventQueue.snapshot();
  const held = queue.filter(isHoldableDispatchEvent);
  if (held.length === 0) {
    return 0;
  }

  const heldSet = new Set(held);
  options.state.heldEvents.push(...held);
  options.eventQueue.replaceQueue(queue.filter((event) => !heldSet.has(event)));
  options.onChanged?.({
    status: 'updated',
    hold: true,
    heldEventCount: options.state.heldEvents.length,
  });
  return held.length;
}

/**
 * cleanup 済みの permission.pending を dispatch 前に queue / held buffer から除去する。
 *
 * SessionEvent は enqueue 後に取り消せないため、PermissionPipeline.pending を
 * authoritative source として毎回確認する。live な permission はそのまま残す。
 */
export function pruneStalePermissionEvents(
  options: PruneStalePermissionEventsOptions,
): number {
  const queue = options.eventQueue.snapshot();
  const activeQueue = filterActivePermissionEvents(
    queue,
    options.isPermissionPending,
  );
  const removedFromQueue = queue.length - activeQueue.length;
  if (removedFromQueue > 0) {
    options.eventQueue.replaceQueue(activeQueue);
  }

  const held = options.state.heldEvents;
  const activeHeld = filterActivePermissionEvents(
    held,
    options.isPermissionPending,
  );
  const removedFromHeld = held.length - activeHeld.length;
  if (removedFromHeld > 0) {
    options.state.heldEvents = activeHeld;
    options.onChanged?.({
      status: 'updated',
      hold: options.state.dispatchHold,
      heldEventCount: activeHeld.length,
    });
  }

  return removedFromQueue + removedFromHeld;
}

function filterActivePermissionEvents(
  events: readonly SessionEvent[],
  isPermissionPending: (requestId: string) => boolean,
): SessionEvent[] {
  return events.filter(
    (event) =>
      event.type !== 'permission.pending' ||
      isPermissionPending(event.permission.id),
  );
}

function isHoldableDispatchEvent(event: SessionEvent): boolean {
  return (
    isTriggerSessionEvent(event) &&
    event.type !== 'operator.message' &&
    event.type !== 'operator.reconnect'
  );
}
