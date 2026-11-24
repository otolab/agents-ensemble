import React from 'react';
import { useInput } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { flushInkStdin, INK_TEST_KEYS } from './ink-test-keys.js';

afterEach(cleanup);

it.each([
  [INK_TEST_KEYS.altPageUp, 'pageUp'],
  [INK_TEST_KEYS.altPageDown, 'pageDown'],
] as const)('interprets the observed Alt page sequence as Meta + %s', async (sequence, direction) => {
  const onInput = vi.fn();
  function InputProbe() {
    useInput(onInput);
    return null;
  }
  const { stdin } = render(<InputProbe />);
  stdin.write(sequence);
  await flushInkStdin();
  expect(onInput).toHaveBeenCalledTimes(1);
  expect(onInput.mock.calls[0][1]).toMatchObject({
    meta: true,
    ctrl: false,
    [direction]: true,
  });
});
