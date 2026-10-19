import React, { useEffect, useState } from 'react';
import { useInput } from 'ink';
import type { TKeybindings } from 'react-ink-textarea';
import { vi } from 'vitest';

export const textAreaSpy = vi.fn();

export function TestTextArea(props: {
  readonly focus: boolean;
  readonly value: string;
  readonly onChange?: (value: string) => void;
  readonly onSubmit?: (value: string) => void;
  readonly linePrefix?: unknown;
  readonly viewportLines?: number;
  readonly initialLineCount?: number;
  readonly cursorStart?: { readonly x?: number; readonly y: number };
  readonly keybindings?: TKeybindings;
  readonly onTab?: (shift: boolean) => void;
  readonly cursorPosition?: [number, number];
  readonly onCursorChange?: (position: [number, number]) => void;
}) {
  const [cursorOffset, setCursorOffset] = useState(props.value.length);

  useEffect(() => {
    textAreaSpy(props);
  });

  useInput(
    (input, key) => {
      if (!props.focus) {
        return;
      }
      if (
        key.pageUp ||
        key.pageDown ||
        key.home ||
        key.end ||
        key.leftArrow ||
        key.rightArrow ||
        (key.upArrow && props.keybindings?.Up !== false) ||
        (key.downArrow && props.keybindings?.Down !== false)
      ) {
        if (key.home) {
          const lineStart = props.value.lastIndexOf('\n', cursorOffset - 1) + 1;
          setCursorOffset(lineStart);
        }
        if (key.upArrow) {
          const newlineIndex = props.value.lastIndexOf('\n', cursorOffset - 1);
          if (newlineIndex >= 0) {
            const offsetOnPreviousLine = cursorOffset - (newlineIndex + 1);
            const previousLineStart = props.value.lastIndexOf('\n', newlineIndex - 1) + 1;
            const nextOffset = previousLineStart + offsetOnPreviousLine;
            setCursorOffset(Math.min(nextOffset, newlineIndex));
          }
        }
        if (key.leftArrow) {
          setCursorOffset(Math.max(0, cursorOffset - 1));
        }
        return;
      }
      if (key.tab) {
        props.onTab?.(!!key.shift);
        return;
      }
      if (key.return && !key.shift) {
        props.onSubmit?.(props.value);
        return;
      }
      if (key.return && key.shift) {
        const nextValue =
          props.value.slice(0, cursorOffset) + '\n' + props.value.slice(cursorOffset);
        props.onChange?.(nextValue);
        setCursorOffset(cursorOffset + 1);
        return;
      }
      if (input) {
        const nextValue =
          props.value.slice(0, cursorOffset) + input + props.value.slice(cursorOffset);
        props.onChange?.(nextValue);
        setCursorOffset(cursorOffset + input.length);
      }
    },
    { isActive: props.focus },
  );

  useEffect(() => {
    const lineStart = props.value.lastIndexOf('\n', cursorOffset - 1) + 1;
    const line = props.value.slice(0, lineStart).split('\n').length - 1;
    const column = cursorOffset - lineStart;
    props.onCursorChange?.([line, column]);
  }, [props.value, cursorOffset, props.onCursorChange]);

  return null;
}
