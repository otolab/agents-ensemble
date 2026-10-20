import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockOperatorTextArea, mockState } = vi.hoisted(() => ({
  mockOperatorTextArea: vi.fn(),
  mockState: { injectSlashInput: false },
}));

vi.mock('./operator-text-area.js', async () => {
  const React = await import('react');
  return {
    OperatorTextArea: (props: unknown) => {
      mockOperatorTextArea(props);
      const inputProps = props as {
        onChange?: (value: string) => void;
        onCursorChange?: (position: [number, number]) => void;
      };
      const didInjectInput = React.useRef(false);
      React.useEffect(() => {
        if (!mockState.injectSlashInput || didInjectInput.current) {
          return;
        }
        didInjectInput.current = true;
        inputProps.onChange?.('/');
        inputProps.onCursorChange?.([0, 1]);
      }, [inputProps.onChange, inputProps.onCursorChange]);
      return null;
    },
  };
});

import React from 'react';
import { cleanup, render } from 'ink-testing-library';
import { IssueSessionTuiStream } from './issue-session-tui-stream.js';
import { createTuiViewModel } from './tui-view-model.js';
import { flushInkStdin, INK_TEST_KEYS } from './ink-test-keys.js';
import { getOperatorCommandSuggestionLines } from './operator-command-suggestions.js';
import {
  computeOperatorInputCursorX,
  computeStreamOperatorInputCursorY,
} from './compute-operator-input-cursor-y.js';
import { resolveOperatorInputDisplayMode } from './format-operator-context.js';
import {
  OPERATOR_INPUT_PROMPT,
  PANE_PADDING_X,
  ROUND_BORDER_WIDTH,
} from './tui-layout-constants.js';
import { getPaneContentWidth, wrapTextToWidth } from './wrap-text-to-width.js';

describe('IssueSessionTuiStream IME cursor contract', () => {
  beforeEach(() => {
    mockOperatorTextArea.mockClear();
    mockState.injectSlashInput = false;
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
    mockState.injectSlashInput = false;
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
      x: computeOperatorInputCursorX(OPERATOR_INPUT_PROMPT),
      // live frame: input title (1); no fixed no-question hint line
      y: 1,
    });
    expect(props.cursorStart?.y).toBe(
      computeStreamOperatorInputCursorY({
        openQuestionsPaneHeight: 0,
        hintLineCount: 0,
      }),
    );
  });

  it('includes visible slash suggestion rows in stream height and IME cursor placement', async () => {
    mockState.injectSlashInput = true;
    const viewModel = createTuiViewModel();
    const { stdin, lastFrame } = render(
      <IssueSessionTuiStream viewModel={viewModel} onSubmit={() => {}} />,
    );
    await flushInkStdin();

    const contentWidth = getPaneContentWidth({
      columns: 80,
      paddingX: PANE_PADDING_X,
      borderWidth: ROUND_BORDER_WIDTH,
    });
    const suggestionLineCount = getOperatorCommandSuggestionLines(
      '/',
      contentWidth,
    ).length;
    const contextHintLineCount = resolveOperatorInputDisplayMode({
      openQuestions: [],
    }).hintLines.reduce(
      (lineCount, line) => lineCount + wrapTextToWidth(line, contentWidth).length,
      0,
    );
    const props = mockOperatorTextArea.mock.calls.at(-1)?.[0] as {
      suggestionsActive?: boolean;
      cursorPosition?: [number, number];
      cursorStart?: { x?: number; y: number };
    };
    expect(props.suggestionsActive).toBe(true);
    expect(props.cursorPosition).toEqual([0, 1]);
    expect(props.cursorStart?.y).toBe(
      computeStreamOperatorInputCursorY({
        openQuestionsPaneHeight: 0,
        hintLineCount: contextHintLineCount + suggestionLineCount,
      }),
    );
    expect(lastFrame() ?? '').toContain('› /reconnect');

    stdin.write(INK_TEST_KEYS.downArrow);
    await flushInkStdin();
    expect(lastFrame() ?? '').toContain('› /exit');
  });
});
