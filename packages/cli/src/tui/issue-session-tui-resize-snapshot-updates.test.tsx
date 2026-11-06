import React from 'react';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./operator-text-area.js', () => import('./operator-text-area.test-double.js'));

import { cleanup, render } from 'ink-testing-library';
import type { OperatorInputContext } from '@agents-ensemble/core';
import { INITIAL_SESSION_DISPLAY_STATE } from '../display/session-display-state.js';
import { IssueSessionTui } from './issue-session-tui.js';
import { IssueSessionTuiStream } from './issue-session-tui-stream.js';
import { flushInkStdin } from './ink-test-keys.js';
import { createTuiViewModel } from './tui-view-model.js';
import { createTuiTerminalSizeStore } from './tui-terminal-size.js';
import { extractTuiPaneFrameStats } from './orchestration-pane-frame.js';
import { INPUT_PANE_TITLE } from './tui-layout-constants.js';

const layouts = [
  ['pane', IssueSessionTui],
  ['stream', IssueSessionTuiStream],
] as const;

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

    const reactError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { stdin, lastFrame, stderr } = render(
      <Component
        viewModel={viewModel}
        terminalSizeStore={terminalSizeStore}
        onSubmit={vi.fn()}
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
        expect(stderr.frames.join('')).not.toContain('Maximum update depth exceeded');
        expect(reactError.mock.calls.flat().join(' ')).not.toContain('Maximum update depth exceeded');
      }

      const wideLineCounts = inputRowsAtWidth.get(80) ?? [];
      const narrowLineCounts = inputRowsAtWidth.get(32) ?? [];
      expect(wideLineCounts).toHaveLength(2);
      expect(narrowLineCounts).toHaveLength(2);
      expect(Math.min(...narrowLineCounts)).toBeGreaterThan(Math.max(...wideLineCounts));
    } finally {
      terminalSizeStore.dispose();
    }
  });
});
