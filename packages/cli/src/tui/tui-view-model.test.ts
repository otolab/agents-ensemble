import { describe, expect, it } from 'vitest';
import { createTuiViewModel } from './tui-view-model.js';
import { INITIAL_SESSION_DISPLAY_STATE } from '../display/session-display-state.js';

describe('createTuiViewModel', () => {
  it('notifies subscribers when display state changes', () => {
    const model = createTuiViewModel();
    let notifications = 0;
    const unsubscribe = model.subscribe(() => {
      notifications += 1;
    });

    model.setDisplayState({
      ...INITIAL_SESSION_DISPLAY_STATE,
      conductorOutput: 'hello',
    });

    expect(notifications).toBe(1);
    expect(model.getSnapshot().displayState.conductorOutput).toBe('hello');
    unsubscribe();
  });

  it('tracks operator lines and post-loop waiting', () => {
    const model = createTuiViewModel();

    model.appendOperatorLine('ping');
    model.setPostLoopWaiting(true);

    const snapshot = model.getSnapshot();
    expect(snapshot.operatorLines).toEqual(['ping']);
    expect(snapshot.postLoopWaiting).toBe(true);
  });
});
