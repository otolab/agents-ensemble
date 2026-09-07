import type { SessionEvent } from './session-event.js';

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

export function createDispatchHoldState(): DispatchHoldState {
  return {
    dispatchHold: false,
    heldEvents: [],
  };
}
