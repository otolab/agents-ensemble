import type { SessionEvent } from './session-event.js';
import { isTriggerSessionEvent } from './dispatch-mode.js';
import type { SessionEventQueue } from './session-event-queue.js';

/** Driver 内だけで生存する dispatch 保留状態。sidecar には保存しない。 */
export interface DispatchHoldState {
  dispatchHold: boolean;
  /** 保留中の trigger SessionEvent。到着順を維持する。 */
  heldEvents: SessionEvent[];
}

export type DispatchHoldChangeStatus = 'enabled' | 'updated' | 'released';

export interface DispatchHoldChange {
  status: DispatchHoldChangeStatus;
  hold: boolean;
  heldEventCount: number;
  flushedEventCount?: number;
}

export interface BufferDispatchHoldEventsOptions {
  state: DispatchHoldState;
  eventQueue: SessionEventQueue;
  onChanged?: (change: DispatchHoldChange) => void;
}

export function createDispatchHoldState(): DispatchHoldState {
  return {
    dispatchHold: false,
    heldEvents: [],
  };
}

/**
 * hold 中に queue へ到着した trigger を、同じ同期区間で held buffer へ移す。
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

function isHoldableDispatchEvent(event: SessionEvent): boolean {
  return (
    isTriggerSessionEvent(event) &&
    event.type !== 'operator.message' &&
    event.type !== 'permission.pending'
  );
}
