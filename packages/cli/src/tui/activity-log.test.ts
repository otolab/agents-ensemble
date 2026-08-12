import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_LOG_LABEL_COLORS,
  ACTIVITY_LOG_WINDOW_SIZE,
  advanceActivityLogScrollOffset,
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
    expect(ACTIVITY_LOG_WINDOW_SIZE).toBe(300);
  });

  it('uses inline layout for a single wrapped body line', () => {
    const lines = buildActivityLogDisplayLines(
      [{ label: 'conductor', text: 'short reply' }],
      40,
    );

    expect(lines).toEqual([
      { label: 'conductor', text: 'short reply', layout: 'inline' },
    ]);
  });

  it('uses label-row and full-width body-row when body wraps to multiple lines', () => {
    const lines = buildActivityLogDisplayLines(
      [{ label: 'conductor', text: 'abcdefghij' }],
      4,
    );

    expect(lines).toEqual([
      { label: 'conductor', text: '', layout: 'label-row' },
      { label: 'conductor', text: 'abcd', layout: 'body-row' },
      { label: 'conductor', text: 'efgh', layout: 'body-row' },
      { label: 'conductor', text: 'ij', layout: 'body-row' },
    ]);
    expect(formatActivityLogLabelPrefix('conductor')).toBe('[conductor] ');
  });

  it('applies multi-line layout to all label kinds consistently', () => {
    const lines = buildActivityLogDisplayLines(
      [
        { label: 'operator', text: 'aa bb' },
        { label: 'harness', text: 'cc dd' },
        { label: 'observation', text: 'ee ff' },
      ],
      2,
    );

    expect(lines).toEqual([
      { label: 'operator', text: '', layout: 'label-row' },
      { label: 'operator', text: 'aa', layout: 'body-row' },
      { label: 'operator', text: 'bb', layout: 'body-row' },
      { label: 'harness', text: '', layout: 'label-row' },
      { label: 'harness', text: 'cc', layout: 'body-row' },
      { label: 'harness', text: 'dd', layout: 'body-row' },
      { label: 'observation', text: '', layout: 'label-row' },
      { label: 'observation', text: 'ee', layout: 'body-row' },
      { label: 'observation', text: 'ff', layout: 'body-row' },
    ]);
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
      { label: 'harness', text: 'telemetry', layout: 'inline' },
      { label: 'separator', text: '', layout: 'separator' },
      { label: 'conductor', text: 'reply', layout: 'inline' },
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

  it('advances scroll offset for page and edge keys', () => {
    expect(advanceActivityLogScrollOffset(0, 'pageUp', 5, 20)).toBe(5);
    expect(advanceActivityLogScrollOffset(8, 'pageDown', 5, 20)).toBe(3);
    expect(advanceActivityLogScrollOffset(3, 'home', 5, 20)).toBe(20);
    expect(advanceActivityLogScrollOffset(12, 'end', 5, 20)).toBe(0);
    expect(advanceActivityLogScrollOffset(18, 'pageUp', 5, 20)).toBe(20);
  });
});
