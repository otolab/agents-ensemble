import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockOperatorTextArea } = vi.hoisted(() => ({
  mockOperatorTextArea: vi.fn(),
}));

vi.mock('./operator-text-area.js', () => ({
  OperatorTextArea: (props: unknown) => {
    mockOperatorTextArea(props);
    return null;
  },
}));

import React from 'react';
import { cleanup, render } from 'ink-testing-library';
import { IssueSessionTuiStream } from './issue-session-tui-stream.js';
import { createTuiViewModel } from './tui-view-model.js';
import {
  computeOperatorInputCursorX,
  computeStreamOperatorInputCursorY,
} from './compute-operator-input-cursor-y.js';
import {
  OPEN_QUESTIONS_PANE_MIN_HEIGHT,
} from './tui-layout-constants.js';

describe('IssueSessionTuiStream IME cursor contract', () => {
  beforeEach(() => {
    mockOperatorTextArea.mockClear();
    Object.defineProperty(process.stdout, 'rows', {
      configurable: true,
      value: 24,
    });
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: 80,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('passes a live-frame-relative cursorStart to the operator input', () => {
    const viewModel = createTuiViewModel();

    render(<IssueSessionTuiStream viewModel={viewModel} onSubmit={() => {}} />);

    const props = mockOperatorTextArea.mock.calls.at(-1)?.[0] as {
      cursorStart?: { x?: number; y: number };
    };
    expect(props.cursorStart).toEqual({
      x: computeOperatorInputCursorX('operator> '),
      y: computeStreamOperatorInputCursorY({
        openQuestionsPaneHeight: 0,
        nestedOpenQuestionsPaneHeight: OPEN_QUESTIONS_PANE_MIN_HEIGHT,
        hintLineCount: 1,
      }),
    });
  });
});
