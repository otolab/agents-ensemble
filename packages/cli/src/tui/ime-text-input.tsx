import React, { useEffect, useMemo, useState } from 'react';
import { Text, useCursor, useInput } from 'ink';
import chalk from 'chalk';
import stringWidth from 'string-width';
import {
  computeOperatorInputLayout,
  mapCursorOffsetToDisplayPosition,
  mapDisplayPositionToCursorOffset,
  sliceVisibleInputDisplayLines,
} from './operator-input-layout.js';

export interface ImeTextInputProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly focus?: boolean;
  readonly mask?: string;
  readonly highlightPastedText?: boolean;
  readonly showCursor?: boolean;
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

function renderInputLine(
  lineText: string,
  cursorOffsetInLine: number,
  showCursor: boolean,
  focus: boolean,
  mask: string | undefined,
  highlightPastedText: boolean,
  cursorWidth: number,
): string {
  const value = mask ? mask.repeat(lineText.length) : lineText;
  const cursorActualWidth = highlightPastedText ? cursorWidth : 0;

  if (!showCursor || !focus) {
    return value;
  }

  if (value.length === 0) {
    return chalk.inverse(' ');
  }

  let renderedValue = '';
  let index = 0;
  for (const char of value) {
    renderedValue +=
      index >= cursorOffsetInLine - cursorActualWidth && index <= cursorOffsetInLine
        ? chalk.inverse(char)
        : char;
    index++;
  }
  if (cursorOffsetInLine === value.length) {
    renderedValue += chalk.inverse(' ');
  }
  return renderedValue;
}

/**
 * `ink-text-input` 相当 + Ink `useCursor` による IME カーソル配置。
 * 上流 [ink-text-input#93](https://github.com/vadimdemedes/ink-text-input/pull/93) 未マージのため自前実装。
 */
export function ImeTextInput({
  value: originalValue,
  placeholder = '',
  focus = true,
  mask,
  highlightPastedText = false,
  showCursor = true,
  onChange,
  onSubmit,
  contentWidth,
  promptPrefix = '',
  maxDisplayLines,
  onDisplayLineCountChange,
  cursorStart,
}: ImeTextInputProps) {
  const [state, setState] = useState({
    cursorOffset: (originalValue || '').length,
    cursorWidth: 0,
  });

  const { cursorOffset, cursorWidth } = state;
  const { setCursorPosition } = useCursor();
  const promptWidth = stringWidth(promptPrefix);

  const layout = useMemo(
    () => computeOperatorInputLayout(originalValue, contentWidth, promptWidth),
    [originalValue, contentWidth, promptWidth],
  );
  const { visibleLines, scrollOffset } = useMemo(
    () => sliceVisibleInputDisplayLines(layout.displayLines, maxDisplayLines),
    [layout.displayLines, maxDisplayLines],
  );

  useEffect(() => {
    onDisplayLineCountChange?.(layout.displayLines.length);
  }, [layout.displayLines.length, onDisplayLineCountChange]);

  useEffect(() => {
    setState((previousState) => {
      if (!focus || !showCursor) {
        return previousState;
      }
      const newValue = originalValue || '';
      if (previousState.cursorOffset > newValue.length) {
        return {
          cursorOffset: newValue.length,
          cursorWidth: 0,
        };
      }
      return previousState;
    });
  }, [originalValue, focus, showCursor]);

  const cursorPosition = mapCursorOffsetToDisplayPosition(
    originalValue,
    cursorOffset,
    contentWidth,
    promptWidth,
  );
  const visibleCursorLineIndex = cursorPosition.displayLineIndex - scrollOffset;
  const cursorColumnInVisibleLine = cursorPosition.columnInLine;

  if (showCursor && focus && cursorStart !== undefined && visibleCursorLineIndex >= 0) {
    const contentStartX = (cursorStart.x ?? 0) - promptWidth;
    const lineStartX =
      visibleCursorLineIndex === 0 && scrollOffset === 0 ? (cursorStart.x ?? 0) : contentStartX;
    setCursorPosition({
      x: lineStartX + cursorColumnInVisibleLine,
      y: cursorStart.y + visibleCursorLineIndex,
    });
  } else {
    setCursorPosition(undefined);
  }

  useInput(
    (input, key) => {
      if ((key.ctrl && input === 'c') || key.tab || (key.shift && key.tab)) {
        return;
      }
      if (key.return && !key.shift) {
        if (onSubmit) {
          onSubmit(originalValue);
        }
        return;
      }
      if (key.return && key.shift) {
        const nextValue =
          originalValue.slice(0, cursorOffset) + '\n' + originalValue.slice(cursorOffset);
        setState({ cursorOffset: cursorOffset + 1, cursorWidth: 0 });
        onChange(nextValue);
        return;
      }

      let nextCursorOffset = cursorOffset;
      let nextValue = originalValue;
      let nextCursorWidth = 0;

      if (key.upArrow) {
        if (showCursor && cursorPosition.displayLineIndex > 0) {
          nextCursorOffset = mapDisplayPositionToCursorOffset(
            originalValue,
            cursorPosition.displayLineIndex - 1,
            cursorPosition.columnInLine,
            contentWidth,
            promptWidth,
          );
        }
      } else if (key.downArrow) {
        if (showCursor && cursorPosition.displayLineIndex < layout.displayLines.length - 1) {
          nextCursorOffset = mapDisplayPositionToCursorOffset(
            originalValue,
            cursorPosition.displayLineIndex + 1,
            cursorPosition.columnInLine,
            contentWidth,
            promptWidth,
          );
        }
      } else if (key.home) {
        if (showCursor) {
          nextCursorOffset = mapDisplayPositionToCursorOffset(
            originalValue,
            cursorPosition.displayLineIndex,
            0,
            contentWidth,
            promptWidth,
          );
        }
      } else if (key.end) {
        if (showCursor) {
          const lineText = layout.displayLines[cursorPosition.displayLineIndex] ?? '';
          nextCursorOffset = mapDisplayPositionToCursorOffset(
            originalValue,
            cursorPosition.displayLineIndex,
            stringWidth(lineText),
            contentWidth,
            promptWidth,
          );
        }
      } else if (key.leftArrow) {
        if (showCursor) {
          nextCursorOffset--;
        }
      } else if (key.rightArrow) {
        if (showCursor) {
          nextCursorOffset++;
        }
      } else if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          nextValue =
            originalValue.slice(0, cursorOffset - 1) +
            originalValue.slice(cursorOffset, originalValue.length);
          nextCursorOffset--;
        }
      } else if (input) {
        nextValue =
          originalValue.slice(0, cursorOffset) +
          input +
          originalValue.slice(cursorOffset, originalValue.length);
        nextCursorOffset += input.length;
        if (input.length > 1) {
          nextCursorWidth = input.length;
        }
      }

      if (nextCursorOffset < 0) {
        nextCursorOffset = 0;
      }
      if (nextCursorOffset > nextValue.length) {
        nextCursorOffset = nextValue.length;
      }

      setState({
        cursorOffset: nextCursorOffset,
        cursorWidth: nextCursorWidth,
      });

      if (nextValue !== originalValue) {
        onChange(nextValue);
      }
    },
    { isActive: focus },
  );

  if (originalValue.length === 0 && placeholder && !focus) {
    return <Text>{chalk.grey(placeholder)}</Text>;
  }

  if (originalValue.length === 0 && placeholder && focus && showCursor) {
    return (
      <Text>
        {chalk.inverse(placeholder[0] ?? ' ')}
        {chalk.grey(placeholder.slice(1))}
      </Text>
    );
  }

  return (
    <>
      {visibleLines.map((lineText, index) => {
        const absoluteLineIndex = scrollOffset + index;
        const isCursorLine = absoluteLineIndex === cursorPosition.displayLineIndex;
        const cursorOffsetInLine = isCursorLine
          ? cursorPosition.columnInLine
          : 0;
        const renderedLine = renderInputLine(
          lineText,
          isCursorLine ? cursorOffsetInLine : 0,
          showCursor,
          focus,
          mask,
          highlightPastedText,
          isCursorLine ? cursorWidth : 0,
        );

        return (
          <Text key={`input-line-${absoluteLineIndex}`}>
            {index === 0 && scrollOffset === 0 ? promptPrefix : ''}
            {renderedLine}
          </Text>
        );
      })}
    </>
  );
}
