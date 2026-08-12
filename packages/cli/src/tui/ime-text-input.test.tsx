import { afterEach, describe, expect, it } from 'vitest';
import React, { useState } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { ImeTextInput } from './ime-text-input.js';
import { flushInkStdin, INK_TEST_KEYS } from './ink-test-keys.js';
import {
  computeOperatorInputLayout,
  sliceVisibleInputDisplayLines,
} from './operator-input-layout.js';

function ControlledInput({
  initialValue,
  contentWidth = 30,
  maxDisplayLines = 5,
  onValueChange,
}: {
  readonly initialValue: string;
  readonly contentWidth?: number;
  readonly maxDisplayLines?: number;
  readonly onValueChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <ImeTextInput
      value={value}
      onChange={(nextValue) => {
        setValue(nextValue);
        onValueChange?.(nextValue);
      }}
      contentWidth={contentWidth}
      promptPrefix=""
      maxDisplayLines={maxDisplayLines}
    />
  );
}

describe('ImeTextInput', () => {
  afterEach(() => {
    cleanup();
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

  it('inserts newline with shift+enter', async () => {
    let latestValue = 'helloworld';
    const { stdin } = render(
      <ControlledInput
        initialValue={latestValue}
        onValueChange={(value) => {
          latestValue = value;
        }}
      />,
    );

    for (let index = 0; index < 5; index++) {
      stdin.write(INK_TEST_KEYS.leftArrow);
      await flushInkStdin();
    }
    stdin.write(INK_TEST_KEYS.shiftEnter);
    await flushInkStdin();

    expect(latestValue).toBe('hello\nworld');
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
});
