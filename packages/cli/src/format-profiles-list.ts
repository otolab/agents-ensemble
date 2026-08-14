import type { TeamProfileListEntry } from '@agents-ensemble/core';

function formatIssueLine(issue: NonNullable<TeamProfileListEntry['issues']>[number]): string {
  const detail = issue.message
    .replace(new RegExp(`^Worker "${issue.worker}" `), '')
    .replace(/^Worker /, '');
  return `    - ${issue.worker}: ${detail}`;
}

export function formatProfilesListText(entries: TeamProfileListEntry[]): string {
  if (entries.length === 0) {
    return 'No team profiles found.';
  }

  const lines = entries.map((entry) => {
    const workers =
      entry.workersPreview.length > 0 ? entry.workersPreview.join(', ') : '(no workers)';
    const title = entry.meta?.title ?? entry.name;
    const availabilitySuffix =
      entry.availability === 'unusable' ? '  [unusable]' : '';
    const issueLines =
      entry.issues && entry.issues.length > 0
        ? ['  issues:', ...entry.issues.map(formatIssueLine)]
        : [];

    return [
      `${entry.id}${availabilitySuffix}`,
      `  source: ${entry.source}`,
      `  title: ${title}`,
      `  workers: ${workers}`,
      ...issueLines,
      `  path: ${entry.path}`,
    ].join('\n');
  });

  return lines.join('\n\n');
}

export function formatProfilesListJson(entries: TeamProfileListEntry[]): string {
  return JSON.stringify(entries, null, 2);
}
