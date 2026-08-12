import type { SessionLogEvent, SessionLogSink } from '@agents-ensemble/core';
import { reduceDisplayState } from './session-display-reducer.js';
import type { SessionDisplayBackend } from './session-display-backend.js';
import { INITIAL_SESSION_DISPLAY_STATE } from './session-display-state.js';

export interface CreateSessionDisplaySinkOptions {
  backend: SessionDisplayBackend;
  onOpenQuestionEnqueued?: () => void;
}

function shouldRender(event: SessionLogEvent): boolean {
  return (
    event.type === 'operator.input' ||
    event.type === 'conductor.send' ||
    event.type === 'harness.worker.bootstrap.started' ||
    event.type === 'harness.worker.bootstrap.completed' ||
    event.type === 'harness.worker.bootstrap.failed' ||
    event.type === 'worker.round' ||
    event.type === 'worker.failed' ||
    event.type === 'open.question.enqueued' ||
    event.type === 'escalation.recorded'
  );
}

/** `SessionLogEvent` → reducer → `SessionDisplayBackend` の表示 sink。 */
export function createSessionDisplaySink(
  options: CreateSessionDisplaySinkOptions,
): SessionLogSink {
  let state = INITIAL_SESSION_DISPLAY_STATE;

  return (event) => {
    const previousState = state;
    const nextState = reduceDisplayState(state, event);
    const stateChanged = nextState !== previousState;
    state = nextState;

    if (stateChanged || shouldRender(event)) {
      options.backend.render(state, previousState, event);
    }

    if (event.type === 'open.question.enqueued') {
      options.onOpenQuestionEnqueued?.();
    }
  };
}
