import {
  INPUT_PANE_BORDER_ROWS,
  OPEN_QUESTIONS_PANE_MIN_HEIGHT,
  PANE_BORDER_ROWS,
  WORKER_PANE_HEIGHT,
} from './tui-layout-constants.js';

export interface StreamPaneHeights {
  workerPaneHeight: number;
  openQuestionsPaneHeight: number;
  inputPaneHeight: number;
  dynamicFrameHeight: number;
}

function shrinkHeight(current: number, minimum: number, amount: number): {
  height: number;
  remaining: number;
} {
  const reducible = Math.max(0, current - minimum);
  const reduction = Math.min(reducible, amount);
  return { height: current - reduction, remaining: amount - reduction };
}

/**
 * Fit the three live panes below Static output while reserving one terminal row.
 * The normal terminal case keeps the requested pane heights unchanged. On a
 * short terminal, content is clipped before the live frame is allowed to
 * become fullscreen-sized.
 */
export function resolveStreamPaneHeights(params: {
  terminalRows: number;
  workerPaneHeight?: number;
  openQuestionsPaneHeight: number;
  inputPaneHeight: number;
}): StreamPaneHeights {
  const frameLimit = Math.max(0, Math.floor(params.terminalRows) - 1);
  let workerPaneHeight = Math.max(1, params.workerPaneHeight ?? WORKER_PANE_HEIGHT);
  let openQuestionsPaneHeight = Math.max(
    PANE_BORDER_ROWS + 1,
    params.openQuestionsPaneHeight,
  );
  let inputPaneHeight = Math.max(INPUT_PANE_BORDER_ROWS + 1, params.inputPaneHeight);
  let overflow =
    workerPaneHeight + openQuestionsPaneHeight + inputPaneHeight - frameLimit;

  if (overflow > 0) {
    const shrunk = shrinkHeight(
      workerPaneHeight,
      PANE_BORDER_ROWS + 1,
      overflow,
    );
    workerPaneHeight = shrunk.height;
    overflow = shrunk.remaining;
  }

  if (overflow > 0) {
    const shrunk = shrinkHeight(
      openQuestionsPaneHeight,
      OPEN_QUESTIONS_PANE_MIN_HEIGHT,
      overflow,
    );
    openQuestionsPaneHeight = shrunk.height;
    overflow = shrunk.remaining;
  }

  if (overflow > 0) {
    const shrunk = shrinkHeight(
      inputPaneHeight,
      INPUT_PANE_BORDER_ROWS + 1,
      overflow,
    );
    inputPaneHeight = shrunk.height;
    overflow = shrunk.remaining;
  }

  // A terminal shorter than the three pane minimums is not large enough to
  // render every border, but keep the dynamic root below the terminal height.
  if (overflow > 0) {
    let remaining = frameLimit;
    workerPaneHeight = Math.min(1, remaining);
    remaining -= workerPaneHeight;
    openQuestionsPaneHeight = Math.min(1, remaining);
    remaining -= openQuestionsPaneHeight;
    inputPaneHeight = remaining;
  }

  const dynamicFrameHeight =
    workerPaneHeight + openQuestionsPaneHeight + inputPaneHeight;
  return {
    workerPaneHeight,
    openQuestionsPaneHeight,
    inputPaneHeight,
    dynamicFrameHeight,
  };
}
