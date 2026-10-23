import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDispatchHoldReminderMonitor,
  DEFAULT_DISPATCH_HOLD_REMINDER_MS,
  DEFAULT_DISPATCH_HOLD_REMINDER_POLL_MS,
  formatDispatchHoldReminderMessage,
} from './dispatch-hold-reminder-monitor.js';

describe('createDispatchHoldReminderMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reminds after the configured interval with the current held event count', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let hold = false;
    let heldEventCount = 0;
    const reminders: number[] = [];
    const monitor = createDispatchHoldReminderMonitor({
      getSnapshot: () => ({ hold, heldEventCount }),
      onReminder: ({ heldEventCount: count }) => reminders.push(count),
      reminderIntervalMs: 5_000,
      pollIntervalMs: 1_000,
    });

    monitor.start();
    hold = true;
    monitor.onHoldChanged(true);
    heldEventCount = 3;
    vi.advanceTimersByTime(4_999);
    expect(reminders).toEqual([]);

    heldEventCount = 4;
    vi.advanceTimersByTime(1);
    monitor.stop();

    expect(reminders).toEqual([4]);
  });

  it('repeats reminders while the same hold episode continues', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const snapshot = { hold: true, heldEventCount: 2 };
    const reminders: number[] = [];
    const monitor = createDispatchHoldReminderMonitor({
      getSnapshot: () => snapshot,
      onReminder: ({ heldEventCount }) => reminders.push(heldEventCount),
      reminderIntervalMs: 5_000,
      pollIntervalMs: 1_000,
    });

    monitor.start();
    monitor.onHoldChanged(true);
    vi.advanceTimersByTime(5_000);
    snapshot.heldEventCount = 7;
    vi.advanceTimersByTime(5_000);
    monitor.stop();

    expect(reminders).toEqual([2, 7]);
  });

  it('resets reminder timing on release and starts a new episode on re-hold', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let hold = false;
    const reminders: number[] = [];
    const monitor = createDispatchHoldReminderMonitor({
      getSnapshot: () => ({ hold, heldEventCount: 1 }),
      onReminder: ({ heldEventCount }) => reminders.push(heldEventCount),
      reminderIntervalMs: 5_000,
      pollIntervalMs: 1_000,
    });

    monitor.start();
    hold = true;
    monitor.onHoldChanged(true);
    vi.advanceTimersByTime(4_000);
    hold = false;
    monitor.onHoldChanged(false);
    vi.advanceTimersByTime(10_000);

    hold = true;
    monitor.onHoldChanged(true);
    vi.advanceTimersByTime(4_999);
    expect(reminders).toEqual([]);
    vi.advanceTimersByTime(1);
    monitor.stop();

    expect(reminders).toEqual([1]);
  });

  it('uses the documented default interval and message', () => {
    expect(DEFAULT_DISPATCH_HOLD_REMINDER_MS).toBe(1_800_000);
    expect(DEFAULT_DISPATCH_HOLD_REMINDER_POLL_MS).toBe(5_000);
    expect(formatDispatchHoldReminderMessage(3)).toContain('30 分');
    expect(formatDispatchHoldReminderMessage(3)).toContain('3 件');
    expect(formatDispatchHoldReminderMessage(3)).toContain(
      'set_dispatch_hold({ hold: false })',
    );
  });
});
