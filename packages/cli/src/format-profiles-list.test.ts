import { describe, expect, it } from 'vitest';
import { formatProfilesListJson, formatProfilesListText } from './format-profiles-list.js';

describe('formatProfilesListText', () => {
  it('formats empty list', () => {
    expect(formatProfilesListText([])).toBe('No team profiles found.');
  });

  it('formats profile entries', () => {
    const text = formatProfilesListText([
      {
        id: 'my-team@project',
        name: 'my-team',
        source: 'project',
        path: '/repo/.ensemble/teams/my-team/profile.yaml',
        meta: { title: 'My team' },
        workersPreview: ['implementer', 'reviewer'],
      },
    ]);

    expect(text).toContain('my-team@project');
    expect(text).toContain('source: project');
    expect(text).toContain('workers: implementer, reviewer');
  });
});

describe('formatProfilesListJson', () => {
  it('serializes entries as JSON', () => {
    const json = formatProfilesListJson([
      {
        id: 'default@bundled',
        name: 'implementer-and-reviewer',
        source: 'bundled',
        path: '/profiles/default/profile.yaml',
        workersPreview: ['implementer'],
      },
    ]);

    expect(JSON.parse(json)).toHaveLength(1);
  });
});
