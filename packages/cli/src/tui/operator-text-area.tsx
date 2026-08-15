import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Box, useCursor } from 'ink';
import stringWidth from 'string-width';
import { TextArea, type TLinePrefixProps } from 'react-ink-textarea';
import {
  computeOperatorInputLayout,
  mapCursorOffsetToDisplayPosition,
  sliceVisibleInputDisplayLines,
} from './operator-input-layout.js';

export interface OperatorTextAreaProps {
  readonly value: string;
  readonly focus?: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit?: (value: string) => void;
  /** ペイン内コンテンツ幅（折り返し計算用）。 */
  readonly contentWidth: number;
  /** 1 行目先頭のプロンプト（例: `operator> `）。 */
  readonly promptPrefix?: string;
  /** 入力欄に表示できる最大行数（末尾追従）。 */
  readonly maxDisplayLines: number;
  readonly onDisplayLineCountChange?: (lineCount: number) => void;
  /**
   * Ink 出力原点からの入力テキスト開始位置。IME 変換窓を実カーソルに合わせる。
   * `x` は同一行上のラベル幅（例: `operator> `）、`y` は入力テキスト 1 行目。
   */
  readonly cursorStart?: { readonly x?: number; readonly y: number };
}

function logicalPositionToOffset(value: string, line: number, column: number): number {
  const lines = value.split('\n');
  let offset = 0;
  for (let index = 0; index < line; index++) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return offset + column;
}

/**
 * `react-ink-textarea` ベースのオペレータ入力欄。
 * Ink `useCursor` + `string-width` で CJK IME 変換窓を物理カーソルに同期する。
 */
export function OperatorTextArea({
  value,
  focus = true,
  onChange,
  onSubmit,
  contentWidth,
  promptPrefix = '',
  maxDisplayLines,
  onDisplayLineCountChange,
  cursorStart,
}: OperatorTextAreaProps) {
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const { setCursorPosition } = useCursor();
  const promptWidth = stringWidth(promptPrefix);

  const layout = useMemo(
    () => computeOperatorInputLayout(value, contentWidth, promptWidth),
    [value, contentWidth, promptWidth],
  );

  const cursorPosition = useMemo(
    () => mapCursorOffsetToDisplayPosition(value, cursorOffset, contentWidth, promptWidth),
    [value, cursorOffset, contentWidth, promptWidth],
  );

  const { scrollOffset } = useMemo(
    () =>
      sliceVisibleInputDisplayLines(
        layout.displayLines,
        maxDisplayLines,
        cursorPosition.displayLineIndex,
      ),
    [layout.displayLines, maxDisplayLines, cursorPosition.displayLineIndex],
  );

  useEffect(() => {
    onDisplayLineCountChange?.(layout.displayLines.length);
  }, [layout.displayLines.length, onDisplayLineCountChange]);

  useEffect(() => {
    if (focus) {
      setCursorOffset((previous) => Math.min(previous, value.length));
    }
  }, [value, focus]);

  const visibleCursorLineIndex = cursorPosition.displayLineIndex - scrollOffset;
  const cursorColumnInVisibleLine = cursorPosition.columnInLine;

  useLayoutEffect(() => {
    if (!focus || cursorStart === undefined || visibleCursorLineIndex < 0) {
      setCursorPosition(undefined);
      return;
    }
    const contentStartX = (cursorStart.x ?? 0) - promptWidth;
    const lineStartX =
      visibleCursorLineIndex === 0 && scrollOffset === 0 ? (cursorStart.x ?? 0) : contentStartX;
    setCursorPosition({
      x: lineStartX + cursorColumnInVisibleLine,
      y: cursorStart.y + visibleCursorLineIndex,
    });
  }, [
    focus,
    cursorStart,
    promptWidth,
    scrollOffset,
    visibleCursorLineIndex,
    cursorColumnInVisibleLine,
    setCursorPosition,
  ]);

  const handleCursorChange = useCallback(
    (position: [number, number]) => {
      setCursorOffset(logicalPositionToOffset(value, position[0], position[1]));
    },
    [value],
  );

  const linePrefix = useCallback(
    ({ lineNumber, isContinuationLine }: TLinePrefixProps) => {
      if (lineNumber === 0 && !isContinuationLine && promptPrefix.length > 0) {
        return promptPrefix;
      }
      return '';
    },
    [promptPrefix],
  );

  return (
    <Box width={contentWidth} flexDirection="column">
      <TextArea
        focus={focus}
        value={value}
        onChange={onChange}
        onSubmit={(submitted) => onSubmit?.(submitted)}
        onCursorChange={(position) => handleCursorChange(position)}
        linePrefix={promptPrefix ? linePrefix : undefined}
        viewportLines={maxDisplayLines}
        initialLineCount={1}
      />
    </Box>
  );
}
