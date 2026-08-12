import React, { useEffect, useState } from 'react';
import { Text, useCursor, useInput } from 'ink';
import chalk from 'chalk';
import stringWidth from 'string-width';

export interface ImeTextInputProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly focus?: boolean;
  readonly mask?: string;
  readonly highlightPastedText?: boolean;
  readonly showCursor?: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit?: (value: string) => void;
  /**
   * Ink 出力原点からの入力テキスト開始位置。IME 変換窓を実カーソルに合わせる。
   * `x` は同一行上のラベル幅（例: `operator> `）、`y` は入力テキスト行。
   */
  readonly cursorStart?: { readonly x?: number; readonly y: number };
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
  cursorStart,
}: ImeTextInputProps) {
  const [state, setState] = useState({
    cursorOffset: (originalValue || '').length,
    cursorWidth: 0,
  });

  const { cursorOffset, cursorWidth } = state;
  const { setCursorPosition } = useCursor();

  useEffect(() => {
    setState((previousState) => {
      if (!focus || !showCursor) {
        return previousState;
      }
      const newValue = originalValue || '';
      if (previousState.cursorOffset > newValue.length - 1) {
        return {
          cursorOffset: newValue.length,
          cursorWidth: 0,
        };
      }
      return previousState;
    });
  }, [originalValue, focus, showCursor]);

  const cursorActualWidth = highlightPastedText ? cursorWidth : 0;
  const value = mask ? mask.repeat(originalValue.length) : originalValue;
  let renderedValue = value;
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

  if (showCursor && focus) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(' ');
    renderedValue = value.length > 0 ? '' : chalk.inverse(' ');
    let i = 0;
    for (const char of value) {
      renderedValue +=
        i >= cursorOffset - cursorActualWidth && i <= cursorOffset
          ? chalk.inverse(char)
          : char;
      i++;
    }
    if (value.length > 0 && cursorOffset === value.length) {
      renderedValue += chalk.inverse(' ');
    }

    if (cursorStart !== undefined) {
      const textBeforeCursor = value.slice(0, cursorOffset);
      setCursorPosition({
        x: (cursorStart.x ?? 0) + stringWidth(textBeforeCursor),
        y: cursorStart.y,
      });
    }
  } else {
    setCursorPosition(undefined);
  }

  useInput(
    (input, key) => {
      if (
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && input === 'c') ||
        key.tab ||
        (key.shift && key.tab)
      ) {
        return;
      }
      if (key.return) {
        if (onSubmit) {
          onSubmit(originalValue);
        }
        return;
      }

      let nextCursorOffset = cursorOffset;
      let nextValue = originalValue;
      let nextCursorWidth = 0;

      if (key.leftArrow) {
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
      } else {
        nextValue =
          originalValue.slice(0, cursorOffset) +
          input +
          originalValue.slice(cursorOffset, originalValue.length);
        nextCursorOffset += input.length;
        if (input.length > 1) {
          nextCursorWidth = input.length;
        }
      }

      if (cursorOffset < 0) {
        nextCursorOffset = 0;
      }
      if (cursorOffset > originalValue.length) {
        nextCursorOffset = originalValue.length;
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

  return (
    <Text>
      {placeholder
        ? value.length > 0
          ? renderedValue
          : renderedPlaceholder
        : renderedValue}
    </Text>
  );
}
