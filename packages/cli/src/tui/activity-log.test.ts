import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_LOG_LABEL_COLORS,
  ACTIVITY_LOG_WINDOW_SIZE,
  appendActivityLogEntry,
  buildActivityLogDisplayLines,
  formatActivityLogLabelPrefix,
  formatActivityLogLine,
  sliceActivityLogDisplayLines,
} from './activity-log.js';

describe('activity-log', () => {
  it('formats labeled lines', () => {
    expect(formatActivityLogLine({ label: 'operator', text: 'hello' })).toBe(
      '[operator] hello',
    );
    expect(formatActivityLogLine({ label: 'separator', text: '' })).toBe('');
  });

  it('assigns distinct label colors', () => {
    expect(ACTIVITY_LOG_LABEL_COLORS.conductor).toBe('cyan');
    expect(ACTIVITY_LOG_LABEL_COLORS.harness).toBe('yellow');
    expect(ACTIVITY_LOG_LABEL_COLORS.observation).toBe('magenta');
    expect(ACTIVITY_LOG_LABEL_COLORS.operator).toBeUndefined();
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

  it('builds wrapped display lines with continuation indent width', () => {
    const lines = buildActivityLogDisplayLines(
      [{ label: 'conductor', text: 'abcdefghij' }],
      4,
    );

    expect(lines).toEqual([
      { label: 'conductor', text: 'abcd', isContinuation: false },
      { label: 'conductor', text: 'efgh', isContinuation: true },
      { label: 'conductor', text: 'ij', isContinuation: true },
    ]);
    expect(formatActivityLogLabelPrefix('conductor')).toBe('[conductor] ');
  });

  it('includes separator blank lines in display lines', () => {
    const lines = buildActivityLogDisplayLines(
      [
        { label: 'harness', text: 'telemetry' },
        { label: 'separator', text: '' },
        { label: 'conductor', text: 'reply' },
      ],
      40,
    );

    expect(lines).toEqual([
      { label: 'harness', text: 'telemetry', isContinuation: false },
      { label: 'separator', text: '', isContinuation: false },
      { label: 'conductor', text: 'reply', isContinuation: false },
    ]);
  });

  it('slices display lines with bottom pinning', () => {
    const lines = buildActivityLogDisplayLines(
      [
        { label: 'operator', text: 'one' },
        { label: 'operator', text: 'two' },
        { label: 'operator', text: 'three' },
      ],
      40,
    );

    expect(sliceActivityLogDisplayLines(lines, 2, 0)).toEqual(lines.slice(-2));
    expect(sliceActivityLogDisplayLines(lines, 2, 1)).toEqual(lines.slice(0, 2));
  });
});
