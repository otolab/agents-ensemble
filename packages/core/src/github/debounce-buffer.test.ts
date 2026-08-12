import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebounceBuffer } from './debounce-buffer.js';

describe('DebounceBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes after debounce interval', () => {
    const onFlush = vi.fn();
    const buffer = new DebounceBuffer<string>({ debounceMs: 1000, onFlush });

    buffer.push('a');
    buffer.push('b');
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(999);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledWith(['a', 'b']);
  });

  it('resets debounce timer on new items', () => {
    const onFlush = vi.fn();
    const buffer = new DebounceBuffer<string>({ debounceMs: 1000, onFlush });

    buffer.push('a');
    vi.advanceTimersByTime(800);
    buffer.push('b');
    vi.advanceTimersByTime(800);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(onFlush).toHaveBeenCalledWith(['a', 'b']);
  });

  it('flush immediately drains pending items', () => {
    const onFlush = vi.fn();
    const buffer = new DebounceBuffer<string>({ debounceMs: 1000, onFlush });

    buffer.push('only');
    buffer.flush();
    expect(onFlush).toHaveBeenCalledWith(['only']);
    expect(buffer.pendingCount).toBe(0);
  });

  it('flushes on shutdown signal abort', () => {
    const onFlush = vi.fn();
    const controller = new AbortController();
    const buffer = new DebounceBuffer<string>({
      debounceMs: 10_000,
      onFlush,
      shutdownSignal: controller.signal,
    });

    buffer.push('shutdown');
    controller.abort();
    expect(onFlush).toHaveBeenCalledWith(['shutdown']);
  });
});
