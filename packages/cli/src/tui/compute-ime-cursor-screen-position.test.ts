import { describe, expect, it } from 'vitest';
import {
  computeImeCursorScreenPosition,
  type ImeCursorScreenPositionInput,
} from './compute-ime-cursor-screen-position.js';

describe('computeImeCursorScreenPosition', () => {
  const base: ImeCursorScreenPositionInput = {
    focus: true,
    cursorStart: { x: 13, y: 20 },
    promptWidth: 11,
    scrollOffset: 0,
    visibleCursorLineIndex: 0,
    cursorColumnInVisibleLine: 3,
  };

  it('places cursor on first line including prompt width', () => {
    expect(computeImeCursorScreenPosition(base)).toEqual({ x: 16, y: 20 });
  });

  it('uses content column on wrapped continuation lines', () => {
    expect(
      computeImeCursorScreenPosition({
        ...base,
        scrollOffset: 1,
        visibleCursorLineIndex: 1,
        cursorColumnInVisibleLine: 5,
      }),
    ).toEqual({ x: 7, y: 21 });
  });

  it('returns undefined when unfocused or cursor start is missing', () => {
    expect(computeImeCursorScreenPosition({ ...base, focus: false })).toBeUndefined();
    expect(computeImeCursorScreenPosition({ ...base, cursorStart: undefined })).toBeUndefined();
  });
});
