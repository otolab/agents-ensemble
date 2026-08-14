import type { TeamProfileListEntry } from '@agents-ensemble/core';

export function formatProfilesListText(entries: TeamProfileListEntry[]): string {
  if (entries.length === 0) {
    return 'No team profiles found.';
  }

  const lines = entries.map((entry) => {
    const workers =
      entry.workersPreview.length > 0 ? entry.workersPreview.join(', ') : '(no workers)';
    const title = entry.meta?.title ?? entry.name;
    return `${entry.id}\n  source: ${entry.source}\n  title: ${title}\n  workers: ${workers}\n  path: ${entry.path}`;
  });

  return lines.join('\n\n');
}

export function formatProfilesListJson(entries: TeamProfileListEntry[]): string {
  return JSON.stringify(entries, null, 2);
}
