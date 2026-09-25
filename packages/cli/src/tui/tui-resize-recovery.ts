import type { TuiResizeSettledEvent } from './tui-terminal-size.js';

/**
 * Reset the primary screen and its scrollback before Ink renders a settled
 * shrink. The activity log is replayed from the in-memory view model after
 * this sequence.
 *
 * Ink's logical line-count erasure cannot recover rows that the terminal
 * reflowed into scrollback. The stream layout opts into this recovery because
 * it retains the complete activity log; pane mode keeps its bounded-window
 * policy.
 */
export const TUI_FULL_REDRAW_SEQUENCE = '\u001b[3J\u001b[2J\u001b[H';

export interface TuiResizeRecoveryOptions {
  enabled?: boolean;
  clearInk: () => void;
  write: (data: string) => void;
  requestActivityLogReplay: () => void;
}

export interface TuiResizeRecovery {
  recover: (event: TuiResizeSettledEvent) => boolean;
  dispose: () => void;
}

export function createTuiResizeRecovery(
  options: TuiResizeRecoveryOptions,
): TuiResizeRecovery {
  let disposed = false;
  const enabled = options.enabled ?? true;

  return {
    recover(event) {
      if (
        disposed ||
        !enabled ||
        event.next.columns >= event.previous.columns
      ) {
        return false;
      }

      // Reset Ink's logical frame first. The terminal reset below then removes
      // physical rows that Ink could not count after terminal reflow.
      options.clearInk();
      options.write(TUI_FULL_REDRAW_SEQUENCE);
      options.requestActivityLogReplay();
      return true;
    },
    dispose() {
      disposed = true;
    },
  };
}
