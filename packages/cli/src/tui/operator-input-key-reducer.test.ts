import { describe, expect, it } from 'vitest';
import {
  mapCursorOffsetToDisplayPosition,
  mapDisplayPositionToCursorOffset,
} from './operator-input-layout.js';
import { reduceOperatorInputKeyPress } from './operator-input-key-reducer.js';

const CONTENT_WIDTH = 20;
const PROMPT_WIDTH = 10;

function press(
  value: string,
  cursorOffset: number,
  key: Parameters<typeof reduceOperatorInputKeyPress>[2]['key'],
  input = '',
) {
  return reduceOperatorInputKeyPress(
    value,
    { cursorOffset, cursorWidth: 0 },
    { input, key },
    { contentWidth: CONTENT_WIDTH, promptWidth: PROMPT_WIDTH, showCursor: true },
  );
}

describe('reduceOperatorInputKeyPress', () => {
  it('moves up from second paragraph line to first with column clamp', () => {
    const value = 'hello\nworld';
    const startOffset = value.length;
    const action = press(value, startOffset, { upArrow: true });
    expect(action.type).toBe('move');
    expect(action.cursorOffset).toBe(5);
  });

  it('moves left across wrapped line boundary by display column', () => {
    const value = 'abcdefghijklmnop';
    const endOffset = value.length;
    const position = mapCursorOffsetToDisplayPosition(
      value,
      endOffset,
      CONTENT_WIDTH,
      PROMPT_WIDTH,
    );
    expect(position.displayLineIndex).toBeGreaterThan(0);

    const action = press(value, endOffset, { leftArrow: true });
    expect(action.type).toBe('move');
    const nextPosition = mapCursorOffsetToDisplayPosition(
      value,
      action.cursorOffset ?? 0,
      CONTENT_WIDTH,
      PROMPT_WIDTH,
    );
    expect(nextPosition.displayLineIndex).toBe(position.displayLineIndex);
    expect(nextPosition.columnInLine).toBeLessThan(position.columnInLine);
  });

  it('moves right across wrapped line boundary by display column', () => {
    const value = 'abcdefghijklmnop';
    const layoutStart = mapDisplayPositionToCursorOffset(
      value,
      1,
      0,
      CONTENT_WIDTH,
      PROMPT_WIDTH,
    );
    const action = press(value, layoutStart, { rightArrow: true });
    expect(action.type).toBe('move');
    const nextPosition = mapCursorOffsetToDisplayPosition(
      value,
      action.cursorOffset ?? 0,
      CONTENT_WIDTH,
      PROMPT_WIDTH,
    );
    expect(nextPosition.displayLineIndex).toBe(1);
    expect(nextPosition.columnInLine).toBe(1);
  });

  it('home and end move within current display line', () => {
    const value = 'hello\nworld';
    const middleOffset = 8;
    const homeAction = press(value, middleOffset, { home: true });
    expect(homeAction.cursorOffset).toBe(6);

    const endAction = press(value, middleOffset, { end: true });
    expect(endAction.cursorOffset).toBe(value.length);
  });

  it('inserts newline at cursor with shift+enter', () => {
    const value = 'helloworld';
    const action = press(value, 5, { return: true, shift: true });
    expect(action.type).toBe('newline');
    expect(action.value).toBe('hello\nworld');
    expect(action.cursorOffset).toBe(6);
  });

  it('moves vertically with column clamp on shorter wrapped line', () => {
    const value = 'word '.repeat(8).trimEnd();
    const wideOffset = mapDisplayPositionToCursorOffset(
      value,
      0,
      15,
      CONTENT_WIDTH,
      PROMPT_WIDTH,
    );
    const downAction = press(value, wideOffset, { downArrow: true });
    const downPosition = mapCursorOffsetToDisplayPosition(
      value,
      downAction.cursorOffset ?? 0,
      CONTENT_WIDTH,
      PROMPT_WIDTH,
    );
    const lineWidth = downPosition.columnInLine;
    expect(lineWidth).toBeLessThanOrEqual(15);
  });

  it('moves left/right correctly with CJK characters', () => {
    const value = '日本語テスト';
    const midOffset = 3;
    const rightAction = press(value, midOffset, { rightArrow: true });
    expect(rightAction.cursorOffset).toBe(4);
    const leftAction = press(value, midOffset, { leftArrow: true });
    expect(leftAction.cursorOffset).toBe(2);
  });
});
