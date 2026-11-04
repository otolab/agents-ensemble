import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Box } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import {
  loadForkKeyboardModules,
  OperatorTextAreaKeyboardHarness,
  type ForkKeyboardModules,
} from './operator-text-area-keyboard-harness.js';
import { flushInkStdin, INK_TEST_KEYS } from './ink-test-keys.js';
import type { OperatorTextAreaProps } from './operator-text-area.js';

let modules: ForkKeyboardModules;
let value = '';
let cursor: readonly [number, number] = [0, 0];
vi.mock('./operator-text-area.js', () => ({
  OperatorTextArea: (_props: OperatorTextAreaProps) => (
    <Box height={1} overflow="hidden">
      <OperatorTextAreaKeyboardHarness
        modules={modules}
        onValueChange={(next) => { value = next; }}
        onCursorPosition={(position) => { cursor = position; }}
      />
    </Box>
  ),
}));

import { IssueSessionTui } from './issue-session-tui.js';
import { IssueSessionTuiStream } from './issue-session-tui-stream.js';
import { createTuiViewModel } from './tui-view-model.js';

beforeAll(async () => { modules = await loadForkKeyboardModules(); });
afterEach(() => cleanup());

describe.each([['pane', IssueSessionTui], ['stream', IssueSessionTuiStream]] as const)(
  '%s queue keyboard routing', (_layout, Component) => {
    it('scrolls the queue without changing a multiline textarea cursor or value', async () => {
      Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 24 });
      Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 80 });
      const viewModel = createTuiViewModel();
      value = '';
      cursor = [0, 0];
      viewModel.setOperatorContext({
        conductorTurn: 1, autonomousTurns: 0, maxTurns: 5, openQuestions: [],
        queuedMessages: Array.from({ length: 6 }, (_, index) => ({
          text: `item-${index}`, delivery: 'next' as const, openQuestionAnswer: false,
        })),
      });
      const { stdin, lastFrame } = render(<Component viewModel={viewModel} onSubmit={vi.fn()} />);
      await flushInkStdin();
      for (const key of ['one', '\x0a', 'two', '\x0a', 'six']) {
        stdin.write(key);
        await flushInkStdin();
      }
      expect(value).toBe('one\ntwo\nsix');
      expect(cursor).toEqual([2, 3]);
      expect(lastFrame()).toContain('Message queue (1-4/6)');
      if (_layout === 'stream') {
        stdin.write(INK_TEST_KEYS.ctrlPageUp);
        await flushInkStdin();
        viewModel.appendActivityLog('conductor', 'new while editing');
        await flushInkStdin();
        expect(lastFrame()).toContain('新着1 ^L');
        stdin.write('\x0c');
        await flushInkStdin();
        expect(lastFrame()).toContain('new while editing');
        expect(value).toBe('one\ntwo\nsix');
        expect(cursor).toEqual([2, 3]);
      }
      stdin.write('\x0f');
      await flushInkStdin();
      expect(lastFrame()).toContain('Message queue (2-5/6)');
      expect(value).toBe('one\ntwo\nsix');
      expect(cursor).toEqual([2, 3]);
      // Ctrl+O cycles to the beginning, even with a multiline draft.
      for (let index = 0; index < 2; index++) {
        stdin.write('\x0f');
        await flushInkStdin();
      }
      expect(lastFrame()).toContain('Message queue (1-4/6)');
      expect(value).toBe('one\ntwo\nsix');
      expect(cursor).toEqual([2, 3]);
      stdin.write('\x07');
      await flushInkStdin();
      stdin.write('X');
      await flushInkStdin();
      expect(value).toBe('one\ntwo\nsixX');
      stdin.write('\x14');
      await flushInkStdin();
      expect(lastFrame()).toContain('Message queue (1-4/6)');
      stdin.write('Y');
      await flushInkStdin();
      expect(value).toBe('one\ntwo\nsixXY');
    });
  },
);
