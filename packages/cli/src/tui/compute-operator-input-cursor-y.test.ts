import { describe, expect, it } from 'vitest';
import {
  computeActivityLogLineCapacity,
  computeActivityPaneHeight,
  computeInputPaneHeight,
  computeOperatorInputCursorX,
  computeOperatorInputCursorY,
  computeOperatorInputLineIndex,
  computeOrchestrationLogVisibleLineCount,
} from './compute-operator-input-cursor-y.js';
import {
  INPUT_PANE_BORDER_ROWS,
  INPUT_PANE_LEFT_COLUMNS,
  OPEN_QUESTIONS_PANE_MIN_HEIGHT,
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
    const openQuestionsPaneHeight = OPEN_QUESTIONS_PANE_MIN_HEIGHT;
    const inputPaneHeight = computeInputPaneHeight({ hintLineCount });

    expect(
      computeActivityPaneHeight({ terminalRows, hintLineCount, openQuestionsPaneHeight }),
    ).toBe(terminalRows - WORKER_PANE_HEIGHT - openQuestionsPaneHeight - inputPaneHeight);
  });

  it('shrinks orchestration when open questions pane grows', () => {
    const terminalRows = 24;
    const hintLineCount = 1;
    const small = computeActivityPaneHeight({
      terminalRows,
      hintLineCount,
      openQuestionsPaneHeight: 4,
    });
    const large = computeActivityPaneHeight({
      terminalRows,
      hintLineCount,
      openQuestionsPaneHeight: 10,
    });

    expect(large).toBeLessThan(small);
  });
});

describe('computeOrchestrationLogVisibleLineCount', () => {
  it('reserves border and title rows inside the pane height', () => {
    expect(computeOrchestrationLogVisibleLineCount(10, 1)).toBe(7);
  });

  it('reduces log rows when scroll hint wraps the title', () => {
    expect(computeOrchestrationLogVisibleLineCount(10, 2)).toBe(6);
  });
});

describe('computeActivityLogLineCapacity', () => {
  it('reserves title and border rows inside the activity pane', () => {
    const terminalRows = 24;
    const hintLineCount = 1;
    const openQuestionsPaneHeight = OPEN_QUESTIONS_PANE_MIN_HEIGHT;
    const activityPaneHeight = computeActivityPaneHeight({
      terminalRows,
      hintLineCount,
      openQuestionsPaneHeight,
    });

    expect(
      computeActivityLogLineCapacity({ terminalRows, hintLineCount, openQuestionsPaneHeight }),
    ).toBe(computeOrchestrationLogVisibleLineCount(activityPaneHeight));
  });
});

describe('computeOperatorInputCursorX', () => {
  it('includes left border and padding when prompt is empty', () => {
    expect(computeOperatorInputCursorX('')).toBe(INPUT_PANE_LEFT_COLUMNS);
  });
});

describe('computeOperatorInputCursorY', () => {
  it('offsets rendered input line index for Ink useCursor', () => {
    const terminalRows = 24;
    const hintLineCount = 1;
    const openQuestionsPaneHeight = OPEN_QUESTIONS_PANE_MIN_HEIGHT;
    const inputLineIndex = computeOperatorInputLineIndex({
      terminalRows,
      hintLineCount,
      openQuestionsPaneHeight,
    });

    expect(
      computeOperatorInputCursorY({
        terminalRows,
        hintLineCount,
        openQuestionsPaneHeight,
      }),
    ).toBe(inputLineIndex + OPERATOR_INPUT_CURSOR_Y_OFFSET);
  });

  it('keeps useCursor Y stable when hint wraps (activity pane shrinks)', () => {
    const openQuestionsPaneHeight = OPEN_QUESTIONS_PANE_MIN_HEIGHT;
    const yOneHintLine = computeOperatorInputCursorY({
      terminalRows: 24,
      hintLineCount: 1,
      openQuestionsPaneHeight,
    });
    const yTwoHintLines = computeOperatorInputCursorY({
      terminalRows: 24,
      hintLineCount: 2,
      openQuestionsPaneHeight,
    });

    expect(yOneHintLine).toBe(yTwoHintLines);
    expect(
      computeOperatorInputLineIndex({
        terminalRows: 24,
        hintLineCount: 1,
        openQuestionsPaneHeight,
      }),
    ).toBe(22);
  });
});
