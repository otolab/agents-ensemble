import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { OperatorTextArea } from './operator-text-area.js';

function Harness({ value, cursor }: { value: string; cursor: [number, number] }) {
  const [lines, setLines] = useState(1);
  return (
    <OperatorTextArea
      value={value}
      onChange={() => {}}
      contentWidth={20}
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
});
