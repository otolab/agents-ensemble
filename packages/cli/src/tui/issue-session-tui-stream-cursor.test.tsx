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
    viewModel.setPostLoopWaiting(true);

    render(
      <IssueSessionTuiStream
        viewModel={viewModel}
        issueUrl="https://github.com/otolab/agents-ensemble/issues/261"
        issueLinkMode="label"
        onSubmit={() => {}}
      />,
    );

    const props = mockOperatorTextArea.mock.calls.at(-1)?.[0] as {
      cursorStart?: { x?: number; y: number };
    };
    expect(props.cursorStart).toEqual({
      x: computeOperatorInputCursorX('operator> '),
      // live frame: input title (1) + the two post-loop hint lines
      y: 3,
    });
    expect(props.cursorStart?.y).toBe(
      computeStreamOperatorInputCursorY({
        openQuestionsPaneHeight: 0,
        hintLineCount: 2,
      }),
    );
  });
});
