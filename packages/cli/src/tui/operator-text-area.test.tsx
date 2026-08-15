import { describe, expect, it } from 'vitest';
import {
  computeOperatorInputLayout,
  mapCursorOffsetToDisplayPosition,
  sliceVisibleInputDisplayLines,
} from './operator-input-layout.js';

/** OperatorTextArea の onCursorChange 相当: 論理行・列から value 内 offset へ。 */
function logicalPositionToOffset(value: string, line: number, column: number): number {
  const lines = value.split('\n');
  let offset = 0;
  for (let index = 0; index < line; index++) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return offset + column;
}

describe('OperatorTextArea IME cursor helpers', () => {
  it('maps logical cursor position to display coordinates for wrapped input', () => {
    const value = 'hello\nworld';
    const contentWidth = 30;
    const promptWidth = 0;
    const cursorOffset = logicalPositionToOffset(value, 1, 2);
    const position = mapCursorOffsetToDisplayPosition(
      value,
      cursorOffset,
      contentWidth,
      promptWidth,
    );

    expect(cursorOffset).toBe(8);
    expect(position.displayLineIndex).toBe(1);
    expect(position.columnInLine).toBe(2);
  });

  it('keeps cursor line inside visible slice when scrolling', () => {
    const contentWidth = 10;
    const promptWidth = 0;
    const longValue = 'line\n'.repeat(8).trimEnd();
    const layout = computeOperatorInputLayout(longValue, contentWidth, promptWidth);
    const maxDisplayLines = 3;
    const cursorLine = layout.displayLines.length - 1;
    const { scrollOffset } = sliceVisibleInputDisplayLines(
      layout.displayLines,
      maxDisplayLines,
      cursorLine,
    );

    expect(scrollOffset).toBeGreaterThan(0);
    expect(cursorLine).toBeLessThan(scrollOffset + maxDisplayLines);
  });
});
