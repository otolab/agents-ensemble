import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fakeRl,
  mockCreateInterface,
  stderrWrites,
  stderrTty,
  stdoutTty,
} = vi.hoisted(() => {
  const stderrWrites: string[] = [];
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const stderrTty = { value: true };
  const stdoutTty = { value: true };
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
    stderrTty,
    stdoutTty,
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
      get isTTY() {
        return stderrTty.value;
      },
      write: (chunk: string) => {
        stderrWrites.push(chunk);
        return true;
      },
    },
    stdout: {
      ...actual.stdout,
      get isTTY() {
        return stdoutTty.value;
      },
    },
  };
});

import {
  bindAsyncOperatorInput,
  notifyOperatorInputReprompt,
} from './async-operator-input.js';
import type {
  ConductorRecoverySnapshot,
  OpenQuestion,
} from '@agents-ensemble/core';

describe('bindAsyncOperatorInput', () => {
  beforeEach(() => {
    mockCreateInterface.mockClear();
    stderrTty.value = true;
    stdoutTty.value = true;
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

  it('submits the CLI message once without readline', () => {
    const submit = vi.fn(() => true);
    delete process.env.ENSEMBLE_OPERATOR_MESSAGE;

    const dispose = bindAsyncOperatorInput(
      {
        submit,
        getContext: () => ({
          conductorTurn: 1,
          autonomousTurns: 0,
          maxTurns: 5,
          openQuestions: [],
        }),
      },
      { initialOperatorMessage: '  hello from cli  ' },
    );

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith('hello from cli');
    expect(mockCreateInterface).not.toHaveBeenCalled();
    dispose();
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

    expect(stderrWrites.join('')).toContain(
      '/reconnect、/recovery、/close 保存して閉じる、/exit 掃除して終了',
    );
    expect(mockCreateInterface).toHaveBeenCalledTimes(1);
    fakeRl.emit('line', '  ping  ');
    expect(submit).toHaveBeenCalledWith('ping');
    fakeRl.emit('line', '   ');
    expect(submit).toHaveBeenCalledTimes(1);

    dispose();
    expect(fakeRl.close).toHaveBeenCalled();
  });

  it('inspects recovery content locally without submitting it to the conductor', () => {
    delete process.env.ENSEMBLE_OPERATOR_MESSAGE;
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    const submit = vi.fn(() => true);
    const getRecoverySnapshot = vi.fn(() => ({
      recoveryId: 'conductor-recovery-12',
      createdAt: 1_800_000_000_000,
      expiresAt: 1_800_001_800_000,
      sendCount: 12,
      workflow: 'issue' as const,
      backend: 'pi' as const,
      runId: 'run-12',
      sourceKey: 'operator',
      eventTypes: ['operator.message'],
      status: 'error',
      failureClass: 'auth' as const,
      automaticReconnect: {
        reason: 'auth' as const,
        succeeded: true,
      },
      automaticRetryAttempts: 0 as const,
      toolCallStarted: false,
      inputTexts: ['private task body'],
      inputCount: 1,
      contentBytes: 17,
    } satisfies ConductorRecoverySnapshot));

    const dispose = bindAsyncOperatorInput(
      {
        submit,
        getContext: () => ({
          conductorTurn: 13,
          autonomousTurns: 0,
          maxTurns: null,
          openQuestions: [],
        }),
        listRecoverySnapshots: () => [],
        getRecoverySnapshot,
        clearRecoverySnapshot: () => false,
      },
    );

    stderrWrites.length = 0;
    fakeRl.emit('line', '/recovery show conductor-recovery-12');

    expect(getRecoverySnapshot).toHaveBeenCalledWith(
      'conductor-recovery-12',
    );
    expect(submit).not.toHaveBeenCalled();
    expect(stderrWrites.join('')).toContain('private task body');

    dispose();
  });

  it('refuses to print recovery payloads when stderr is not a TTY', () => {
    delete process.env.ENSEMBLE_OPERATOR_MESSAGE;
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    stderrTty.value = false;
    stdoutTty.value = true;
    const submit = vi.fn(() => true);
    const getRecoverySnapshot = vi.fn();

    const dispose = bindAsyncOperatorInput({
      submit,
      getContext: () => ({
        conductorTurn: 1,
        autonomousTurns: 0,
        maxTurns: null,
        openQuestions: [],
      }),
      listRecoverySnapshots: () => [],
      getRecoverySnapshot,
      clearRecoverySnapshot: () => false,
    });
    stderrWrites.length = 0;

    fakeRl.emit('line', '/recovery show conductor-recovery-1');

    expect(getRecoverySnapshot).not.toHaveBeenCalled();
    expect(stderrWrites.join('')).toContain('対話 TTY 上でのみ表示');
    expect(stderrWrites.join('')).not.toContain('private task body');
    expect(submit).not.toHaveBeenCalled();

    dispose();
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
