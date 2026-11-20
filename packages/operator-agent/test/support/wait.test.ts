import { describe, expect, it, vi } from 'vitest';
import { waitForNotification, waitForSignal } from './wait.js';

describe('shared wait helpers', () => {
  it('preserves results and clears the timer after completion or rejection', async () => {
    vi.useFakeTimers();
    try {
      await expect(waitForSignal(Promise.resolve(42), 'result')).resolves.toBe(42);
      await expect(waitForNotification(Promise.reject(new Error('failed')), 'notice', 5_000)).rejects.toThrow('failed');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves each timeout and error message', async () => {
    vi.useFakeTimers();
    try {
      const signal = waitForSignal(new Promise<void>(() => {}), 'poll');
      const notification = waitForNotification(new Promise<void>(() => {}), 'ack', 5_000);
      const signalCheck = expect(signal).rejects.toThrow('poll did not complete');
      const notificationCheck = expect(notification).rejects.toThrow('ack did not arrive');
      await vi.advanceTimersByTimeAsync(2_000);
      await signalCheck;
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(3_000);
      await notificationCheck;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
