import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { operatorTextAreaProps } = vi.hoisted(() => ({
  operatorTextAreaProps: [] as Array<{ focus?: boolean }>,
}));

vi.mock('./operator-text-area.js', () => ({
  OperatorTextArea: (props: { focus?: boolean }) => {
    operatorTextAreaProps.push(props);
    return null;
  },
}));

import React from 'react';
import { EventEmitter } from 'node:events';
import { cleanup, render } from 'ink-testing-library';
import { IssueSessionTui } from './issue-session-tui.js';
import { IssueSessionTuiStream } from './issue-session-tui-stream.js';
import { createTuiViewModel } from './tui-view-model.js';
import { flushInkStdin } from './ink-test-keys.js';
import { createTuiTerminalSizeStore } from './tui-terminal-size.js';

class ResizeSource extends EventEmitter {
  columns = 80;
  rows = 25;
}

describe('Issue session status clock', () => {
  beforeEach(() => {
    operatorTextAreaProps.length = 0;
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 80 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 25 });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ['pane', IssueSessionTui],
    ['stream', IssueSessionTuiStream],
  ] as const)('updates elapsed seconds and releases the clock on unmount in %s mode', async (_mode, Tui) => {
    const viewModel = createTuiViewModel();
    viewModel.setConductorStatus({ text: 'clock-fixture', since: Date.now() });

    const { lastFrame, unmount } = render(
      <Tui viewModel={viewModel} onSubmit={() => {}} />,
    );
    await flushInkStdin();
    expect(lastFrame() ?? '').toContain('conductor: clock-fixture (0s)');
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushInkStdin();
    expect(lastFrame() ?? '').toContain('conductor: clock-fixture (1s)');

    viewModel.setShuttingDown(true);
    await flushInkStdin();
    expect(lastFrame() ?? '').toContain('終了しています…');
    expect(operatorTextAreaProps.at(-1)?.focus).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushInkStdin();
    expect(lastFrame() ?? '').toContain('conductor: clock-fixture (2s)');
    expect(operatorTextAreaProps.at(-1)?.focus).toBe(false);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['compact pane recovery', IssueSessionTui],
    ['stream recovery', IssueSessionTuiStream],
  ] as const)('pauses the clock while %s hides the status pane and resumes after dismissal', async (_mode, Tui) => {
    const source = new ResizeSource();
    source.columns = 40;
    source.rows = 6;
    const terminalSizeStore = createTuiTerminalSizeStore(
      source as unknown as Pick<NodeJS.WriteStream, 'columns' | 'rows' | 'on' | 'off'>,
    );
    const viewModel = createTuiViewModel();
    viewModel.setConductorStatus({ text: 'clock-fixture', since: Date.now() });
    viewModel.setRecoveryInspection({
      title: 'Recovery',
      text: 'recovery-fixture',
      sensitive: true,
    });

    const { lastFrame, unmount } = render(
      <Tui viewModel={viewModel} terminalSizeStore={terminalSizeStore} onSubmit={() => {}} />,
    );
    await flushInkStdin();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(lastFrame() ?? '').not.toContain('conductor: clock-fixture');

    source.columns = 80;
    source.rows = 25;
    source.emit('resize');
    viewModel.setRecoveryInspection(undefined);
    await flushInkStdin(150);
    expect(vi.getTimerCount()).toBe(1);
    expect(lastFrame() ?? '').toContain('conductor: clock-fixture (2s)');
    await vi.advanceTimersByTimeAsync(1_000);
    await flushInkStdin();
    expect(lastFrame() ?? '').toContain('conductor: clock-fixture (3s)');

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    terminalSizeStore.dispose();
  });
});
