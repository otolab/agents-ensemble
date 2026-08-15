/**
 * ink-testing-library では `react-ink-textarea` の measureElement 連鎖が安定しないため、
 * IssueSessionTui の縦切りテストでは本番の OperatorTextArea の契約だけを再現する。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Text, useCursor, useInput } from 'ink';
import stringWidth from 'string-width';
import type { OperatorTextAreaProps } from './operator-text-area.js';
import {
  computeOperatorInputLayout,
  mapCursorOffsetToDisplayPosition,
  sliceVisibleInputDisplayLines,
} from './operator-input-layout.js';

export function OperatorTextArea({
  value,
  onChange,
  onSubmit,
  focus = true,
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

  const { visibleLines, scrollOffset } = useMemo(() => {
    const sliced = sliceVisibleInputDisplayLines(
      layout.displayLines,
      maxDisplayLines,
      cursorPosition.displayLineIndex,
    );
    return { visibleLines: sliced.visibleLines, scrollOffset: sliced.scrollOffset };
  }, [layout.displayLines, maxDisplayLines, cursorPosition.displayLineIndex]);

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

  if (focus && cursorStart !== undefined && visibleCursorLineIndex >= 0) {
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
      if (!focus) {
        return;
      }
      if (key.pageUp || key.pageDown || key.home || key.end || key.tab || (key.shift && key.tab)) {
        return;
      }
      if (key.return && !key.shift) {
        onSubmit?.(value);
        return;
      }
      if (key.return && key.shift) {
        const nextValue = value.slice(0, cursorOffset) + '\n' + value.slice(cursorOffset);
        onChange(nextValue);
        setCursorOffset(cursorOffset + 1);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursorOffset <= 0) {
          return;
        }
        const nextValue = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
        onChange(nextValue);
        setCursorOffset(cursorOffset - 1);
        return;
      }
      if (input) {
        const nextValue = value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
        onChange(nextValue);
        setCursorOffset(cursorOffset + input.length);
      }
    },
    { isActive: focus },
  );

  return (
    <>
      {visibleLines.map((lineText, index) => {
        const absoluteLineIndex = scrollOffset + index;
        return (
          <Text key={`input-line-${absoluteLineIndex}`}>
            {index === 0 && scrollOffset === 0 ? promptPrefix : ''}
            {lineText}
          </Text>
        );
      })}
    </>
  );
}
