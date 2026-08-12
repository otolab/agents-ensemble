import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_LOG_WINDOW_SIZE,
  appendActivityLogEntry,
  formatActivityLogLine,
} from './activity-log.js';

describe('activity-log', () => {
  it('formats labeled lines', () => {
    expect(formatActivityLogLine({ label: 'operator', text: 'hello' })).toBe(
      '[operator] hello',
    );
  });

  it('windowing keeps the most recent entries', () => {
    let entries = appendActivityLogEntry([], { label: 'harness', text: 'a' }, 2);
    entries = appendActivityLogEntry(entries, { label: 'harness', text: 'b' }, 2);
    entries = appendActivityLogEntry(entries, { label: 'harness', text: 'c' }, 2);

    expect(entries).toEqual([
      { label: 'harness', text: 'b' },
      { label: 'harness', text: 'c' },
    ]);
    expect(ACTIVITY_LOG_WINDOW_SIZE).toBe(100);
  });
});
