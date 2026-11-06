import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { OperatorInputContext } from '@agents-ensemble/core';
import { INITIAL_SESSION_DISPLAY_STATE } from '../display/session-display-state.js';
import { IssueSessionTui } from './issue-session-tui.js';
import { IssueSessionTuiStream } from './issue-session-tui-stream.js';
import { flushInkStdin } from './ink-test-keys.js';
import { createTuiViewModel } from './tui-view-model.js';

const layouts = [
  ['pane', IssueSessionTui],
  ['stream', IssueSessionTuiStream],
] as const;

const question = {
  id: 'inq-1',
  question: 'Proceed?',
  responseType: 'yes_no',
  source: 'conductor',
  status: 'open',
  askedAt: 1,
} satisfies OperatorInputContext['openQuestions'][number];

describe.each(layouts)('%s TUI under frequent session updates', (layout, Component) => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([false, true])('does not exceed React update depth with openQuestion=%s', async (withQuestion) => {
    const viewModel = createTuiViewModel();
    const createContext = (): OperatorInputContext => ({
      conductorTurn: 1,
      autonomousTurns: 0,
      maxTurns: 5,
      openQuestions: withQuestion ? [question] : [],
      queuedMessages: [{
        text: 'pending message',
        delivery: 'next',
        openQuestionAnswer: false,
      }],
    });
    viewModel.setOperatorContext(createContext());

    const renderCommit = vi.fn();
    const reactError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { stderr } = render(
      <React.Profiler id={`${layout}-snapshot-updates`} onRender={renderCommit}>
        <Component viewModel={viewModel} onSubmit={vi.fn()} />
      </React.Profiler>,
    );
    await flushInkStdin();

    const notificationCount = { value: 0 };
    viewModel.subscribe(() => {
      notificationCount.value += 1;
    });
    const updateCount = 96;
    for (let index = 0; index < updateCount; index += 1) {
      viewModel.setDisplayState({
        ...INITIAL_SESSION_DISPLAY_STATE,
        conductorOutput: `event-${index}`,
        openQuestions: withQuestion ? [{ ...question }] : [],
      });
      viewModel.appendActivityLog('harness', `event-${index}`);
      viewModel.setOperatorContext(createContext());
      await flushInkStdin(0);
    }

    const inkErrorOutput = stderr.frames.join('');
    expect(inkErrorOutput).not.toContain('Maximum update depth exceeded');
    expect(reactError.mock.calls.flat().join(' ')).not.toContain('Maximum update depth exceeded');
    expect(notificationCount.value).toBe(updateCount * 2);
    expect(renderCommit.mock.calls.length).toBeLessThan(updateCount * 8);
  });
});
