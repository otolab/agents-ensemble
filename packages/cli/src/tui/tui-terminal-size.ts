import { useEffect, useMemo, useSyncExternalStore } from 'react';

export const TUI_RESIZE_SETTLE_MS = 100;

/**
 * iTerm2 + tmux can emit separate SIGWINCH events while a pane is being
 * dragged. Keep width decreases pending for longer than the normal settle
 * window so those intermediate widths do not trigger a live-frame redraw.
 */
export const TUI_RESIZE_SHRINK_COALESCE_MS = 250;

export interface TuiTerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export interface TuiResizeSettledEvent {
  readonly previous: TuiTerminalSize;
  readonly next: TuiTerminalSize;
}

export interface TuiTerminalSizeStore {
  getSnapshot: () => TuiTerminalSize;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
}

type TuiResizeSource = Pick<NodeJS.WriteStream, 'columns' | 'rows' | 'on' | 'off'>;
type ResizeListener = () => void;

function resolveDimension(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function readTuiTerminalSize(
  stdout: Pick<NodeJS.WriteStream, 'columns' | 'rows'>,
): TuiTerminalSize {
  return {
    columns: resolveDimension(stdout.columns, 80),
    rows: resolveDimension(stdout.rows, 24),
  };
}

function sameSize(left: TuiTerminalSize, right: TuiTerminalSize): boolean {
  return left.columns === right.columns && left.rows === right.rows;
}

export function createTuiTerminalSizeStore(
  stdout: TuiResizeSource = process.stdout,
  settleMs: number = TUI_RESIZE_SETTLE_MS,
  onSettled?: (size: TuiTerminalSize) => void,
  shrinkCoalesceMs: number = TUI_RESIZE_SHRINK_COALESCE_MS,
): TuiTerminalSizeStore {
  let snapshot = readTuiTerminalSize(stdout);
  let observedSize = snapshot;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let settleMode: 'normal' | 'shrink' = 'normal';
  let disposed = false;
  const subscribers = new Set<() => void>();

  const settleResize = () => {
    settleTimer = undefined;
    if (disposed) {
      return;
    }

    const next = readTuiTerminalSize(stdout);
    if (sameSize(snapshot, next)) {
      return;
    }

    snapshot = next;
    onSettled?.(snapshot);
    for (const subscriber of [...subscribers]) {
      subscriber();
    }
  };

  const onResize = () => {
    if (disposed) {
      return;
    }

    const next = readTuiTerminalSize(stdout);
    const columnsIncreased = next.columns > observedSize.columns;
    const rowsChanged = next.rows !== observedSize.rows;
    const continuingShrink =
      settleMode === 'shrink' &&
      next.columns === observedSize.columns &&
      next.rows === snapshot.rows &&
      next.columns < snapshot.columns;
    const columnsDecreased =
      !rowsChanged &&
      !columnsIncreased &&
      (next.columns < observedSize.columns || continuingShrink);

    observedSize = next;
    settleMode = columnsDecreased ? 'shrink' : 'normal';

    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
    }
    settleTimer = setTimeout(
      settleResize,
      Math.max(0, columnsDecreased ? Math.max(settleMs, shrinkCoalesceMs) : settleMs),
    );
  };

  stdout.on('resize', onResize);

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (disposed) {
        return () => {};
      }
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      stdout.off('resize', onResize);
      if (settleTimer !== undefined) {
        clearTimeout(settleTimer);
        settleTimer = undefined;
      }
      subscribers.clear();
    },
  };
}

export interface TuiResizeController {
  readonly stdout: NodeJS.WriteStream;
  readonly terminalSize: TuiTerminalSizeStore;
  dispose: () => void;
}

/**
 * Ink listens to stdout.resize independently of React. Delay that notification
 * until the same settled snapshot used by the TUI has been rendered, so Ink
 * does not serialize an old-width frame between SIGWINCH bursts.
 *
 * Ink 7 decides whether to emit clearTerminal by comparing the previous frame
 * height with the current viewport. On a terminal shrink, that comparison can
 * classify the old frame as fullscreen even when it did not fill the old
 * viewport. Keep Ink's private viewport columns and rows at high-water marks
 * while the TUI uses the actual settled size from terminalSize; this prevents
 * the renderer's fullscreen-clear fallback and width-decrease handling from
 * erasing scrollback on shrink.
 */
export function createTuiResizeController(
  stdout: NodeJS.WriteStream = process.stdout,
  settleMs: number = TUI_RESIZE_SETTLE_MS,
  onSettled?: (event: TuiResizeSettledEvent) => void,
): TuiResizeController {
  const resizeListeners = new Set<ResizeListener>();
  let disposed = false;
  let inkViewportColumns = readTuiTerminalSize(stdout).columns;
  let inkViewportRows = readTuiTerminalSize(stdout).rows;
  let settledSize = readTuiTerminalSize(stdout);

  const terminalSize = createTuiTerminalSizeStore(stdout, settleMs, (size) => {
    if (disposed) {
      return;
    }
    const previous = settledSize;
    settledSize = size;
    // Keep Ink's width at a high-water mark while the TUI uses the settled
    // physical width. Ink's width-decrease handler clears its previous frame;
    // when that frame already wrapped at the new terminal width, its logical
    // line count can be smaller than the physical line count and push output
    // into scrollback. Grow events still raise the mark and notify Ink.
    inkViewportColumns = Math.max(inkViewportColumns, size.columns);
    inkViewportRows = Math.max(inkViewportRows, size.rows);
    onSettled?.({ previous, next: size });
    queueMicrotask(() => {
      if (disposed) {
        return;
      }
      for (const listener of [...resizeListeners]) {
        listener();
      }
    });
  });

  const resizeAwareStdout = new Proxy(stdout, {
    get(target, property, receiver) {
      if (property === 'columns' || property === 'rows') {
        return property === 'rows'
          ? inkViewportRows
          : inkViewportColumns;
      }

      if (property === 'on' || property === 'addListener') {
        return (event: string, listener: ResizeListener) => {
          if (event === 'resize') {
            resizeListeners.add(listener);
            return resizeAwareStdout;
          }
          const method = Reflect.get(target, property, target) as (
            eventName: string,
            eventListener: ResizeListener,
          ) => unknown;
          return method.call(target, event, listener);
        };
      }

      if (property === 'off' || property === 'removeListener') {
        return (event: string, listener: ResizeListener) => {
          if (event === 'resize') {
            resizeListeners.delete(listener);
            return resizeAwareStdout;
          }
          const method = Reflect.get(target, property, target) as (
            eventName: string,
            eventListener: ResizeListener,
          ) => unknown;
          return method.call(target, event, listener);
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as NodeJS.WriteStream;

  const controller: TuiResizeController = {
    stdout: resizeAwareStdout,
    terminalSize,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      terminalSize.dispose();
      resizeListeners.clear();
    },
  };

  return controller;
}

export function useTuiTerminalSize(
  externalStore?: TuiTerminalSizeStore,
): TuiTerminalSize {
  const ownedStore = useMemo(
    () => (externalStore ? undefined : createTuiTerminalSizeStore()),
    [externalStore],
  );
  const store = externalStore ?? ownedStore;

  useEffect(() => {
    if (!ownedStore) {
      return;
    }
    return () => {
      ownedStore.dispose();
    };
  }, [ownedStore]);

  if (!store) {
    throw new Error('TUI terminal size store is unavailable');
  }

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
