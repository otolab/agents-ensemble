import { wrapTextToWidth } from './wrap-text-to-width.js';

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
  text: string;
  layout: ActivityLogDisplayLineLayout;
}

export function formatActivityLogLabelPrefix(label: ActivityLogLabel): string {
  return `[${label}] `;
}

export const ACTIVITY_LOG_WINDOW_SIZE = 100;

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
      lines.push({ label: 'separator', text: '', layout: 'separator' });
      continue;
    }

    const bodyLines = wrapTextToWidth(entry.text, contentWidth);
    if (bodyLines.length <= 1) {
      lines.push({
        label: entry.label,
        text: bodyLines[0] ?? '',
        layout: 'inline',
      });
      continue;
    }

    lines.push({ label: entry.label, text: '', layout: 'label-row' });
    for (const bodyLine of bodyLines) {
      lines.push({
        label: entry.label,
        text: bodyLine,
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
