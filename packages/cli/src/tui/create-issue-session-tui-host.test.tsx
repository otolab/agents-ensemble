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
import type {
  OpenQuestion,
  OperatorInputBindingApi,
} from '@agents-ensemble/core';
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
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it('clears User Timing entries during long-running updates and stops on dispose', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const entryPrefix = 'ensemble-issue-session-tui-host-test';
    performance.clearMeasures();
    performance.clearMarks();

    const host = createIssueSessionTuiHost();
    let previousMeasureCount = 0;
    let observedClear = false;
    let maximumMeasureCount = 0;

    for (let update = 0; update < 60; update += 1) {
      for (let entry = 0; entry < 100; entry += 1) {
        const name = `${entryPrefix}-${update}-${entry}`;
        performance.mark(`${name}-mark`);
        performance.measure(`${name}-measure`, { start: 0, end: 1 });
      }
      host.displayBackend.render(
        INITIAL_SESSION_DISPLAY_STATE,
        INITIAL_SESSION_DISPLAY_STATE,
        {
          type: 'operator.input',
          conductorTurn: update + 1,
          text: `stream update ${update}`,
        },
      );
      vi.advanceTimersByTime(1_000);

      const measureCount = performance
        .getEntriesByType('measure')
        .filter((entry) => entry.name.startsWith(entryPrefix)).length;
      maximumMeasureCount = Math.max(maximumMeasureCount, measureCount);
      observedClear ||= measureCount < previousMeasureCount;
      previousMeasureCount = measureCount;
    }

    expect(observedClear).toBe(true);
    expect(maximumMeasureCount).toBeLessThan(3_000);
    expect(
      performance.getEntriesByType('mark').filter((entry) => entry.name.startsWith(entryPrefix)),
    ).toHaveLength(0);
    expect(
      performance
        .getEntriesByType('measure')
        .filter((entry) => entry.name.startsWith(entryPrefix)),
    ).toHaveLength(0);

    host.dispose();
    for (let entry = 0; entry < 100; entry += 1) {
      const name = `${entryPrefix}-after-dispose-${entry}`;
      performance.mark(`${name}-mark`);
      performance.measure(`${name}-measure`, { start: 0, end: 1 });
    }
    vi.advanceTimersByTime(30_000);
    expect(
      performance.getEntriesByType('measure').filter((entry) => entry.name.startsWith(entryPrefix)),
    ).toHaveLength(100);
    expect(
      performance.getEntriesByType('mark').filter((entry) => entry.name.startsWith(entryPrefix)),
    ).toHaveLength(100);
  });

  it('keeps rendering when clearing User Timing entries throws', () => {
    vi.useFakeTimers();
    const clearMeasures = vi
      .spyOn(performance, 'clearMeasures')
      .mockImplementation(() => {
        throw new Error('measure cleanup failed');
      });
    const clearMarks = vi.spyOn(performance, 'clearMarks');
    const host = createIssueSessionTuiHost();

    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    expect(clearMeasures).toHaveBeenCalledTimes(1);
    expect(clearMarks).toHaveBeenCalledTimes(1);

    host.displayBackend.render(
      INITIAL_SESSION_DISPLAY_STATE,
      INITIAL_SESSION_DISPLAY_STATE,
      {
        type: 'operator.input',
        conductorTurn: 1,
        text: 'still rendering',
      },
    );
    expect(() => host.dispose()).not.toThrow();
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

  it.each(['pane', 'stream'])('logs only dispatched messages in %s layout', (layout) => {
    const host = createIssueSessionTuiHost(undefined, { env: { ENSEMBLE_TUI_LAYOUT: layout } });
    const element = mockRender.mock.calls[0]?.[0] as {
      props: { viewModel: { getSnapshot: () => { activityLog: Array<{ text: string }> } } };
    };
    const state = INITIAL_SESSION_DISPLAY_STATE;
    host.displayBackend.render(state, state, {
      type: 'operator.input', conductorTurn: 1, text: 'waiting', delivery: 'idle',
    });
    expect(element.props.viewModel.getSnapshot().activityLog).toEqual([]);
    host.displayBackend.render(state, state, { type: 'operator.dispatched', text: 'waiting' });
    expect(element.props.viewModel.getSnapshot().activityLog).toEqual([
      expect.objectContaining({ text: 'waiting' }),
    ]);
    host.dispose();
  });

  it('uses stream layout by default', () => {
    const host = createIssueSessionTuiHost(undefined, { env: {} });
    const renderedElement = mockRender.mock.calls[0]?.[0] as {
      type: { name?: string };
    };

    expect(renderedElement.type.name).toBe('IssueSessionTuiStream');
    host.dispose();
  });

  it('selects stream layout from ENSEMBLE_TUI_LAYOUT and disables alternate screen', () => {
    process.env.ENSEMBLE_TUI_LAYOUT = 'stream';

    const host = createIssueSessionTuiHost();
    const renderedElement = mockRender.mock.calls[0]?.[0] as {
      type: { name?: string };
    };
    const renderOptions = mockRender.mock.calls[0]?.[1] as {
      alternateScreen?: boolean;
      stdout?: unknown;
    };

    expect(renderedElement.type.name).toBe('IssueSessionTuiStream');
    expect(renderOptions).toMatchObject({ alternateScreen: false });
    expect(renderOptions.stdout).toBeDefined();
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

  it('shows a recovery snapshot only in the local inspection view and clears it before a new instruction', () => {
    const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    try {
      const host = createIssueSessionTuiHost();
      const submit = vi.fn(() => true);
      const api: OperatorInputBindingApi = {
        submit,
        getContext: () => ({
          conductorTurn: 13,
          autonomousTurns: 0,
          maxTurns: null,
          openQuestions: [],
        }),
        listPiAuthRecoverySnapshots: () => [],
        getPiAuthRecoverySnapshot: vi.fn(() => ({
          recoveryId: 'pi-auth-recovery-12',
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          failedDispatch: {
            sendCount: 12,
            runId: 'run-12',
            sourceKey: 'operator',
            eventTypes: ['operator.message'],
            eventCount: 1,
            eventReferences: [],
            eventReferencesTruncated: false,
          },
          failure: {
            kind: 'pi_api_key_resolution' as const,
            automaticRetryAttempts: 1 as const,
            toolCallStarted: false as const,
          },
          content: 'private operator task body',
          contentBytes: 27,
        })),
        clearPiAuthRecoverySnapshot: () => false,
      };
      const renderedElement = mockRender.mock.calls[0]?.[0] as {
        props: {
          onSubmit: (text: string) => void;
          viewModel: {
            getSnapshot: () => {
              activityLog: unknown[];
              recoveryInspection: { text: string } | undefined;
            };
          };
        };
      };

      const dispose = host.bindOperatorInput(api);
      renderedElement.props.onSubmit('/recovery show pi-auth-recovery-12');

      expect(
        renderedElement.props.viewModel.getSnapshot().recoveryInspection?.text,
      ).toContain('private operator task body');
      expect(renderedElement.props.viewModel.getSnapshot().activityLog).toEqual(
        [],
      );
      expect(submit).not.toHaveBeenCalled();

      renderedElement.props.onSubmit('continue after checking current state');
      expect(submit).toHaveBeenCalledWith(
        'continue after checking current state',
        undefined,
      );
      expect(
        renderedElement.props.viewModel.getSnapshot().recoveryInspection,
      ).toBeUndefined();
      expect(renderedElement.props.viewModel.getSnapshot().activityLog).toEqual(
        [],
      );

      dispose?.();
      host.dispose();
    } finally {
      if (stdoutIsTty) {
        Object.defineProperty(process.stdout, 'isTTY', stdoutIsTty);
      } else {
        Reflect.deleteProperty(process.stdout, 'isTTY');
      }
    }
  });

  it('hides the sensitive inspection pane when its snapshot expires or the binding is disposed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T00:00:00.000Z'));
    const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    try {
      const host = createIssueSessionTuiHost();
      const renderedElement = mockRender.mock.calls[0]?.[0] as {
        props: {
          onSubmit: (text: string) => void;
          viewModel: {
            getSnapshot: () => {
              recoveryInspection: { text: string } | undefined;
            };
          };
        };
      };
      const dispose = host.bindOperatorInput({
        submit: vi.fn(() => true),
        getContext: () => ({
          conductorTurn: 1,
          autonomousTurns: 0,
          maxTurns: null,
          openQuestions: [],
        }),
        listPiAuthRecoverySnapshots: () => [],
        getPiAuthRecoverySnapshot: () => ({
          recoveryId: 'pi-auth-recovery-1',
          createdAt: Date.now(),
          expiresAt: Date.now() + 100,
          failedDispatch: {
            sendCount: 1,
            runId: 'run-1',
            sourceKey: 'operator',
            eventTypes: ['operator.message'],
            eventCount: 1,
            eventReferences: [],
            eventReferencesTruncated: false,
          },
          failure: {
            kind: 'pi_api_key_resolution',
            automaticRetryAttempts: 0,
            toolCallStarted: false,
          },
          content: 'sensitive content',
          contentBytes: 17,
        }),
        clearPiAuthRecoverySnapshot: () => false,
      });

      renderedElement.props.onSubmit('/recovery show pi-auth-recovery-1');
      expect(
        renderedElement.props.viewModel.getSnapshot().recoveryInspection,
      ).toBeDefined();
      vi.advanceTimersByTime(100);
      expect(
        renderedElement.props.viewModel.getSnapshot().recoveryInspection,
      ).toBeUndefined();

      renderedElement.props.onSubmit('/recovery show pi-auth-recovery-1');
      dispose?.();
      expect(
        renderedElement.props.viewModel.getSnapshot().recoveryInspection,
      ).toBeUndefined();
      host.dispose();
    } finally {
      if (stdoutIsTty) {
        Object.defineProperty(process.stdout, 'isTTY', stdoutIsTty);
      } else {
        Reflect.deleteProperty(process.stdout, 'isTTY');
      }
    }
  });

  it('submits ENSEMBLE_OPERATOR_MESSAGE once and keeps the Ink input binding', () => {
    const previous = process.env.ENSEMBLE_OPERATOR_MESSAGE;
    process.env.ENSEMBLE_OPERATOR_MESSAGE = 'from env';

    const host = createIssueSessionTuiHost();
    const submit = vi.fn(() => true);
    const renderedElement = mockRender.mock.calls[0]?.[0] as {
      props: { onSubmit: (text: string) => void };
    };

    const dispose = host.bindOperatorInput({
      submit,
      getContext: () => ({
        conductorTurn: 1,
        autonomousTurns: 0,
        maxTurns: 0,
        openQuestions: [],
      }),
    });

    expect(submit).toHaveBeenCalledWith('from env');
    renderedElement.props.onSubmit('follow-up');
    expect(submit).toHaveBeenCalledWith('follow-up', undefined);

    dispose?.();
    renderedElement.props.onSubmit('after dispose');
    expect(submit).not.toHaveBeenCalledWith('after dispose');
    host.dispose();
    process.env.ENSEMBLE_OPERATOR_MESSAGE = previous;
  });

  it('submits the CLI message once and keeps the Ink input binding', () => {
    delete process.env.ENSEMBLE_OPERATOR_MESSAGE;

    const host = createIssueSessionTuiHost(undefined, {
      initialOperatorMessage: '  from cli  ',
    });
    const submit = vi.fn(() => true);
    const renderedElement = mockRender.mock.calls[0]?.[0] as {
      props: { onSubmit: (text: string) => void };
    };

    const dispose = host.bindOperatorInput({
      submit,
      getContext: () => ({
        conductorTurn: 1,
        autonomousTurns: 0,
        maxTurns: 0,
        openQuestions: [],
      }),
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith('from cli');
    renderedElement.props.onSubmit('follow-up');
    expect(submit).toHaveBeenCalledWith('follow-up', undefined);

    dispose?.();
    renderedElement.props.onSubmit('after dispose');
    expect(submit).not.toHaveBeenCalledWith('after dispose');
    host.dispose();
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
