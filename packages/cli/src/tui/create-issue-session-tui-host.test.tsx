import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUnmount, mockRender } = vi.hoisted(() => {
  const mockUnmount = vi.fn();
  const mockRender = vi.fn(() => ({ unmount: mockUnmount }));
  return { mockUnmount, mockRender };
});

vi.mock('ink', () => ({
  render: mockRender,
  Box: ({ children }: { children: React.ReactNode }) => children,
  Text: ({ children }: { children: React.ReactNode }) => children,
  useCursor: () => ({ setCursorPosition: vi.fn() }),
  useInput: vi.fn(),
}));

vi.mock('./ime-text-input.js', () => ({
  ImeTextInput: () => null,
}));

import { createIssueSessionTuiHost } from './create-issue-session-tui-host.js';
import { INITIAL_SESSION_DISPLAY_STATE } from '../display/session-display-state.js';
import type { OpenQuestion } from '@agents-ensemble/core';

describe('createIssueSessionTuiHost', () => {
  beforeEach(() => {
    mockRender.mockClear();
    mockUnmount.mockClear();
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    const previous = process.env.ENSEMBLE_OPERATOR_MESSAGE;
    delete process.env.ENSEMBLE_OPERATOR_MESSAGE;
    if (previous !== undefined) {
      process.env.ENSEMBLE_OPERATOR_MESSAGE = previous;
    }
  });

  it('starts Ink render and exposes display backend with activity log', () => {
    const host = createIssueSessionTuiHost();

    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(host.telemetrySink).toBeTypeOf('function');

    host.displayBackend.render(
      INITIAL_SESSION_DISPLAY_STATE,
      INITIAL_SESSION_DISPLAY_STATE,
      {
        type: 'operator.input',
        conductorTurn: 1,
        text: 'hello',
      },
    );
    host.displayBackend.render(
      {
        ...INITIAL_SESSION_DISPLAY_STATE,
        conductorOutput: 'ok',
      },
      INITIAL_SESSION_DISPLAY_STATE,
      {
        type: 'conductor.send',
        sendCount: 1,
        runId: 'run-1',
        status: 'finished',
        result: 'ok',
        workerDispatches: 0,
        workerFailures: 0,
      },
    );

    host.telemetrySink({
      type: 'harness.worker.prompt.started',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'worker-1',
      source: 'harness',
    });

    host.dispose();
    expect(mockUnmount).toHaveBeenCalledTimes(1);
  });

  it('bindOperatorInput submits via Ink host without blocking', () => {
    const host = createIssueSessionTuiHost();
    const submit = vi.fn(() => true);
    const getContext = vi.fn(() => ({
      conductorTurn: 1,
      autonomousTurns: 0,
      maxTurns: 0,
      openQuestions: [],
    }));

    const dispose = host.bindOperatorInput({ submit, getContext });
    host.displayBackend.render(
      INITIAL_SESSION_DISPLAY_STATE,
      INITIAL_SESSION_DISPLAY_STATE,
      {
        type: 'operator.input',
        conductorTurn: 1,
        text: 'via binding',
      },
    );

    expect(submit).not.toHaveBeenCalled();
    dispose?.();
    host.dispose();
  });

  it('submits ENSEMBLE_OPERATOR_MESSAGE once without Ink input', () => {
    const previous = process.env.ENSEMBLE_OPERATOR_MESSAGE;
    process.env.ENSEMBLE_OPERATOR_MESSAGE = 'from env';

    const host = createIssueSessionTuiHost();
    const submit = vi.fn(() => true);

    host.bindOperatorInput({
      submit,
      getContext: () => ({
        conductorTurn: 1,
        autonomousTurns: 0,
        maxTurns: 0,
        openQuestions: [],
      }),
    });

    expect(submit).toHaveBeenCalledWith('from env');
    host.dispose();
    process.env.ENSEMBLE_OPERATOR_MESSAGE = previous;
  });

  it('notifyReprompt refreshes operator context from getContext', () => {
    delete process.env.ENSEMBLE_OPERATOR_MESSAGE;
    const host = createIssueSessionTuiHost();
    const getContext = vi.fn(() => ({
      conductorTurn: 3,
      autonomousTurns: 1,
      maxTurns: 5,
      openQuestions: [
        {
          id: 'inq-9',
          question: 'Need input',
          responseType: 'text',
          source: 'conductor',
          status: 'open',
          askedAt: 1,
        } satisfies OpenQuestion,
      ],
    }));

    const dispose = host.bindOperatorInput({
      submit: vi.fn(() => true),
      getContext,
    });
    expect(dispose).toBeTypeOf('function');

    getContext.mockClear();
    host.notifyReprompt();
    expect(getContext).toHaveBeenCalledTimes(1);
    dispose?.();
    host.dispose();
  });
});
