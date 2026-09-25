import { describe, expect, it, vi } from 'vitest';
import {
  createTuiResizeRecovery,
  TUI_FULL_REDRAW_SEQUENCE,
} from './tui-resize-recovery.js';

describe('tui resize recovery', () => {
  it('resets the terminal and requests one activity replay for a settled shrink', () => {
    const operations: string[] = [];
    const recovery = createTuiResizeRecovery({
      clearInk: () => {
        operations.push('ink.clear');
      },
      write: (data) => {
        operations.push('write:' + data);
      },
      requestActivityLogReplay: () => {
        operations.push('activity.replay');
      },
    });

    expect(
      recovery.recover({
        previous: { columns: 120, rows: 32 },
        next: { columns: 60, rows: 32 },
      }),
    ).toBe(true);
    expect(operations).toEqual([
      'ink.clear',
      'write:' + TUI_FULL_REDRAW_SEQUENCE,
      'activity.replay',
    ]);
  });

  it('does not reset for growth, row-only changes, or after disposal', () => {
    const clearInk = vi.fn();
    const write = vi.fn();
    const requestActivityLogReplay = vi.fn();
    const recovery = createTuiResizeRecovery({
      clearInk,
      write,
      requestActivityLogReplay,
    });

    expect(
      recovery.recover({
        previous: { columns: 60, rows: 32 },
        next: { columns: 120, rows: 32 },
      }),
    ).toBe(false);
    expect(
      recovery.recover({
        previous: { columns: 60, rows: 32 },
        next: { columns: 60, rows: 12 },
      }),
    ).toBe(false);

    recovery.dispose();
    expect(
      recovery.recover({
        previous: { columns: 120, rows: 32 },
        next: { columns: 60, rows: 32 },
      }),
    ).toBe(false);
    expect(clearInk).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(requestActivityLogReplay).not.toHaveBeenCalled();
  });

  it('can be disabled for bounded pane mode', () => {
    const clearInk = vi.fn();
    const write = vi.fn();
    const requestActivityLogReplay = vi.fn();
    const recovery = createTuiResizeRecovery({
      enabled: false,
      clearInk,
      write,
      requestActivityLogReplay,
    });

    expect(
      recovery.recover({
        previous: { columns: 120, rows: 32 },
        next: { columns: 60, rows: 32 },
      }),
    ).toBe(false);
    expect(clearInk).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(requestActivityLogReplay).not.toHaveBeenCalled();
  });
});
