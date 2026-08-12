export type ActivityLogLabel = 'operator' | 'harness' | 'conductor' | 'observation';

export interface ActivityLogEntry {
  label: ActivityLogLabel;
  text: string;
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
  return `[${entry.label}] ${entry.text}`;
}
