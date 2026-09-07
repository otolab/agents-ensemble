import { describe, expect, it } from 'vitest';
import { resolveStreamPaneHeights } from './stream-layout.js';

describe('resolveStreamPaneHeights', () => {
  it('omits the independent open-questions pane when its height is zero', () => {
    const heights = resolveStreamPaneHeights({
      terminalRows: 24,
      openQuestionsPaneHeight: 0,
      inputPaneHeight: 7,
    });

    expect(heights.openQuestionsPaneHeight).toBe(0);
    expect(heights.dynamicFrameHeight).toBe(
      heights.workerPaneHeight + heights.inputPaneHeight,
    );
    expect(heights.dynamicFrameHeight).toBeLessThan(24);
  });

  it('keeps the live frame below the terminal height', () => {
    const heights = resolveStreamPaneHeights({
      terminalRows: 24,
      openQuestionsPaneHeight: 3,
      inputPaneHeight: 4,
    });

    expect(heights.dynamicFrameHeight).toBe(
      heights.workerPaneHeight + heights.openQuestionsPaneHeight + heights.inputPaneHeight,
    );
    expect(heights.dynamicFrameHeight).toBeLessThan(24);
  });

  it('shrinks pane heights before allowing a fullscreen live frame', () => {
    const heights = resolveStreamPaneHeights({
      terminalRows: 14,
      openQuestionsPaneHeight: 8,
      inputPaneHeight: 8,
    });

    expect(heights.dynamicFrameHeight).toBeLessThan(14);
    expect(heights.openQuestionsPaneHeight).toBeGreaterThanOrEqual(3);
    expect(heights.inputPaneHeight).toBeGreaterThanOrEqual(3);
  });

  it('keeps the dynamic frame below even a very short terminal', () => {
    const heights = resolveStreamPaneHeights({
      terminalRows: 2,
      openQuestionsPaneHeight: 3,
      inputPaneHeight: 3,
    });

    expect(heights.dynamicFrameHeight).toBeLessThan(2);
    expect(heights.dynamicFrameHeight).toBe(
      heights.workerPaneHeight + heights.openQuestionsPaneHeight + heights.inputPaneHeight,
    );
  });
});
