/**
 * ink-testing-library では `react-ink-textarea` の measureElement 連鎖が安定しないため、
 * IssueSessionTui の縦切りテストでは本番の OperatorTextArea の契約だけを再現する。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Text, useCursor, useInput, usePaste } from 'ink';
import stringWidth from 'string-width';
import type { OperatorTextAreaProps } from './operator-text-area.js';
import {
  computeOperatorInputLayout,
  logicalPositionToOffset,
  mapCursorOffsetToDisplayPosition,
  sliceVisibleInputDisplayLines,
} from './operator-input-layout.js';
import { INPUT_PANE_PROMPT_COLOR } from './tui-layout-constants.js';

export function OperatorTextArea({
  value,
  onChange,
  onSubmit,
  focus = true,
  contentWidth,
  promptPrefix = '',
  maxDisplayLines,
  onDisplayLineCountChange,
  suggestionsActive = false,
  onTab,
  cursorPosition: controlledCursorPosition,
  onCursorChange,
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
    if (controlledCursorPosition) {
      setCursorOffset(
        logicalPositionToOffset(
          value,
          controlledCursorPosition[0],
          controlledCursorPosition[1],
        ),
      );
    } else if (focus) {
      setCursorOffset((previous) => Math.min(previous, value.length));
    }
  }, [value, focus, controlledCursorPosition]);

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

  usePaste(
    (pastedText) => {
      const nextValue =
        value.slice(0, cursorOffset) + pastedText + value.slice(cursorOffset);
      const nextCursorOffset = cursorOffset + pastedText.length;
      onChange(nextValue);
      setCursorOffset(nextCursorOffset);
      onCursorChange?.(cursorPositionFor(nextValue, nextCursorOffset));
    },
    { isActive: focus },
  );

  useInput(
    (input, key) => {
      if (!focus) {
        return;
      }
      if (key.tab) {
        if (suggestionsActive) {
          onTab?.(!!key.shift);
        }
        return;
      }
      if (
        key.pageUp ||
        key.pageDown ||
        key.home ||
        key.end ||
        key.leftArrow ||
        key.rightArrow ||
        key.upArrow ||
        key.downArrow
      ) {
        if (suggestionsActive && (key.upArrow || key.downArrow)) {
          return;
        }
        const lineStart = value.lastIndexOf('\n', cursorOffset - 1) + 1;
        const lineEndIndex = value.indexOf('\n', cursorOffset);
        const lineEnd = lineEndIndex < 0 ? value.length : lineEndIndex;
        if (key.home) {
          setCursorOffset(lineStart);
          onCursorChange?.(cursorPositionFor(value, lineStart));
        } else if (key.end) {
          setCursorOffset(lineEnd);
          onCursorChange?.(cursorPositionFor(value, lineEnd));
        } else if (key.leftArrow) {
          const nextOffset = Math.max(0, cursorOffset - 1);
          setCursorOffset(nextOffset);
          onCursorChange?.(cursorPositionFor(value, nextOffset));
        } else if (key.rightArrow) {
          const nextOffset = Math.min(value.length, cursorOffset + 1);
          setCursorOffset(nextOffset);
          onCursorChange?.(cursorPositionFor(value, nextOffset));
        } else if (key.upArrow) {
          const newlineIndex = value.lastIndexOf('\n', cursorOffset - 1);
          if (newlineIndex >= 0) {
            const offsetOnPreviousLine = cursorOffset - (newlineIndex + 1);
            const previousLineStart = value.lastIndexOf('\n', newlineIndex - 1) + 1;
            const nextOffset = Math.min(
              previousLineStart + offsetOnPreviousLine,
              newlineIndex,
            );
            setCursorOffset(nextOffset);
            onCursorChange?.(cursorPositionFor(value, nextOffset));
          }
        } else if (key.downArrow) {
          const nextLineStart = value.indexOf('\n', cursorOffset);
          if (nextLineStart >= 0) {
            const nextLineEndIndex = value.indexOf('\n', nextLineStart + 1);
            const nextLineEnd = nextLineEndIndex < 0 ? value.length : nextLineEndIndex;
            const nextOffset = Math.min(
              nextLineStart + 1 + (cursorOffset - lineStart),
              nextLineEnd,
            );
            setCursorOffset(nextOffset);
            onCursorChange?.(cursorPositionFor(value, nextOffset));
          } else {
            const nextValue = `${value}\n`;
            onChange(nextValue);
            setCursorOffset(nextValue.length);
            onCursorChange?.(cursorPositionFor(nextValue, nextValue.length));
          }
        }
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
        onCursorChange?.(cursorPositionFor(nextValue, cursorOffset + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (cursorOffset <= 0) {
          return;
        }
        const nextValue = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
        onChange(nextValue);
        setCursorOffset(cursorOffset - 1);
        onCursorChange?.(cursorPositionFor(nextValue, cursorOffset - 1));
        return;
      }
      if (input) {
        const nextValue = value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
        onChange(nextValue);
        setCursorOffset(cursorOffset + input.length);
        onCursorChange?.(cursorPositionFor(nextValue, cursorOffset + input.length));
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
            {index === 0 && scrollOffset === 0 ? (
              <Text color={INPUT_PANE_PROMPT_COLOR}>{promptPrefix}</Text>
            ) : null}
            {lineText}
          </Text>
        );
      })}
    </>
  );
}

function cursorPositionFor(value: string, cursorOffset: number): [number, number] {
  const line = value.slice(0, cursorOffset).split('\n').length - 1;
  const lineStart = value.lastIndexOf('\n', cursorOffset - 1) + 1;
  return [line, cursorOffset - lineStart];
}
