import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { OperatorTextArea } from './operator-text-area.js';
import { computeTextAreaDisplayLineCount, isCursorAtVisualBoundary } from './operator-input-layout.js';
import { loadForkKeyboardModules } from './operator-text-area-keyboard-harness.js';

function Harness({ value, cursor, width = 20 }: { value: string; cursor: [number, number]; width?: number }) {
  const [lines, setLines] = useState(1);
  return (
    <OperatorTextArea
      value={value}
      onChange={() => {}}
      contentWidth={width}
      promptPrefix="> "
      maxDisplayLines={lines}
      onDisplayLineCountChange={setLines}
      cursorPosition={cursor}
    />
  );
}

describe('OperatorTextArea convergence', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  it.each(['a'.repeat(18), 'a'.repeat(16) + 'あ'])('renders a full first row at the cursor', async (first) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const screen = render(<Harness value={`${first}\n日本語`} cursor={[0, first.length]} />);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.lastFrame()).toContain(first);
    expect(screen.lastFrame()).toContain('日本語');
    expect(errors.mock.calls.flat().join(' ')).not.toContain('Maximum update depth');
  });

  it.each([1, 2, 3, 4])('renders and settles at content width %i', async (width) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const screen = render(<Harness value="abc" cursor={[0, 3]} width={width} />);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const normalize = (frame: string | undefined) =>
      frame?.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
    const first = normalize(screen.lastFrame());
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(normalize(screen.lastFrame())).toBe(first);
    expect(first).toContain('a');
    expect(first).toContain('b');
    expect(first).toContain('c');
    screen.rerender(<Harness value="abc" cursor={[0, 0]} width={width} />);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(normalize(screen.lastFrame())).toContain('a');
    screen.rerender(<Harness value="abc" cursor={[0, 3]} width={width} />);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(normalize(screen.lastFrame())).toContain('c');
    expect(errors.mock.calls.flat().join(' ')).not.toContain('Maximum update depth');
  });

  it('matches real TextArea rows and cursor boundaries for pasted tabs', async () => {
    const { buildVisualRows } = await loadForkKeyboardModules();
    const value = 'aaaa\t';
    const count = vi.fn();
    const show = (column: number) => (
      <OperatorTextArea
        value={value}
        onChange={() => {}}
        contentWidth={10}
        promptPrefix="> "
        maxDisplayLines={2}
        cursorPosition={[0, column]}
        onDisplayLineCountChange={count}
      />
    );
    const screen = render(show(5));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const rows = buildVisualRows([value], 8, 0, 5, 1, 4) as readonly { absStart: number }[];
    expect(rows).toHaveLength(2);
    expect(count).toHaveBeenLastCalledWith(rows.length);
    expect(computeTextAreaDisplayLineCount(value, 10, 2, [0, 5], true)).toBe(rows.length);
    expect(isCursorAtVisualBoundary(value, [0, 5], 10, 2, 'up')).toBe(false);
    expect(isCursorAtVisualBoundary(value, [0, 5], 10, 2, 'down')).toBe(true);
    screen.rerender(show(4));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const movedRows = buildVisualRows([value], 8, 0, 4, 1, 4);
    expect(movedRows).toHaveLength(1);
    expect(count).toHaveBeenLastCalledWith(movedRows.length);
    expect(isCursorAtVisualBoundary(value, [0, 4], 10, 2, 'up')).toBe(true);
  });
});
