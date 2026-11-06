import React from 'react';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./operator-text-area.js', () => import('./operator-text-area.test-double.js'));

import { cleanup, render } from 'ink-testing-library';
import type { OperatorInputContext } from '@agents-ensemble/core';
import { INITIAL_SESSION_DISPLAY_STATE } from '../display/session-display-state.js';
import { IssueSessionTui } from './issue-session-tui.js';
import { IssueSessionTuiStream } from './issue-session-tui-stream.js';
import { flushInkStdin, INK_TEST_KEYS } from './ink-test-keys.js';
import { createTuiViewModel } from './tui-view-model.js';
import { createTuiTerminalSizeStore } from './tui-terminal-size.js';
import { extractTuiPaneFrameStats } from './orchestration-pane-frame.js';
import { INPUT_PANE_TITLE, OPERATOR_INPUT_PROMPT } from './tui-layout-constants.js';

const layouts = [
  ['pane', IssueSessionTui],
  ['stream', IssueSessionTuiStream],
] as const;

const firstQuestion = {
  id: 'inq-1',
  question: 'Continue?',
  responseType: 'text',
  source: 'conductor',
  status: 'open',
  askedAt: 1,
} satisfies OperatorInputContext['openQuestions'][number];

const originalQuestion = {
  id: 'inq-2',
  question: 'Choose the old option',
  responseType: 'choice',
  choices: [
    { id: 'skip', label: 'Skip' },
    { id: 'stay', label: 'Stay' },
  ],
  source: 'conductor',
  status: 'open',
  askedAt: 2,
} satisfies OperatorInputContext['openQuestions'][number];

const replacementQuestion = {
  id: 'inq-3',
  question: 'Choose the new option',
  responseType: 'choice',
  choices: [
    { id: 'safe', label: 'Safe' },
    { id: 'secure', label: 'Secure' },
  ],
  source: 'conductor',
  status: 'open',
  askedAt: 3,
} satisfies OperatorInputContext['openQuestions'][number];

class ResizeSource extends EventEmitter {
  columns = 80;
  rows = 24;
}

describe.each(layouts)('%s TUI under frequent session updates', (_layout, Component) => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps multiline input stable while terminal width and session snapshots change', async () => {
    const source = new ResizeSource();
    const terminalSizeStore = createTuiTerminalSizeStore(
      source as unknown as Pick<NodeJS.WriteStream, 'columns' | 'rows' | 'on' | 'off'>,
      0,
      undefined,
      0,
    );
    const viewModel = createTuiViewModel();
    const createContext = (): OperatorInputContext => ({
      conductorTurn: 1,
      autonomousTurns: 0,
      maxTurns: 5,
      openQuestions: [],
      queuedMessages: [],
    });
    viewModel.setOperatorContext(createContext());

    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <Component
        viewModel={viewModel}
        terminalSizeStore={terminalSizeStore}
        onSubmit={onSubmit}
      />,
    );

    try {
      const draft = 'x'.repeat(80);
      stdin.write(draft);
      await flushInkStdin();

      const inputRowsAtWidth = new Map<number, number[]>();
      for (const [resizeIndex, width] of [32, 80, 32, 80].entries()) {
        source.columns = width;
        source.emit('resize');
        await flushInkStdin();

        for (let event = 0; event < 16; event += 1) {
          viewModel.setDisplayState({
            ...INITIAL_SESSION_DISPLAY_STATE,
            conductorOutput: `resize-${resizeIndex}-event-${event}`,
          });
          viewModel.appendActivityLog('harness', `pulse-${resizeIndex}-${event}`);
          viewModel.setOperatorContext(createContext());
        }
        await flushInkStdin();

        const frame = lastFrame() ?? '';
        const stats = extractTuiPaneFrameStats(frame, INPUT_PANE_TITLE);
        const draftLineCount = stats.contentRows.filter((line) => line.includes('x')).length;
        expect(frame.split('').filter((character) => character === 'x')).toHaveLength(draft.length);
        expect(stats.titleOnBorder).toBe(true);
        inputRowsAtWidth.set(width, [...(inputRowsAtWidth.get(width) ?? []), draftLineCount]);
      }

      const wideLineCounts = inputRowsAtWidth.get(80) ?? [];
      const narrowLineCounts = inputRowsAtWidth.get(32) ?? [];
      expect(wideLineCounts).toHaveLength(2);
      expect(narrowLineCounts).toHaveLength(2);
      expect(Math.min(...narrowLineCounts)).toBeGreaterThan(Math.max(...wideLineCounts));

      const continuedDraft = `${draft}-after-resize`;
      stdin.write('-after-resize');
      await flushInkStdin(0);
      stdin.write('\r');
      await flushInkStdin(0);
      expect(onSubmit).toHaveBeenCalledWith(continuedDraft, undefined);
    } finally {
      terminalSizeStore.dispose();
    }
  });

  it('keeps same-count question replacement, suggestions, and targeted submit in sync during resize bursts', async () => {
    const source = new ResizeSource();
    const terminalSizeStore = createTuiTerminalSizeStore(
      source as unknown as Pick<NodeJS.WriteStream, 'columns' | 'rows' | 'on' | 'off'>,
      0,
      undefined,
      0,
    );
    const viewModel = createTuiViewModel();
    const createContext = (
      openQuestions: OperatorInputContext['openQuestions'],
    ): OperatorInputContext => ({
      conductorTurn: 1,
      autonomousTurns: 0,
      maxTurns: 5,
      openQuestions,
      queuedMessages: [],
    });
    viewModel.setOperatorContext(createContext([firstQuestion, originalQuestion]));

    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <Component
        viewModel={viewModel}
        terminalSizeStore={terminalSizeStore}
        onSubmit={onSubmit}
      />,
    );

    try {
      stdin.write(INK_TEST_KEYS.shiftDownArrow);
      await flushInkStdin(0);
      expect(lastFrame() ?? '').toContain('2/2');
      expect(lastFrame() ?? '').toContain('Choose the old option');

      for (const width of [32, 80]) {
        source.columns = width;
        source.emit('resize');
        await flushInkStdin(0);

        for (let event = 0; event < 16; event += 1) {
          viewModel.setDisplayState({
            ...INITIAL_SESSION_DISPLAY_STATE,
            conductorOutput: `replacement-${width}-${event}`,
          });
          viewModel.appendActivityLog('harness', `replacement-pulse-${width}-${event}`);
          // Match getContext(): new list and queue arrays, but stable entries.
          viewModel.setOperatorContext(
            createContext([firstQuestion, originalQuestion]),
          );
        }
        await flushInkStdin(0);
      }

      // The list length and selected ordinal stay the same while its question ID changes.
      viewModel.setOperatorContext(createContext([firstQuestion, replacementQuestion]));
      await flushInkStdin(0);
      expect(lastFrame() ?? '').toContain('2/2');
      expect(lastFrame() ?? '').toContain('inq-3');
      expect(lastFrame() ?? '').toContain('Choose the new option');
      expect(lastFrame() ?? '').not.toContain('Choose the old option');
      expect(lastFrame() ?? '').toContain('› safe: Safe');

      for (let event = 0; event < 32; event += 1) {
        viewModel.setDisplayState({
          ...INITIAL_SESSION_DISPLAY_STATE,
          conductorOutput: `answer-${event}`,
        });
        viewModel.appendActivityLog('harness', `answer-pulse-${event}`);
        viewModel.setOperatorContext(
          createContext([firstQuestion, replacementQuestion]),
        );
      }
      await flushInkStdin(0);
      expect(lastFrame() ?? '').toContain('› safe: Safe');

      stdin.write(INK_TEST_KEYS.downArrow);
      await flushInkStdin(0);
      expect(lastFrame() ?? '').toContain('› secure: Secure');

      // The first Enter applies the currently selected answer suggestion.
      stdin.write('\r');
      await flushInkStdin(0);
      expect(lastFrame() ?? '').toContain(`${OPERATOR_INPUT_PROMPT}secure`);
      expect(onSubmit).not.toHaveBeenCalled();

      // Further input after resize is sent to the replacement question's ID.
      stdin.write(' after resize');
      await flushInkStdin(0);
      stdin.write('\r');
      await flushInkStdin(0);
      expect(onSubmit).toHaveBeenCalledWith('secure after resize', {
        targetOpenQuestionId: replacementQuestion.id,
      });
    } finally {
      terminalSizeStore.dispose();
    }
  });
});
