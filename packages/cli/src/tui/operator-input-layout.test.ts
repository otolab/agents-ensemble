import { describe, expect, it } from 'vitest';
import {
  computeMaxInputDisplayLines,
  computeOperatorInputDisplayLines,
  computeOperatorInputLayout,
  mapCursorOffsetToDisplayPosition,
  mapDisplayPositionToCursorOffset,
  sliceVisibleInputDisplayLines,
  trimBlankLinesOnly,
} from './operator-input-layout.js';

describe('trimBlankLinesOnly', () => {
  it('removes only leading and trailing blank lines', () => {
    expect(trimBlankLinesOnly('\n\n  hello  \n\nworld\n\n')).toBe('  hello  \n\nworld');
  });

  it('returns empty string when only blank lines', () => {
    expect(trimBlankLinesOnly('\n\n  \n')).toBe('');
  });
});

describe('computeMaxInputDisplayLines', () => {
  it('caps by ratio and absolute maximum', () => {
    expect(computeMaxInputDisplayLines(24)).toBe(8);
    expect(computeMaxInputDisplayLines(40)).toBe(10);
  });
});

describe('computeOperatorInputDisplayLines', () => {
  it('wraps first line with prompt width and later lines at full width', () => {
    const contentWidth = 20;
    const promptWidth = 10;
    const lines = computeOperatorInputDisplayLines('abcdefghijklmnop', contentWidth, promptWidth);
    expect(lines.length).toBeGreaterThan(1);
  });

  it('preserves explicit newlines', () => {
    const lines = computeOperatorInputDisplayLines('line1\nline2', 40, 10);
    expect(lines).toEqual(['line1', 'line2']);
  });
});

describe('cursor mapping', () => {
  const contentWidth = 40;
  const promptWidth = 10;

  it('maps offset to display position and back', () => {
    const value = 'hello\nworld';
    const offset = 8;
    const position = mapCursorOffsetToDisplayPosition(value, offset, contentWidth, promptWidth);
    const restored = mapDisplayPositionToCursorOffset(
      value,
      position.displayLineIndex,
      position.columnInLine,
      contentWidth,
      promptWidth,
    );
    expect(restored).toBe(offset);
  });

  it('tracks wrapped line starts consistently with layout', () => {
    const value = 'word '.repeat(20);
    const layout = computeOperatorInputLayout(value, 30, 10);
    expect(layout.displayLines.length).toBeGreaterThan(1);
    expect(layout.lineStartOffsets[0]).toBe(0);
    expect(layout.lineStartOffsets[1]).toBeGreaterThan(0);
  });
});

describe('sliceVisibleInputDisplayLines', () => {
  it('keeps tail lines when exceeding max visible', () => {
    const displayLines = ['a', 'b', 'c', 'd', 'e'];
    const { visibleLines, scrollOffset } = sliceVisibleInputDisplayLines(displayLines, 3);
    expect(scrollOffset).toBe(2);
    expect(visibleLines).toEqual(['c', 'd', 'e']);
  });
});

describe('sliceVisibleInputDisplayLines with cursor', () => {
  it('follows cursor line when it is above the tail window', () => {
    const displayLines = ['a', 'b', 'c', 'd', 'e'];
    const { visibleLines, scrollOffset } = sliceVisibleInputDisplayLines(displayLines, 3, 1);
    expect(scrollOffset).toBe(0);
    expect(visibleLines).toEqual(['a', 'b', 'c']);
  });

  it('uses tail follow when cursor is in the tail window', () => {
    const displayLines = ['a', 'b', 'c', 'd', 'e'];
    const { visibleLines, scrollOffset } = sliceVisibleInputDisplayLines(displayLines, 3, 4);
    expect(scrollOffset).toBe(2);
    expect(visibleLines).toEqual(['c', 'd', 'e']);
  });
});

