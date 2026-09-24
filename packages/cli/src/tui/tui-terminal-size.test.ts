import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render as renderInk } from 'ink';
import { IssueSessionTui } from './issue-session-tui.js';
import { createTuiViewModel } from './tui-view-model.js';
import {
  createTuiResizeController,
  createTuiTerminalSizeStore,
  TUI_RESIZE_SHRINK_COALESCE_MS,
  TUI_RESIZE_SETTLE_MS,
  type TuiTerminalSize,
} from './tui-terminal-size.js';

type ResizeSource = Pick<NodeJS.WriteStream, 'columns' | 'rows' | 'on' | 'off'>;

class FakeResizeSource extends EventEmitter {
  columns = 80;
  rows = 24;

  write() {
    return true;
  }
}

class FakeTtyStdout extends PassThrough {
  isTTY = true;
  columns = 120;
  rows = 32;
}

class FakeTtyStdin extends PassThrough {
  isTTY = true;
  isRaw = false;

  setRawMode(value: boolean) {
    this.isRaw = value;
    return this;
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sourceSize(source: FakeResizeSource): TuiTerminalSize {
  return {
    columns: source.columns,
    rows: source.rows,
  };
}

describe('tui terminal size', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('settles a burst of resize events into one shared snapshot', async () => {
    vi.useFakeTimers();
    const source = new FakeResizeSource();
    const store = createTuiTerminalSizeStore(
      source as unknown as ResizeSource,
      TUI_RESIZE_SETTLE_MS,
    );
    const listener = vi.fn();
    store.subscribe(listener);

    source.columns = 60;
    source.emit('resize');
    source.columns = 40;
    source.emit('resize');

    expect(store.getSnapshot()).toEqual({ columns: 80, rows: 24 });
    expect(listener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TUI_RESIZE_SHRINK_COALESCE_MS - 1);
    expect(store.getSnapshot()).toEqual({ columns: 80, rows: 24 });
    expect(listener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(store.getSnapshot()).toEqual(sourceSize(source));
    expect(listener).toHaveBeenCalledTimes(1);

    store.dispose();
  });

  it('keeps width increases and row changes on the normal settle window', async () => {
    vi.useFakeTimers();
    const source = new FakeResizeSource();
    const controller = createTuiResizeController(
      source as unknown as NodeJS.WriteStream,
      TUI_RESIZE_SETTLE_MS,
    );
    const resizeListener = vi.fn();
    controller.stdout.on('resize', resizeListener);

    source.columns = 120;
    source.emit('resize');

    expect(controller.stdout.columns).toBe(80);
    expect(controller.stdout.rows).toBe(24);
    expect(resizeListener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TUI_RESIZE_SETTLE_MS);

    expect(controller.stdout.columns).toBe(120);
    expect(controller.stdout.rows).toBe(24);
    expect(resizeListener).toHaveBeenCalledTimes(1);

    source.rows = 30;
    source.emit('resize');
    await vi.advanceTimersByTimeAsync(TUI_RESIZE_SETTLE_MS);

    expect(controller.stdout.columns).toBe(120);
    expect(controller.stdout.rows).toBe(30);
    expect(resizeListener).toHaveBeenCalledTimes(2);

    controller.dispose();
  });

  it('coalesces separated width decreases until the shrink window settles', async () => {
    vi.useFakeTimers();
    const source = new FakeResizeSource();
    const controller = createTuiResizeController(
      source as unknown as NodeJS.WriteStream,
      TUI_RESIZE_SETTLE_MS,
    );
    const resizeListener = vi.fn();
    controller.stdout.on('resize', resizeListener);

    source.columns = 60;
    source.emit('resize');
    await vi.advanceTimersByTimeAsync(TUI_RESIZE_SETTLE_MS);

    expect(controller.stdout.columns).toBe(80);
    expect(resizeListener).not.toHaveBeenCalled();

    source.columns = 40;
    source.emit('resize');
    await vi.advanceTimersByTimeAsync(TUI_RESIZE_SHRINK_COALESCE_MS - 1);

    expect(controller.stdout.columns).toBe(80);
    expect(resizeListener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(controller.stdout.columns).toBe(80);
    expect(controller.terminalSize.getSnapshot().columns).toBe(40);
    expect(resizeListener).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it('flushes a pending shrink through the normal path when width grows again', async () => {
    vi.useFakeTimers();
    const source = new FakeResizeSource();
    const controller = createTuiResizeController(
      source as unknown as NodeJS.WriteStream,
      TUI_RESIZE_SETTLE_MS,
    );
    const resizeListener = vi.fn();
    controller.stdout.on('resize', resizeListener);

    source.columns = 60;
    source.emit('resize');
    await vi.advanceTimersByTimeAsync(TUI_RESIZE_SETTLE_MS);
    expect(resizeListener).not.toHaveBeenCalled();

    source.columns = 90;
    source.emit('resize');
    await vi.advanceTimersByTimeAsync(TUI_RESIZE_SETTLE_MS - 1);
    expect(controller.stdout.columns).toBe(80);
    expect(resizeListener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(controller.stdout.columns).toBe(90);
    expect(resizeListener).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it('keeps a row change on the normal settle window while a shrink is pending', async () => {
    vi.useFakeTimers();
    const source = new FakeResizeSource();
    const controller = createTuiResizeController(
      source as unknown as NodeJS.WriteStream,
      TUI_RESIZE_SETTLE_MS,
    );
    const resizeListener = vi.fn();
    controller.stdout.on('resize', resizeListener);

    source.columns = 60;
    source.emit('resize');
    await vi.advanceTimersByTimeAsync(TUI_RESIZE_SETTLE_MS);
    expect(resizeListener).not.toHaveBeenCalled();

    source.rows = 20;
    source.emit('resize');
    await vi.advanceTimersByTimeAsync(TUI_RESIZE_SETTLE_MS);

    expect(controller.stdout.columns).toBe(80);
    expect(controller.stdout.rows).toBe(24);
    expect(resizeListener).toHaveBeenCalledTimes(1);
    expect(controller.terminalSize.getSnapshot()).toEqual({ columns: 60, rows: 20 });

    controller.dispose();
  });

  it('keeps the real Ink frame intact through the resize controller without clear sequences', async () => {
    const source = new FakeTtyStdout();
    const stdin = new FakeTtyStdin();
    const stderr = new PassThrough();
    const output: string[] = [];
    source.on('data', (chunk: Buffer | string) => {
      output.push(chunk.toString());
    });
    const controller = createTuiResizeController(
      source as unknown as NodeJS.WriteStream,
      TUI_RESIZE_SETTLE_MS,
    );
    const viewModel = createTuiViewModel();
    viewModel.setPostLoopWaiting(true);
    const ink = renderInk(
      React.createElement(IssueSessionTui, {
        viewModel,
        terminalSizeStore: controller.terminalSize,
        onSubmit: () => {},
      }),
      {
        stdout: controller.stdout,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
        alternateScreen: false,
        interactive: true,
        patchConsole: false,
        maxFps: 60,
      },
    );

    try {
      await ink.waitUntilRenderFlush();
      const outputLengthBeforeResize = output.length;
      source.columns = 60;
      source.rows = 12;
      source.emit('resize');
      await waitFor(TUI_RESIZE_SHRINK_COALESCE_MS + 80);
      await ink.waitUntilRenderFlush();

      const outputAfterResize = output.slice(outputLengthBeforeResize).join('');
      const outputAll = output.join('');
      expect(outputAll).not.toContain('\u001b[2J');
      expect(outputAll).not.toContain('\u001b[3J');
      expect(outputAfterResize).toContain('Workers');
      expect(outputAfterResize).toContain('Orchestration');
      expect(outputAfterResize).toContain('Operator input');
      expect(outputAfterResize).toContain('operator>');
      expect(outputAfterResize).toMatch(/╰.*╯/);
      expect(outputAfterResize).toMatch(/└.*┘/);
    } finally {
      ink.unmount();
      await ink.waitUntilExit();
      controller.dispose();
      stdin.destroy();
      stderr.destroy();
      source.destroy();
    }
  });
});
