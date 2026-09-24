import {
  INPUT_PANE_BORDER_ROWS,
  PANE_BORDER_ROWS,
  WORKER_PANE_HEIGHT,
} from './tui-layout-constants.js';

export interface PaneHeights {
  workerPaneHeight: number;
  activityPaneHeight: number;
  openQuestionsPaneHeight: number;
  inputPaneHeight: number;
}

// A titled pane needs a title row and a bottom border row. Keep one content row
// for the activity pane whenever the other panes have enough spare height, but
// allow it to compact to the frame-only minimum before clipping the input.
const MIN_TITLED_PANE_HEIGHT = PANE_BORDER_ROWS;
const MIN_ACTIVITY_PANE_HEIGHT = PANE_BORDER_ROWS;
const PREFERRED_ACTIVITY_PANE_HEIGHT = PANE_BORDER_ROWS + 1;
const MIN_INPUT_PANE_HEIGHT = INPUT_PANE_BORDER_ROWS + 1;

function shrinkHeight(current: number, minimum: number, amount: number): {
  height: number;
  remaining: number;
} {
  const reducible = Math.max(0, current - minimum);
  const reduction = Math.min(reducible, amount);
  return { height: current - reduction, remaining: amount - reduction };
}

/**
 * Fits the pane layout into the already-reserved live frame.
 *
 * The activity pane is the flexible region. On short terminals, reduce the
 * worker pane first, then the activity pane's spare content row, before
 * compacting open questions or input. This prevents a height=1 titled pane
 * from rendering only a stray bottom border without hiding the input row.
 */
export function resolvePaneHeights(params: {
  liveFrameRows: number;
  workerPaneHeight?: number;
  activityPaneHeight: number;
  openQuestionsPaneHeight: number;
  inputPaneHeight: number;
}): PaneHeights {
  const frameLimit = Math.max(1, Math.floor(params.liveFrameRows));
  let workerPaneHeight = Math.max(
    MIN_TITLED_PANE_HEIGHT,
    params.workerPaneHeight ?? WORKER_PANE_HEIGHT,
  );
  let activityPaneHeight = Math.max(
    PREFERRED_ACTIVITY_PANE_HEIGHT,
    Math.floor(params.activityPaneHeight),
  );
  let openQuestionsPaneHeight =
    params.openQuestionsPaneHeight > 0
      ? Math.max(MIN_TITLED_PANE_HEIGHT, Math.floor(params.openQuestionsPaneHeight))
      : 0;
  let inputPaneHeight = Math.max(
    MIN_INPUT_PANE_HEIGHT,
    Math.floor(params.inputPaneHeight),
  );

  let overflow =
    workerPaneHeight +
    activityPaneHeight +
    openQuestionsPaneHeight +
    inputPaneHeight -
    frameLimit;

  if (overflow > 0) {
    const shrunk = shrinkHeight(
      workerPaneHeight,
      MIN_TITLED_PANE_HEIGHT,
      overflow,
    );
    workerPaneHeight = shrunk.height;
    overflow = shrunk.remaining;
  }

  if (overflow > 0) {
    const shrunk = shrinkHeight(
      activityPaneHeight,
      MIN_ACTIVITY_PANE_HEIGHT,
      overflow,
    );
    activityPaneHeight = shrunk.height;
    overflow = shrunk.remaining;
  }

  if (overflow > 0 && openQuestionsPaneHeight > 0) {
    const shrunk = shrinkHeight(
      openQuestionsPaneHeight,
      MIN_TITLED_PANE_HEIGHT,
      overflow,
    );
    openQuestionsPaneHeight = shrunk.height;
    overflow = shrunk.remaining;
  }

  if (overflow > 0) {
    const shrunk = shrinkHeight(inputPaneHeight, MIN_INPUT_PANE_HEIGHT, overflow);
    inputPaneHeight = shrunk.height;
    overflow = shrunk.remaining;
  }

  // Reallocate all remaining rows to the activity pane after compacting the
  // fixed panes. The normal short-terminal case keeps one content row; when
  // necessary, the activity pane remains at its frame-only two-row minimum.
  activityPaneHeight = Math.max(
    MIN_TITLED_PANE_HEIGHT,
    frameLimit -
      workerPaneHeight -
      openQuestionsPaneHeight -
      inputPaneHeight,
  );

  // If the terminal is smaller than every pane minimum, the root clips the
  // content, but each titled pane still receives a non-broken frame height.
  if (overflow > 0) {
    activityPaneHeight = Math.max(
      MIN_TITLED_PANE_HEIGHT,
      activityPaneHeight - overflow,
    );
  }

  return {
    workerPaneHeight,
    activityPaneHeight,
    openQuestionsPaneHeight,
    inputPaneHeight,
  };
}
