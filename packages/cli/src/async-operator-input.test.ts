import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeRl, mockCreateInterface } = vi.hoisted(() => {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const fakeRl = {
    setPrompt: vi.fn(),
    prompt: vi.fn(),
    close: vi.fn(),
    on(event: string, cb: (...args: unknown[]) => void) {
      listeners[event] ??= [];
      listeners[event].push(cb);
      return fakeRl;
    },
    off(event: string, cb: (...args: unknown[]) => void) {
      listeners[event] = (listeners[event] ?? []).filter((fn) => fn !== cb);
      return fakeRl;
    },
    emit(event: string, ...args: unknown[]) {
      for (const cb of listeners[event] ?? []) {
        cb(...args);
      }
      return true;
    },
    removeAllListeners() {
      for (const key of Object.keys(listeners)) {
        delete listeners[key];
      }
    },
  };

  return {
    fakeRl,
    mockCreateInterface: vi.fn(() => fakeRl),
  };
});

vi.mock('node:readline/promises', () => ({
  createInterface: mockCreateInterface,
}));

import { bindAsyncOperatorInput } from './async-operator-input.js';

describe('bindAsyncOperatorInput', () => {
  beforeEach(() => {
    mockCreateInterface.mockClear();
    fakeRl.setPrompt.mockClear();
    fakeRl.prompt.mockClear();
    fakeRl.close.mockClear();
    fakeRl.removeAllListeners();
  });

  afterEach(() => {
    const previous = process.env.ENSEMBLE_OPERATOR_MESSAGE;
    delete process.env.ENSEMBLE_OPERATOR_MESSAGE;
    if (previous !== undefined) {
      process.env.ENSEMBLE_OPERATOR_MESSAGE = previous;
    }
  });

  it('submits ENSEMBLE_OPERATOR_MESSAGE once without readline', () => {
    const submit = vi.fn(() => true);
    const previous = process.env.ENSEMBLE_OPERATOR_MESSAGE;
    process.env.ENSEMBLE_OPERATOR_MESSAGE = 'hello from env';

    const dispose = bindAsyncOperatorInput({
      submit,
      getContext: () => ({
        conductorTurn: 1,
        autonomousTurns: 0,
        maxTurns: 5,
        openQuestions: [],
      }),
    });

    expect(submit).toHaveBeenCalledWith('hello from env');
    expect(mockCreateInterface).not.toHaveBeenCalled();
    dispose();
    process.env.ENSEMBLE_OPERATOR_MESSAGE = previous;
  });

  it('submits trimmed lines from readline without blocking caller', () => {
    const submit = vi.fn(() => true);
    delete process.env.ENSEMBLE_OPERATOR_MESSAGE;

    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });

    const dispose = bindAsyncOperatorInput({
      submit,
      getContext: () => ({
        conductorTurn: 1,
        autonomousTurns: 0,
        maxTurns: 5,
        openQuestions: [],
      }),
    });

    expect(mockCreateInterface).toHaveBeenCalledTimes(1);
    fakeRl.emit('line', '  ping  ');
    expect(submit).toHaveBeenCalledWith('ping');
    fakeRl.emit('line', '   ');
    expect(submit).toHaveBeenCalledTimes(1);

    dispose();
    expect(fakeRl.close).toHaveBeenCalled();
  });
});
