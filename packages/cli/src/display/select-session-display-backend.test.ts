import { describe, expect, it, vi } from 'vitest';
import { selectSessionDisplayBackend } from './select-session-display-backend.js';
import { INITIAL_SESSION_DISPLAY_STATE } from './session-display-state.js';

const EMPTY_STATE = INITIAL_SESSION_DISPLAY_STATE;

describe('selectSessionDisplayBackend', () => {
  it('returns string backend that writes dialogue when interactive', () => {
    const writeStdout = vi.fn();
    const backend = selectSessionDisplayBackend({
      interactive: true,
      writeStdout,
    });

    backend.render(EMPTY_STATE, EMPTY_STATE, {
      type: 'operator.input',
      conductorTurn: 1,
      text: 'hello',
    });

    expect(writeStdout).toHaveBeenCalledWith('\noperator> hello\n');
  });

  it('returns noop backend when non-interactive', () => {
    const writeStdout = vi.fn();
    const backend = selectSessionDisplayBackend({
      interactive: false,
      writeStdout,
    });

    backend.render(EMPTY_STATE, EMPTY_STATE, {
      type: 'operator.input',
      conductorTurn: 1,
      text: 'hello',
    });

    expect(writeStdout).not.toHaveBeenCalled();
  });

  it('passes writeStdout injection to string backend', () => {
    const writeStdout = vi.fn();
    const backend = selectSessionDisplayBackend({
      interactive: true,
      writeStdout,
    });

    backend.render(EMPTY_STATE, EMPTY_STATE, {
      type: 'conductor.send',
      sendCount: 1,
      runId: 'run-1',
      status: 'finished',
      result: 'ok',
      workerDispatches: 0,
      workerFailures: 0,
    });

    expect(writeStdout).toHaveBeenCalledWith('\nconductor> ok\n');
  });
});
