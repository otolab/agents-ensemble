import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { OperatorTextArea } from './operator-text-area.js';

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
});
