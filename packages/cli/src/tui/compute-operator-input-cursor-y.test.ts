import { describe, expect, it } from 'vitest';
import {
  computeActivityLogLineCapacity,
  computeActivityPaneHeight,
  computeInputPaneHeight,
  computeOperatorInputCursorX,
  computeOperatorInputCursorY,
  computeOperatorInputLineIndex,
  computeOrchestrationLogVisibleLineCount,
  computeStreamOperatorInputCursorY,
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

  it('returns the rows reclaimed by omitting the open-questions pane', () => {
    const withPane = computeActivityPaneHeight({
      terminalRows: 24,
      hintLineCount: 1,
      openQuestionsPaneHeight: OPEN_QUESTIONS_PANE_MIN_HEIGHT,
    });
    const withoutPane = computeActivityPaneHeight({
      terminalRows: 24,
      hintLineCount: 1,
      openQuestionsPaneHeight: 0,
    });

    expect(withoutPane).toBe(withPane + OPEN_QUESTIONS_PANE_MIN_HEIGHT);
  });
});

describe('computeOrchestrationLogVisibleLineCount', () => {
  it('reserves border rows inside the pane height when title is on the border', () => {
    expect(computeOrchestrationLogVisibleLineCount(10)).toBe(8);
  });

  it('supports legacy inner title rows when passed explicitly', () => {
    expect(computeOrchestrationLogVisibleLineCount(10, 1)).toBe(7);
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

  it('keeps the cursor anchored when the open-questions pane is omitted', () => {
    const withPane = computeOperatorInputCursorY({
      terminalRows: 24,
      hintLineCount: 1,
      openQuestionsPaneHeight: OPEN_QUESTIONS_PANE_MIN_HEIGHT,
    });
    const withoutPane = computeOperatorInputCursorY({
      terminalRows: 24,
      hintLineCount: 1,
      openQuestionsPaneHeight: 0,
    });

    expect(withoutPane).toBe(withPane);
  });
});

describe('computeStreamOperatorInputCursorY', () => {
  it('anchors the IME cursor to the stream live frame', () => {
    expect(
      computeStreamOperatorInputCursorY({
        openQuestionsPaneHeight: OPEN_QUESTIONS_PANE_MIN_HEIGHT,
        hintLineCount: 1,
      }),
    ).toBe(
      OPEN_QUESTIONS_PANE_MIN_HEIGHT +
        PANE_BORDER_ROWS / 2 +
        1,
    );
  });

  it('moves the first input row when the context hint wraps', () => {
    const oneLine = computeStreamOperatorInputCursorY({
      openQuestionsPaneHeight: OPEN_QUESTIONS_PANE_MIN_HEIGHT,
      hintLineCount: 1,
    });
    const twoLines = computeStreamOperatorInputCursorY({
      openQuestionsPaneHeight: OPEN_QUESTIONS_PANE_MIN_HEIGHT,
      hintLineCount: 2,
    });

    expect(twoLines).toBe(oneLine + 1);
  });

  it('does not reserve a row for an empty open-question state', () => {
    expect(computeStreamOperatorInputCursorY({
      openQuestionsPaneHeight: 0,
      hintLineCount: 1,
    })).toBe(PANE_BORDER_ROWS / 2 + 1);
  });
});
