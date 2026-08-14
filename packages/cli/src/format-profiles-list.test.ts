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
        availability: 'available',
      },
    ]);

    expect(text).toContain('my-team@project');
    expect(text).toContain('source: project');
    expect(text).toContain('workers: implementer, reviewer');
    expect(text).not.toContain('[unusable]');
  });

  it('formats unusable profile with issues', () => {
    const text = formatProfilesListText([
      {
        id: 'with-librarian@user',
        name: 'with-librarian',
        source: 'user',
        path: '/home/user/.ensemble/teams/with-librarian/profile.yaml',
        workersPreview: ['implementer', 'reviewer', 'librarian'],
        availability: 'unusable',
        issues: [
          {
            worker: 'librarian',
            kind: 'librarian',
            workspace: '/path/to/missing',
            reason: 'missing',
            message: 'Worker "librarian" workspace does not exist: /path/to/missing',
          },
        ],
      },
    ]);

    expect(text).toContain('with-librarian@user  [unusable]');
    expect(text).toContain('issues:');
    expect(text).toContain('librarian: workspace does not exist: /path/to/missing');
  });
});

describe('formatProfilesListJson', () => {
  it('serializes entries as JSON', () => {
    const json = formatProfilesListJson([
      {
        id: 'default@bundled',
        name: 'implementer-and-reviewer',
        source: 'bundled',
        path: '/profiles/implementer-and-reviewer/profile.yaml',
        workersPreview: ['implementer'],
        availability: 'available',
      },
    ]);

    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].availability).toBe('available');
  });

  it('includes availability and issues in JSON output', () => {
    const json = formatProfilesListJson([
      {
        id: 'broken@project',
        name: 'broken',
        source: 'project',
        path: '/repo/.ensemble/teams/broken/profile.yaml',
        workersPreview: ['librarian'],
        availability: 'unusable',
        issues: [
          {
            worker: 'librarian',
            kind: 'librarian',
            workspace: '/missing',
            reason: 'missing',
            message: 'Worker "librarian" workspace does not exist: /missing',
          },
        ],
      },
    ]);

    const parsed = JSON.parse(json)[0];
    expect(parsed.availability).toBe('unusable');
    expect(parsed.issues).toHaveLength(1);
  });
});
