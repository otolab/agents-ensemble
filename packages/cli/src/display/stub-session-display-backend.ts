import type { SessionLogEvent } from '@agents-ensemble/core';
import type { SessionDisplayBackend } from './session-display-backend.js';
import type { SessionDisplayState } from './session-display-state.js';
import { INITIAL_SESSION_DISPLAY_STATE } from './session-display-state.js';

export interface StubSessionDisplayBackend {
  backend: SessionDisplayBackend;
  getState(): SessionDisplayState;
  getRenders(): Array<{
    state: SessionDisplayState;
    previousState: SessionDisplayState;
    event: SessionLogEvent;
  }>;
}

/** テスト用: `render` 呼び出しと最終 state を記録する。 */
export function createStubSessionDisplayBackend(): StubSessionDisplayBackend {
  let state = INITIAL_SESSION_DISPLAY_STATE;
  const renders: StubSessionDisplayBackend['getRenders'] extends () => infer R
    ? R
    : never = [];

  return {
    backend: {
      render(nextState, previousState, event) {
        renders.push({ state: nextState, previousState, event });
        state = nextState;
      },
    },
    getState: () => state,
    getRenders: () => [...renders],
  };
}
