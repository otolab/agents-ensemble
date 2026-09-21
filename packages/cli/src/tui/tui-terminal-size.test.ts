import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTuiResizeController,
  createTuiTerminalSizeStore,
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
    source.rows = 20;
    source.emit('resize');
    source.columns = 40;
    source.rows = 12;
    source.emit('resize');

    expect(store.getSnapshot()).toEqual({ columns: 80, rows: 24 });
    expect(listener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TUI_RESIZE_SETTLE_MS - 1);
    expect(store.getSnapshot()).toEqual({ columns: 80, rows: 24 });
    expect(listener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(store.getSnapshot()).toEqual(sourceSize(source));
    expect(listener).toHaveBeenCalledTimes(1);

    store.dispose();
  });

  it('delays Ink resize notifications until the settled snapshot is ready', async () => {
    vi.useFakeTimers();
    const source = new FakeResizeSource();
    const controller = createTuiResizeController(
      source as unknown as NodeJS.WriteStream,
      TUI_RESIZE_SETTLE_MS,
    );
    const resizeListener = vi.fn();
    controller.stdout.on('resize', resizeListener);

    source.columns = 60;
    source.rows = 20;
    source.emit('resize');

    expect(controller.stdout.columns).toBe(80);
    expect(controller.stdout.rows).toBe(24);
    expect(resizeListener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TUI_RESIZE_SETTLE_MS);

    expect(controller.stdout.columns).toBe(60);
    expect(controller.stdout.rows).toBe(24);
    expect(resizeListener).toHaveBeenCalledTimes(1);

    source.columns = 70;
    source.rows = 30;
    source.emit('resize');
    await vi.advanceTimersByTimeAsync(TUI_RESIZE_SETTLE_MS);

    expect(controller.stdout.columns).toBe(70);
    expect(controller.stdout.rows).toBe(30);
    expect(resizeListener).toHaveBeenCalledTimes(2);

    controller.dispose();
    source.columns = 40;
    source.rows = 12;
    source.emit('resize');
    await vi.advanceTimersByTimeAsync(TUI_RESIZE_SETTLE_MS);
    expect(resizeListener).toHaveBeenCalledTimes(2);
  });
});
