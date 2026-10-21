import { describe, expect, it } from 'vitest';
import { computeWorkerPaneHeight, resolvePaneHeights } from './pane-layout.js';

describe('resolvePaneHeights', () => {
  it.each([
    { workerCount: 0, expectedHeight: 3 },
    { workerCount: 1, expectedHeight: 3 },
    { workerCount: 2, expectedHeight: 4 },
    { workerCount: 5, expectedHeight: 7 },
  ])(
    'sizes the Workers pane for $workerCount status rows',
    ({ workerCount, expectedHeight }) => {
      expect(computeWorkerPaneHeight(workerCount)).toBe(expectedHeight);
    },
  );

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

  it('bounds content-driven Workers at 60x12 while preserving the other pane minimums', () => {
    const desiredWorkerPaneHeight = computeWorkerPaneHeight(8);
    expect(
      resolvePaneHeights({
        liveFrameRows: 11,
        workerPaneHeight: desiredWorkerPaneHeight,
        activityPaneHeight: 11 - desiredWorkerPaneHeight - 3 - 4,
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
