import { describe, expect, it } from 'vitest';
import {
  computeActivityLogLineCapacity,
  computeActivityPaneHeight,
  computeInputPaneHeight,
  computeOperatorInputCursorX,
  computeOperatorInputCursorY,
  computeOperatorInputLineIndex,
} from './compute-operator-input-cursor-y.js';
import {
  INPUT_PANE_BORDER_ROWS,
  INPUT_PANE_LEFT_COLUMNS,
  OPEN_QUESTIONS_PANE_HEIGHT,
  OPERATOR_INPUT_CURSOR_Y_OFFSET,
  PANE_BORDER_ROWS,
  WORKER_PANE_HEIGHT,
} from './tui-layout-constants.js';

describe('computeInputPaneHeight', () => {
  it('includes border rows, hint lines, and the input row', () => {
    expect(computeInputPaneHeight({ hintLineCount: 2 })).toBe(INPUT_PANE_BORDER_ROWS + 2 + 1);
  });

  it('supports multiple input display lines', () => {
    expect(
      computeInputPaneHeight({ hintLineCount: 1, inputDisplayLineCount: 4 }),
    ).toBe(INPUT_PANE_BORDER_ROWS + 1 + 4);
  });
});

describe('computeActivityPaneHeight', () => {
  it('fills remaining rows after fixed panes and input pane', () => {
    const terminalRows = 24;
    const hintLineCount = 1;
    const inputPaneHeight = computeInputPaneHeight({ hintLineCount });

    expect(
      computeActivityPaneHeight({ terminalRows, hintLineCount }),
    ).toBe(terminalRows - WORKER_PANE_HEIGHT - OPEN_QUESTIONS_PANE_HEIGHT - inputPaneHeight);
  });
});

describe('computeActivityLogLineCapacity', () => {
  it('reserves title and border rows inside the activity pane', () => {
    const terminalRows = 24;
    const hintLineCount = 1;
    const activityPaneHeight = computeActivityPaneHeight({ terminalRows, hintLineCount });

    expect(computeActivityLogLineCapacity({ terminalRows, hintLineCount })).toBe(
      activityPaneHeight - PANE_BORDER_ROWS - 1,
    );
  });
});

describe('computeOperatorInputCursorX', () => {
  it('includes left border, padding, and prompt width', () => {
    const operatorPrompt = 'operator> ';
    expect(computeOperatorInputCursorX(operatorPrompt)).toBe(
      INPUT_PANE_LEFT_COLUMNS + operatorPrompt.length,
    );
  });
});

describe('computeOperatorInputCursorY', () => {
  it('offsets rendered input line index for Ink useCursor', () => {
    const terminalRows = 24;
    const hintLineCount = 1;
    const inputLineIndex = computeOperatorInputLineIndex({ terminalRows, hintLineCount });

    expect(
      computeOperatorInputCursorY({
        terminalRows,
        hintLineCount,
      }),
    ).toBe(inputLineIndex + OPERATOR_INPUT_CURSOR_Y_OFFSET);
  });

  it('keeps useCursor Y stable when hint wraps (activity pane shrinks)', () => {
    const yOneHintLine = computeOperatorInputCursorY({
      terminalRows: 24,
      hintLineCount: 1,
    });
    const yTwoHintLines = computeOperatorInputCursorY({
      terminalRows: 24,
      hintLineCount: 2,
    });

    expect(yOneHintLine).toBe(yTwoHintLines);
    expect(computeOperatorInputLineIndex({ terminalRows: 24, hintLineCount: 1 })).toBe(22);
  });
});
