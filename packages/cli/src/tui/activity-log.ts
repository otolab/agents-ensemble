import {
  parseInlineMarkdown,
  type InlineMarkdownSegment,
} from '../inline-markdown.js';
import { wrapInlineMarkdownToWidth } from './wrap-text-to-width.js';

export type ActivityLogLabel = 'operator' | 'harness' | 'conductor' | 'observation';

/** 活動ログ内の空行セパレータ（conductor 本文前など）。 */
export type ActivityLogSeparatorLabel = 'separator';

export type ActivityLogEntryLabel = ActivityLogLabel | ActivityLogSeparatorLabel;

export interface ActivityLogEntry {
  label: ActivityLogEntryLabel;
  text: string;
}

type ActivityLogInkColor = 'cyan' | 'yellow' | 'magenta';

/** Ink `Text` の `color`。operator は入力欄と同じデフォルト（undefined）。 */
export const ACTIVITY_LOG_LABEL_COLORS: Record<
  ActivityLogLabel,
  ActivityLogInkColor | undefined
> = {
  operator: undefined,
  conductor: 'cyan',
  harness: 'yellow',
  observation: 'magenta',
};

/** 活動ログ 1 行の表示型。折り返し 1 行は inline、2 行以上は label-row + body-row。 */
export type ActivityLogDisplayLineLayout =
  | 'separator'
  | 'inline'
  | 'label-row'
  | 'body-row';

export interface ActivityLogDisplayLine {
  label: ActivityLogEntryLabel;
  segments: InlineMarkdownSegment[];
  layout: ActivityLogDisplayLineLayout;
}

export function formatActivityLogLabelPrefix(label: ActivityLogLabel): string {
  return `[${label}] `;
}

/** メインペインのスクロール遡り用。表示行は `buildActivityLogDisplayLines` で別途展開。 */
export const ACTIVITY_LOG_WINDOW_SIZE = 300;

export type ActivityLogScrollAction = 'pageUp' | 'pageDown' | 'home' | 'end';

/** `linesFromBottom=0` が最新追従。PgUp で増加（過去へ）、End で 0 に復帰。 */
export function advanceActivityLogScrollOffset(
  linesFromBottom: number,
  action: ActivityLogScrollAction,
  pageSize: number,
  maxLinesFromBottom: number,
): number {
  switch (action) {
    case 'pageUp':
      return Math.min(linesFromBottom + pageSize, maxLinesFromBottom);
    case 'pageDown':
      return Math.max(0, linesFromBottom - pageSize);
    case 'home':
      return maxLinesFromBottom;
    case 'end':
      return 0;
  }
}

/**
 * Keeps a detached pane on the same activity line after an append.
 *
 * The offset is measured from the bottom, so newly appended display lines are
 * added to a non-zero offset. The next bounded-window maximum clamps the
 * result when the retained history or pane height limits the range.
 */
export function preserveActivityLogScrollOffset(
  linesFromBottom: number,
  previousDisplayLineCount: number,
  nextDisplayLineCount: number,
  maxLinesFromBottom: number,
): number {
  const maxOffset = Math.max(0, maxLinesFromBottom);
  const currentOffset = Math.min(Math.max(0, linesFromBottom), maxOffset);
  if (currentOffset === 0) {
    return 0;
  }

  const appendedDisplayLineCount = Math.max(
    0,
    nextDisplayLineCount - previousDisplayLineCount,
  );
  return Math.min(currentOffset + appendedDisplayLineCount, maxOffset);
}

export function appendActivityLogEntry(
  entries: ActivityLogEntry[],
  entry: ActivityLogEntry,
  windowSize: number = ACTIVITY_LOG_WINDOW_SIZE,
): ActivityLogEntry[] {
  const next = [...entries, entry];
  if (next.length <= windowSize) {
    return next;
  }
  return next.slice(-windowSize);
}

export function formatActivityLogLine(entry: ActivityLogEntry): string {
  if (entry.label === 'separator') {
    return '';
  }
  return `[${entry.label}] ${entry.text}`;
}

/** 折り返し済みの表示行に展開。1 行なら `[label] 本文`、2 行以上なら `[label]` 単独行 + 本文左端。 */
export function buildActivityLogDisplayLines(
  entries: ActivityLogEntry[],
  contentWidth: number,
): ActivityLogDisplayLine[] {
  const lines: ActivityLogDisplayLine[] = [];

  for (const entry of entries) {
    if (entry.label === 'separator') {
      lines.push({ label: 'separator', segments: [], layout: 'separator' });
      continue;
    }

    const bodyLines = wrapInlineMarkdownToWidth(
      parseInlineMarkdown(entry.text),
      contentWidth,
    );
    if (bodyLines.length <= 1) {
      lines.push({
        label: entry.label,
        segments: bodyLines[0] ?? [],
        layout: 'inline',
      });
      continue;
    }

    lines.push({ label: entry.label, segments: [], layout: 'label-row' });
    for (const bodyLine of bodyLines) {
      lines.push({
        label: entry.label,
        segments: bodyLine,
        layout: 'body-row',
      });
    }
  }

  return lines;
}

/** 表示行配列から可視範囲を切り出す。`linesFromBottom=0` が最新追従。 */
export function sliceActivityLogDisplayLines(
  lines: ActivityLogDisplayLine[],
  visibleCount: number,
  linesFromBottom: number,
): ActivityLogDisplayLine[] {
  if (lines.length === 0 || visibleCount < 1) {
    return [];
  }

  const maxOffset = Math.max(0, lines.length - visibleCount);
  const offset = Math.min(Math.max(0, linesFromBottom), maxOffset);
  const end = lines.length - offset;
  const start = Math.max(0, end - visibleCount);
  return lines.slice(start, end);
}
