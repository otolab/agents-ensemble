export type StreamScrollbackEventSource = 'keyboard' | 'adapter';

/**
 * Events which change the stream scrollback follow state.
 *
 * A terminal adapter can emit the same `detached` event as the keyboard path
 * without owning the pending activity log or the flush behavior.
 */
export type StreamScrollbackEvent =
  | { type: 'detached'; source: StreamScrollbackEventSource }
  | { type: 'follow'; source: StreamScrollbackEventSource };

export interface StreamScrollbackState {
  detached: boolean;
  /** Number of activity entries already committed to Ink Static. */
  committedActivityCount: number;
}

function normalizeActivityCount(activityCount: number): number {
  return Math.max(0, Math.floor(activityCount));
}

export function createStreamScrollbackState(
  activityCount: number,
): StreamScrollbackState {
  return {
    detached: false,
    committedActivityCount: normalizeActivityCount(activityCount),
  };
}

/**
 * Reduce a detached/follow event against the current activity count.
 *
 * The activity count is supplied by the stream view so an adapter only needs
 * to report the viewport transition. Pending entries remain outside this
 * state machine and are represented by the uncommitted suffix of the log.
 */
export function reduceStreamScrollback(
  state: StreamScrollbackState,
  event: StreamScrollbackEvent,
  activityCount: number,
): StreamScrollbackState {
  const nextActivityCount = normalizeActivityCount(activityCount);

  switch (event.type) {
    case 'detached':
      if (state.detached) {
        return state;
      }
      return {
        detached: true,
        committedActivityCount: nextActivityCount,
      };
    case 'follow':
      return {
        detached: false,
        committedActivityCount: nextActivityCount,
      };
  }
}
