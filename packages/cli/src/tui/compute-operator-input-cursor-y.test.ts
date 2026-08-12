import { describe, expect, it } from 'vitest';
import {
  INPUT_PANE_BORDER_ROWS,
  OPEN_QUESTIONS_PANE_HEIGHT,
  WORKER_PANE_HEIGHT,
  computeOperatorInputCursorY,
} from './compute-operator-input-cursor-y.js';

describe('computeOperatorInputCursorY', () => {
  it('places cursor on input line below hint and fixed panes', () => {
    const terminalRows = 24;
    const hintLineCount = 1;
    const inputPaneHeight = INPUT_PANE_BORDER_ROWS + hintLineCount + 1;
    const activityPaneHeight =
      terminalRows -
      WORKER_PANE_HEIGHT -
      OPEN_QUESTIONS_PANE_HEIGHT -
      inputPaneHeight;

    expect(
      computeOperatorInputCursorY({
        terminalRows,
        hintLineCount,
      }),
    ).toBe(
      WORKER_PANE_HEIGHT +
        activityPaneHeight +
        OPEN_QUESTIONS_PANE_HEIGHT +
        1 +
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
