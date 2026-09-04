import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeRl, mockCreateInterface, stderrWrites } = vi.hoisted(() => {
  const stderrWrites: string[] = [];
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
    stderrWrites,
  };
});

vi.mock('node:readline/promises', () => ({
  createInterface: mockCreateInterface,
}));

vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:process')>();
  return {
    ...actual,
    stderr: {
      ...actual.stderr,
      write: (chunk: string) => {
        stderrWrites.push(chunk);
        return true;
      },
    },
  };
});

import {
  bindAsyncOperatorInput,
  notifyOperatorInputReprompt,
} from './async-operator-input.js';
import type { OpenQuestion } from '@agents-ensemble/core';

describe('bindAsyncOperatorInput', () => {
  beforeEach(() => {
    mockCreateInterface.mockClear();
    fakeRl.setPrompt.mockClear();
    fakeRl.prompt.mockClear();
    fakeRl.close.mockClear();
    fakeRl.removeAllListeners();
    stderrWrites.length = 0;
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

  it('writes input-required notice before prompt when open questions exist', () => {
    delete process.env.ENSEMBLE_OPERATOR_MESSAGE;

    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });

    const dispose = bindAsyncOperatorInput({
      submit: vi.fn(() => true),
      getContext: () => ({
        conductorTurn: 1,
        autonomousTurns: 0,
        maxTurns: 5,
        openQuestions: [
          {
            id: 'inq-1',
            question: 'Continue?',
            responseType: 'text',
            source: 'conductor',
            status: 'open',
            askedAt: Date.now(),
          } satisfies OpenQuestion,
        ],
      }),
    });

    expect(stderrWrites.join('')).toContain('オペレータの入力が必要です');
    expect(stderrWrites.join('')).toContain('inq-1');
    expect(fakeRl.prompt).toHaveBeenCalled();

    dispose();
  });

  it('writes a plain issue URL before the readline prompt', () => {
    delete process.env.ENSEMBLE_OPERATOR_MESSAGE;

    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });

    const dispose = bindAsyncOperatorInput(
      {
        submit: vi.fn(() => true),
        getContext: () => ({
          conductorTurn: 1,
          autonomousTurns: 0,
          maxTurns: 5,
          openQuestions: [],
        }),
      },
      { issueUrl: 'https://github.com/org/repo/issues/1' },
    );

    expect(stderrWrites.join('')).toContain('Issue: https://github.com/org/repo/issues/1');
    expect(stderrWrites.join('')).not.toContain('\u001b]8;;');

    dispose();
  });

  it('refreshes prompt when notifyOperatorInputReprompt is called', () => {
    delete process.env.ENSEMBLE_OPERATOR_MESSAGE;

    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });

    let openQuestions: OpenQuestion[] = [];

    const dispose = bindAsyncOperatorInput({
      submit: vi.fn(() => true),
      getContext: () => ({
        conductorTurn: 1,
        autonomousTurns: 0,
        maxTurns: 5,
        openQuestions,
      }),
    });

    fakeRl.prompt.mockClear();
    stderrWrites.length = 0;

    openQuestions = [
      {
        id: 'inq-2',
        question: 'Approve?',
        responseType: 'text',
        source: 'conductor',
        status: 'open',
        askedAt: Date.now(),
      },
    ];
    notifyOperatorInputReprompt();

    expect(stderrWrites.join('')).toContain('オペレータの入力が必要です');
    expect(stderrWrites.join('')).toContain('inq-2');
    expect(fakeRl.prompt).toHaveBeenCalled();

    dispose();
  });
});
