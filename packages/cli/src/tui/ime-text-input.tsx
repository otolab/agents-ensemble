import React, { useEffect, useMemo, useState } from 'react';
import { Text, useCursor, useInput } from 'ink';
import chalk from 'chalk';
import stringWidth from 'string-width';
import {
  computeOperatorInputLayout,
  mapCursorOffsetToDisplayPosition,
  sliceVisibleInputDisplayLines,
} from './operator-input-layout.js';
import { reduceOperatorInputKeyPress } from './operator-input-key-reducer.js';

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

  const cursorPosition = useMemo(
    () =>
      mapCursorOffsetToDisplayPosition(
        originalValue,
        cursorOffset,
        contentWidth,
        promptWidth,
      ),
    [originalValue, cursorOffset, contentWidth, promptWidth],
  );

  const { visibleLines, scrollOffset } = useMemo(
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
      const action = reduceOperatorInputKeyPress(
        originalValue,
        { cursorOffset, cursorWidth },
        { input, key },
        { contentWidth, promptWidth, showCursor },
      );

      if (action.type === 'ignore') {
        return;
      }

      if (action.type === 'submit') {
        onSubmit?.(originalValue);
        return;
      }

      const nextCursorOffset = Math.max(
        0,
        Math.min(action.cursorOffset ?? cursorOffset, (action.value ?? originalValue).length),
      );

      setState({
        cursorOffset: nextCursorOffset,
        cursorWidth: action.cursorWidth ?? 0,
      });

      if (action.value !== undefined && action.value !== originalValue) {
        onChange(action.value);
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
