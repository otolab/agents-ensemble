import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUnmount, mockRender } = vi.hoisted(() => {
  const mockUnmount = vi.fn();
  const mockRender = vi.fn((_element: unknown, _options?: unknown) => ({ unmount: mockUnmount }));
  return { mockUnmount, mockRender };
});

vi.mock('ink', () => ({
  render: mockRender,
  Box: ({ children }: { children: React.ReactNode }) => children,
  Text: ({ children }: { children: React.ReactNode }) => children,
  useCursor: () => ({ setCursorPosition: vi.fn() }),
  useInput: vi.fn(),
}));

vi.mock('./operator-text-area.js', () => ({
  OperatorTextArea: () => null,
}));

import { createIssueSessionTuiHost } from './create-issue-session-tui-host.js';
import { INITIAL_SESSION_DISPLAY_STATE } from '../display/session-display-state.js';
import type { OpenQuestion } from '@agents-ensemble/core';
import { DEFAULT_ENSEMBLE_CONFIG } from '@agents-ensemble/core';

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
    const previousLayout = process.env.ENSEMBLE_TUI_LAYOUT;
    delete process.env.ENSEMBLE_OPERATOR_MESSAGE;
    delete process.env.ENSEMBLE_TUI_LAYOUT;
    if (previous !== undefined) {
      process.env.ENSEMBLE_OPERATOR_MESSAGE = previous;
    }
    if (previousLayout !== undefined) {
      process.env.ENSEMBLE_TUI_LAYOUT = previousLayout;
    }
  });

  it('passes the current issue URL to the TUI view', () => {
    const issueUrl = 'https://github.com/org/repo/issues/1';
    const host = createIssueSessionTuiHost(issueUrl);
    const renderedElement = mockRender.mock.calls[0]?.[0] as {
      props: { issueUrl?: string };
    };

    expect(renderedElement.props.issueUrl).toBe(issueUrl);
    host.dispose();
  });

  it('uses the URL fallback for vscode terminals unless hyperlinks are forced', () => {
    const previousTermProgram = process.env.TERM_PROGRAM;
    const previousForceHyperlink = process.env.FORCE_HYPERLINK;
    const previousCi = process.env.CI;
    process.env.TERM_PROGRAM = 'vscode';
    delete process.env.FORCE_HYPERLINK;
    delete process.env.CI;

    try {
      const host = createIssueSessionTuiHost('https://github.com/org/repo/issues/1');
      const renderedElement = mockRender.mock.calls[0]?.[0] as {
        props: { issueLinkMode?: string };
      };

      expect(renderedElement.props.issueLinkMode).toBe('url');
      host.dispose();
    } finally {
      if (previousTermProgram === undefined) {
        delete process.env.TERM_PROGRAM;
      } else {
        process.env.TERM_PROGRAM = previousTermProgram;
      }
      if (previousForceHyperlink === undefined) {
        delete process.env.FORCE_HYPERLINK;
      } else {
        process.env.FORCE_HYPERLINK = previousForceHyperlink;
      }
      if (previousCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCi;
      }
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

  it('selects stream layout from ENSEMBLE_TUI_LAYOUT and disables alternate screen', () => {
    process.env.ENSEMBLE_TUI_LAYOUT = 'stream';

    const host = createIssueSessionTuiHost();
    const renderedElement = mockRender.mock.calls[0]?.[0] as {
      type: { name?: string };
    };

    expect(renderedElement.type.name).toBe('IssueSessionTuiStream');
    expect(mockRender.mock.calls[0]?.[1]).toEqual({ alternateScreen: false });
    host.dispose();
  });

  it('selects stream layout from config when env is omitted', () => {
    const host = createIssueSessionTuiHost(undefined, {
      config: {
        ...DEFAULT_ENSEMBLE_CONFIG,
        tui: { layout: 'stream', forceHyperlink: 'auto' },
      },
    });
    const renderedElement = mockRender.mock.calls[0]?.[0] as {
      type: { name?: string };
    };

    expect(renderedElement.type.name).toBe('IssueSessionTuiStream');
    host.dispose();
  });

  it('prefers env layout over config', () => {
    const host = createIssueSessionTuiHost(undefined, {
      env: { ENSEMBLE_TUI_LAYOUT: 'pane' } as NodeJS.ProcessEnv,
      config: {
        ...DEFAULT_ENSEMBLE_CONFIG,
        tui: { layout: 'stream', forceHyperlink: 'auto' },
      },
    });
    const renderedElement = mockRender.mock.calls[0]?.[0] as {
      type: { name?: string };
    };

    expect(renderedElement.type.name).toBe('IssueSessionTui');
    host.dispose();
  });

  it('uses osc8 link mode from config forceHyperlink on tmux-like terminals', () => {
    const previousTermProgram = process.env.TERM_PROGRAM;
    process.env.TERM_PROGRAM = 'tmux';

    try {
      const host = createIssueSessionTuiHost('https://github.com/org/repo/issues/1', {
        config: {
          ...DEFAULT_ENSEMBLE_CONFIG,
          tui: { layout: 'pane', forceHyperlink: 'on' },
        },
      });
      const renderedElement = mockRender.mock.calls[0]?.[0] as {
        props: { issueLinkMode?: string };
      };

      expect(renderedElement.props.issueLinkMode).toBe('osc8');
      host.dispose();
    } finally {
      if (previousTermProgram === undefined) {
        delete process.env.TERM_PROGRAM;
      } else {
        process.env.TERM_PROGRAM = previousTermProgram;
      }
    }
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

  it('seeds the TUI view model from restored open questions at binding time', () => {
    delete process.env.ENSEMBLE_OPERATOR_MESSAGE;
    const host = createIssueSessionTuiHost();
    const restoredQuestion: OpenQuestion = {
      id: 'inq-resumed',
      question: 'Resume this question?',
      responseType: 'text',
      source: 'conductor',
      status: 'open',
      askedAt: 1,
    };
    const getContext = vi.fn(() => ({
      conductorTurn: 2,
      autonomousTurns: 1,
      maxTurns: null,
      openQuestions: [restoredQuestion],
    }));
    const renderedElement = mockRender.mock.calls[0]?.[0] as {
      props: {
        viewModel: {
          getSnapshot: () => { operatorContext: { openQuestions: OpenQuestion[] } | undefined };
        };
      };
    };

    const dispose = host.bindOperatorInput({
      submit: vi.fn(() => true),
      getContext,
    });

    expect(renderedElement.props.viewModel.getSnapshot().operatorContext?.openQuestions).toEqual([
      restoredQuestion,
    ]);
    dispose?.();
    host.dispose();
  });
});
