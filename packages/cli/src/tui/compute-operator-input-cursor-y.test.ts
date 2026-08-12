import { describe, expect, it } from 'vitest';
import {
  computeActivityPaneHeight,
  computeInputPaneHeight,
  computeOperatorInputCursorY,
} from './compute-operator-input-cursor-y.js';
import {
  INPUT_PANE_BORDER_ROWS,
  OPEN_QUESTIONS_PANE_HEIGHT,
  PANE_BORDER_ROWS,
  WORKER_PANE_HEIGHT,
} from './tui-layout-constants.js';

describe('computeInputPaneHeight', () => {
  it('includes border rows, hint lines, and the input row', () => {
    expect(computeInputPaneHeight(2)).toBe(INPUT_PANE_BORDER_ROWS + 2 + 1);
  });
});

describe('computeActivityPaneHeight', () => {
  it('fills remaining rows after fixed panes and input pane', () => {
    const terminalRows = 24;
    const hintLineCount = 1;
    const inputPaneHeight = computeInputPaneHeight(hintLineCount);

    expect(
      computeActivityPaneHeight({ terminalRows, hintLineCount }),
    ).toBe(terminalRows - WORKER_PANE_HEIGHT - OPEN_QUESTIONS_PANE_HEIGHT - inputPaneHeight);
  });
});

describe('computeOperatorInputCursorY', () => {
  it('places cursor on input line below hint and fixed panes', () => {
    const terminalRows = 24;
    const hintLineCount = 1;
    const activityPaneHeight = computeActivityPaneHeight({ terminalRows, hintLineCount });

    expect(
      computeOperatorInputCursorY({
        terminalRows,
        hintLineCount,
      }),
    ).toBe(
      WORKER_PANE_HEIGHT +
        activityPaneHeight +
        OPEN_QUESTIONS_PANE_HEIGHT +
        PANE_BORDER_ROWS / 2 +
        hintLineCount,
    );
  });

  it('keeps cursor on the bottom input line when hint wraps (activity pane shrinks)', () => {
    const yOneHintLine = computeOperatorInputCursorY({
      terminalRows: 24,
      hintLineCount: 1,
    });
    const yTwoHintLines = computeOperatorInputCursorY({
      terminalRows: 24,
      hintLineCount: 2,
    });

    expect(yOneHintLine).toBe(yTwoHintLines);
    expect(yOneHintLine).toBe(22);
  });
});
