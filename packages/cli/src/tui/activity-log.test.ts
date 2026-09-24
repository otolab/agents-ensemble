import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_LOG_LABEL_COLORS,
  ACTIVITY_LOG_WINDOW_SIZE,
  advanceActivityLogScrollOffset,
  appendActivityLogEntry,
  buildActivityLogDisplayLines,
  formatActivityLogLabelPrefix,
  formatActivityLogLine,
  preserveActivityLogScrollOffset,
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
      { label: 'conductor', segments: [{ text: 'short reply' }], layout: 'inline' },
    ]);
  });

  it('uses label-row and full-width body-row when body wraps to multiple lines', () => {
    const lines = buildActivityLogDisplayLines(
      [{ label: 'conductor', text: 'abcdefghij' }],
      4,
    );

    expect(lines).toEqual([
      { label: 'conductor', segments: [], layout: 'label-row' },
      { label: 'conductor', segments: [{ text: 'abcd' }], layout: 'body-row' },
      { label: 'conductor', segments: [{ text: 'efgh' }], layout: 'body-row' },
      { label: 'conductor', segments: [{ text: 'ij' }], layout: 'body-row' },
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
      { label: 'operator', segments: [], layout: 'label-row' },
      { label: 'operator', segments: [{ text: 'aa' }], layout: 'body-row' },
      { label: 'operator', segments: [{ text: 'bb' }], layout: 'body-row' },
      { label: 'harness', segments: [], layout: 'label-row' },
      { label: 'harness', segments: [{ text: 'cc' }], layout: 'body-row' },
      { label: 'harness', segments: [{ text: 'dd' }], layout: 'body-row' },
      { label: 'observation', segments: [], layout: 'label-row' },
      { label: 'observation', segments: [{ text: 'ee' }], layout: 'body-row' },
      { label: 'observation', segments: [{ text: 'ff' }], layout: 'body-row' },
    ]);
  });

  it('preserves blank body lines from paragraph breaks in display lines', () => {
    const lines = buildActivityLogDisplayLines(
      [{ label: 'operator', text: '段落1\n\n段落2' }],
      40,
    );

    expect(lines).toEqual([
      { label: 'operator', segments: [], layout: 'label-row' },
      { label: 'operator', segments: [{ text: '段落1' }], layout: 'body-row' },
      { label: 'operator', segments: [], layout: 'body-row' },
      { label: 'operator', segments: [{ text: '段落2' }], layout: 'body-row' },
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
      { label: 'harness', segments: [{ text: 'telemetry' }], layout: 'inline' },
      { label: 'separator', segments: [], layout: 'separator' },
      { label: 'conductor', segments: [{ text: 'reply' }], layout: 'inline' },
    ]);
  });

  it('keeps inline Markdown styles in activity display segments', () => {
    expect(
      buildActivityLogDisplayLines(
        [{ label: 'conductor', text: 'run **bold** with `code`' }],
        80,
      ),
    ).toEqual([
      {
        label: 'conductor',
        segments: [
          { text: 'run ' },
          { text: 'bold', bold: true },
          { text: ' with ' },
          { text: 'code', code: true },
        ],
        layout: 'inline',
      },
    ]);
  });

  it('preserves style when a segment crosses a wrap boundary', () => {
    expect(
      buildActivityLogDisplayLines(
        [{ label: 'conductor', text: 'aa **bbcc** dd' }],
        5,
      ),
    ).toEqual([
      { label: 'conductor', segments: [], layout: 'label-row' },
      { label: 'conductor', segments: [{ text: 'aa' }], layout: 'body-row' },
      { label: 'conductor', segments: [{ text: 'bbcc', bold: true }], layout: 'body-row' },
      { label: 'conductor', segments: [{ text: 'dd' }], layout: 'body-row' },
    ]);
  });

  it('traverses nested lists and table cells in activity entries', () => {
    const lines = buildActivityLogDisplayLines(
      [
        {
          label: 'conductor',
          text:
            '- **bold** and `code` [link](https://example.com/root)\n' +
            '  1. **nested** with **`deep`** [child](https://example.com/child)\n' +
            '     - **deepest**\n\n' +
            '| **Name** | Value |\n| --- | --- |\n| `foo` | [bar](https://example.com/bar) |',
        },
      ],
      120,
    );
    const segments = lines.flatMap((line) => line.segments);

    expect(segments).toEqual(
      expect.arrayContaining([
        { text: 'bold', bold: true },
        { text: 'code', code: true },
        { text: 'link', href: 'https://example.com/root' },
        { text: 'nested', bold: true },
        { text: 'deep', bold: true, code: true },
        { text: 'child', href: 'https://example.com/child' },
        { text: 'deepest', bold: true },
        { text: 'Name', bold: true },
        { text: 'foo', code: true },
        { text: 'bar', href: 'https://example.com/bar' },
      ]),
    );
  });

  it('keeps link style on every wrapped link fragment', () => {
    const lines = buildActivityLogDisplayLines(
      [{ label: 'conductor', text: '- [linked text](https://example.com/link)' }],
      6,
    );
    const linkSegments = lines
      .flatMap((line) => line.segments)
      .filter((segment) => segment.text.length > 0 && segment.href);

    expect(linkSegments.length).toBeGreaterThan(1);
    expect(linkSegments.every((segment) => segment.href === 'https://example.com/link')).toBe(
      true,
    );
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

  it('preserves a detached offset across wrapped and separator display lines', () => {
    const previousLines = buildActivityLogDisplayLines(
      [{ label: 'conductor', text: 'abcdefghij' }],
      4,
    );
    const nextLines = buildActivityLogDisplayLines(
      [
        { label: 'conductor', text: 'abcdefghij' },
        { label: 'separator', text: '' },
        { label: 'harness', text: 'new' },
      ],
      4,
    );

    expect(
      preserveActivityLogScrollOffset(4, previousLines.length, nextLines.length, 20),
    ).toBe(6);
  });

  it('keeps follow at the bottom and clamps detached offsets to the window', () => {
    expect(preserveActivityLogScrollOffset(0, 10, 14, 20)).toBe(0);
    expect(preserveActivityLogScrollOffset(18, 10, 15, 20)).toBe(20);
    expect(preserveActivityLogScrollOffset(18, 10, 15, 5)).toBe(5);
  });
});
