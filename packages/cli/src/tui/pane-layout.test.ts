import { describe, expect, it } from 'vitest';
import { resolvePaneHeights } from './pane-layout.js';

describe('resolvePaneHeights', () => {
  it('uses spare Worker rows to keep Orchestration frame-shaped at 60x12', () => {
    expect(
      resolvePaneHeights({
        liveFrameRows: 11,
        activityPaneHeight: 1,
        openQuestionsPaneHeight: 0,
        inputPaneHeight: 4,
      }),
    ).toEqual({
      workerPaneHeight: 4,
      activityPaneHeight: 3,
      openQuestionsPaneHeight: 0,
      inputPaneHeight: 4,
    });
  });

  it('compacts the activity frame before clipping the input row with open questions', () => {
    expect(
      resolvePaneHeights({
        liveFrameRows: 11,
        activityPaneHeight: -2,
        openQuestionsPaneHeight: 3,
        inputPaneHeight: 4,
      }),
    ).toEqual({
      workerPaneHeight: 2,
      activityPaneHeight: 2,
      openQuestionsPaneHeight: 3,
      inputPaneHeight: 4,
    });
  });

  it('leaves the normal pane allocation unchanged when there is no overflow', () => {
    expect(
      resolvePaneHeights({
        liveFrameRows: 23,
        activityPaneHeight: 13,
        openQuestionsPaneHeight: 0,
        inputPaneHeight: 4,
      }),
    ).toEqual({
      workerPaneHeight: 6,
      activityPaneHeight: 13,
      openQuestionsPaneHeight: 0,
      inputPaneHeight: 4,
    });
  });
});
