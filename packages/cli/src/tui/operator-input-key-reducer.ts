import stringWidth from 'string-width';
import {
  computeOperatorInputLayout,
  mapCursorOffsetToDisplayPosition,
  mapDisplayPositionToCursorOffset,
} from './operator-input-layout.js';

export interface OperatorInputKeyState {
  readonly cursorOffset: number;
  readonly cursorWidth: number;
}

export interface OperatorInputKeyAction {
  readonly type:
    | 'move'
    | 'insert'
    | 'newline'
    | 'delete'
    | 'submit'
    | 'ignore';
  readonly cursorOffset?: number;
  readonly cursorWidth?: number;
  readonly value?: string;
}

export interface OperatorInputKeyPress {
  readonly input: string;
  readonly key: {
    readonly return?: boolean;
    readonly shift?: boolean;
    readonly upArrow?: boolean;
    readonly downArrow?: boolean;
    readonly leftArrow?: boolean;
    readonly rightArrow?: boolean;
    readonly home?: boolean;
    readonly end?: boolean;
    readonly backspace?: boolean;
    readonly delete?: boolean;
    readonly pageUp?: boolean;
    readonly pageDown?: boolean;
    readonly ctrl?: boolean;
    readonly tab?: boolean;
  };
}

function moveCursorLeft(
  value: string,
  cursorOffset: number,
  contentWidth: number,
  promptWidth: number,
): number {
  const position = mapCursorOffsetToDisplayPosition(
    value,
    cursorOffset,
    contentWidth,
    promptWidth,
  );
  const layout = computeOperatorInputLayout(value, contentWidth, promptWidth);
  const lineStart = layout.lineStartOffsets[position.displayLineIndex] ?? 0;

  if (cursorOffset > lineStart) {
    const previousOffset = cursorOffset - 1;
    const previousPosition = mapCursorOffsetToDisplayPosition(
      value,
      previousOffset,
      contentWidth,
      promptWidth,
    );
    if (previousPosition.displayLineIndex === position.displayLineIndex) {
      return previousOffset;
    }
  }

  if (position.displayLineIndex > 0) {
    const previousLine = layout.displayLines[position.displayLineIndex - 1] ?? '';
    return mapDisplayPositionToCursorOffset(
      value,
      position.displayLineIndex - 1,
      stringWidth(previousLine),
      contentWidth,
      promptWidth,
    );
  }

  return 0;
}

function moveCursorRight(
  value: string,
  cursorOffset: number,
  contentWidth: number,
  promptWidth: number,
): number {
  const position = mapCursorOffsetToDisplayPosition(
    value,
    cursorOffset,
    contentWidth,
    promptWidth,
  );
  const layout = computeOperatorInputLayout(value, contentWidth, promptWidth);
  const lineText = layout.displayLines[position.displayLineIndex] ?? '';
  const lineEnd = (layout.lineStartOffsets[position.displayLineIndex] ?? 0) + lineText.length;

  if (cursorOffset < lineEnd) {
    const nextOffset = cursorOffset + 1;
    const nextPosition = mapCursorOffsetToDisplayPosition(
      value,
      nextOffset,
      contentWidth,
      promptWidth,
    );
    if (nextPosition.displayLineIndex === position.displayLineIndex) {
      return nextOffset;
    }
  }

  if (position.displayLineIndex < layout.displayLines.length - 1) {
    return mapDisplayPositionToCursorOffset(
      value,
      position.displayLineIndex + 1,
      0,
      contentWidth,
      promptWidth,
    );
  }

  return value.length;
}

function moveCursorVertically(
  value: string,
  cursorOffset: number,
  contentWidth: number,
  promptWidth: number,
  direction: -1 | 1,
): number {
  const position = mapCursorOffsetToDisplayPosition(
    value,
    cursorOffset,
    contentWidth,
    promptWidth,
  );
  const layout = computeOperatorInputLayout(value, contentWidth, promptWidth);
  const nextLineIndex = position.displayLineIndex + direction;

  if (nextLineIndex < 0 || nextLineIndex >= layout.displayLines.length) {
    return cursorOffset;
  }

  return mapDisplayPositionToCursorOffset(
    value,
    nextLineIndex,
    position.columnInLine,
    contentWidth,
    promptWidth,
  );
}

/** `ImeTextInput` の `useInput` 分岐を React 非依存で検証可能にする。 */
export function reduceOperatorInputKeyPress(
  value: string,
  state: OperatorInputKeyState,
  press: OperatorInputKeyPress,
  options: {
    readonly contentWidth: number;
    readonly promptWidth: number;
    readonly showCursor: boolean;
  },
): OperatorInputKeyAction {
  const { key, input } = press;
  const { contentWidth, promptWidth, showCursor } = options;
  const { cursorOffset, cursorWidth } = state;

  if (
    key.pageUp ||
    key.pageDown ||
    (key.ctrl && input === 'c') ||
    key.tab ||
    (key.shift && key.tab)
  ) {
    return { type: 'ignore' };
  }

  if (key.return && !key.shift) {
    return { type: 'submit' };
  }

  if (key.return && key.shift) {
    const nextValue = value.slice(0, cursorOffset) + '\n' + value.slice(cursorOffset);
    return {
      type: 'newline',
      value: nextValue,
      cursorOffset: cursorOffset + 1,
      cursorWidth: 0,
    };
  }

  if (!showCursor) {
    return { type: 'ignore' };
  }

  if (key.upArrow) {
    return {
      type: 'move',
      cursorOffset: moveCursorVertically(value, cursorOffset, contentWidth, promptWidth, -1),
      cursorWidth: 0,
    };
  }

  if (key.downArrow) {
    return {
      type: 'move',
      cursorOffset: moveCursorVertically(value, cursorOffset, contentWidth, promptWidth, 1),
      cursorWidth: 0,
    };
  }

  if (key.home) {
    const position = mapCursorOffsetToDisplayPosition(
      value,
      cursorOffset,
      contentWidth,
      promptWidth,
    );
    return {
      type: 'move',
      cursorOffset: mapDisplayPositionToCursorOffset(
        value,
        position.displayLineIndex,
        0,
        contentWidth,
        promptWidth,
      ),
      cursorWidth: 0,
    };
  }

  if (key.end) {
    const position = mapCursorOffsetToDisplayPosition(
      value,
      cursorOffset,
      contentWidth,
      promptWidth,
    );
    const layout = computeOperatorInputLayout(value, contentWidth, promptWidth);
    const lineText = layout.displayLines[position.displayLineIndex] ?? '';
    return {
      type: 'move',
      cursorOffset: mapDisplayPositionToCursorOffset(
        value,
        position.displayLineIndex,
        stringWidth(lineText),
        contentWidth,
        promptWidth,
      ),
      cursorWidth: 0,
    };
  }

  if (key.leftArrow) {
    return {
      type: 'move',
      cursorOffset: moveCursorLeft(value, cursorOffset, contentWidth, promptWidth),
      cursorWidth: 0,
    };
  }

  if (key.rightArrow) {
    return {
      type: 'move',
      cursorOffset: moveCursorRight(value, cursorOffset, contentWidth, promptWidth),
      cursorWidth: 0,
    };
  }

  if (key.backspace || key.delete) {
    if (cursorOffset <= 0) {
      return { type: 'ignore' };
    }
    return {
      type: 'delete',
      value: value.slice(0, cursorOffset - 1) + value.slice(cursorOffset),
      cursorOffset: cursorOffset - 1,
      cursorWidth: 0,
    };
  }

  if (input) {
    const nextValue = value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
    return {
      type: 'insert',
      value: nextValue,
      cursorOffset: cursorOffset + input.length,
      cursorWidth: input.length > 1 ? input.length : 0,
    };
  }

  return { type: 'ignore' };
}
