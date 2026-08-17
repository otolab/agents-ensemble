import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-ink-textarea', async () => {
  const { TestTextArea } = await import('./operator-text-area.test-stub.js');
  return { TextArea: TestTextArea };
});

import React, { isValidElement, useState } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { OperatorTextArea } from './operator-text-area.js';
import { textAreaSpy } from './operator-text-area.test-stub.js';
import { flushInkStdin, INK_TEST_KEYS } from './ink-test-keys.js';
import {
  computeOperatorInputLayout,
  logicalPositionToOffset,
  mapCursorOffsetToDisplayPosition,
  sliceVisibleInputDisplayLines,
} from './operator-input-layout.js';

function ControlledInput({
  initialValue,
  contentWidth = 30,
  maxDisplayLines = 5,
  promptPrefix = '',
  onValueChange,
}: {
  readonly initialValue: string;
  readonly contentWidth?: number;
  readonly maxDisplayLines?: number;
  readonly promptPrefix?: string;
  readonly onValueChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <OperatorTextArea
      value={value}
      onChange={(nextValue) => {
        setValue(nextValue);
        onValueChange?.(nextValue);
      }}
      contentWidth={contentWidth}
      promptPrefix={promptPrefix}
      maxDisplayLines={maxDisplayLines}
    />
  );
}

describe('OperatorTextArea (production wrapper)', () => {
  beforeEach(() => {
    textAreaSpy.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('passes react-ink-textarea props for viewport and handlers', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();

    render(
      <OperatorTextArea
        value="hello"
        onChange={onChange}
        onSubmit={onSubmit}
        contentWidth={40}
        maxDisplayLines={4}
      />,
    );

    expect(textAreaSpy).toHaveBeenCalled();
    const props = textAreaSpy.mock.calls.at(-1)?.[0];
    expect(props?.viewportLines).toBe(4);
    expect(props?.initialLineCount).toBe(1);
    expect(props?.linePrefix).toBeUndefined();
    expect(props?.onChange).toBe(onChange);
    expect(props?.onSubmit).toBeTypeOf('function');
    props?.onSubmit?.('hello');
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(props?.cursorStart).toBeUndefined();
  });

  it('forwards cursorStart to TextArea when promptPrefix is set', () => {
    render(
      <OperatorTextArea
        value=""
        onChange={() => {}}
        contentWidth={40}
        promptPrefix="> "
        maxDisplayLines={4}
        cursorStart={{ x: 5, y: 20 }}
      />,
    );

    const props = textAreaSpy.mock.calls.at(-1)?.[0];
    expect(props?.cursorStart).toEqual({ x: 3, y: 20 });
    expect(props?.linePrefix).toBeTypeOf('function');

    const prefixNode = props?.linePrefix?.({
      lineNumber: 0,
      totalLines: 1,
      isActiveLine: true,
      isVirtualLine: false,
      isContinuationLine: false,
      continuationIndex: 0,
      isLastChunkOfLine: true,
    });
    expect(isValidElement(prefixNode)).toBe(true);
  });

  it('moves cursor up across explicit newlines via arrow keys', async () => {
    let latestValue = 'hello\nworld';
    const { stdin } = render(
      <ControlledInput
        initialValue={latestValue}
        onValueChange={(value) => {
          latestValue = value;
        }}
      />,
    );

    stdin.write(INK_TEST_KEYS.upArrow);
    await flushInkStdin();
    stdin.write(INK_TEST_KEYS.home);
    await flushInkStdin();
    stdin.write('X');
    await flushInkStdin();

    expect(latestValue).toBe('Xhello\nworld');
  });

  it('forwards TextArea onChange for explicit newline insertion', () => {
    const onChange = vi.fn();
    render(
      <OperatorTextArea
        value="helloworld"
        onChange={onChange}
        contentWidth={30}
        maxDisplayLines={5}
      />,
    );

    const props = textAreaSpy.mock.calls.at(-1)?.[0];
    props?.onChange?.('hello\nworld');

    expect(onChange).toHaveBeenCalledWith('hello\nworld');
  });

  it('keeps cursor line visible when scrolling past maxDisplayLines', async () => {
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

    const { stdin } = render(
      <ControlledInput
        initialValue={longValue}
        contentWidth={contentWidth}
        maxDisplayLines={maxDisplayLines}
      />,
    );

    stdin.write(INK_TEST_KEYS.home);
    await flushInkStdin();

    const { scrollOffset: topScroll } = sliceVisibleInputDisplayLines(
      layout.displayLines,
      maxDisplayLines,
      0,
    );
    expect(topScroll).toBe(0);
  });

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
});
