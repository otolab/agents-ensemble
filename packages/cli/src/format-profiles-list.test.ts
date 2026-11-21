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
        modesStatus: 'unspecified',
        availability: 'available',
      },
    ]);

    expect(text).toContain('my-team@project');
    expect(text).toContain('source: project');
    expect(text).toContain('workers: implementer, reviewer');
    expect(text).toContain('modes: unspecified');
    expect(text).not.toContain('[unusable]');
  });

  it('distinguishes declared and invalid modes', () => {
    const entries = [
      { id: 'both@project', name: 'both', source: 'project' as const, path: '/both',
        workersPreview: [], availability: 'available' as const,
        modesStatus: 'declared' as const, meta: { modes: ['issue', 'run'] as ('issue' | 'run')[] } },
      { id: 'bad@project', name: 'bad', source: 'project' as const, path: '/bad',
        workersPreview: [], availability: 'available' as const, modesStatus: 'invalid' as const },
    ];
    const text = formatProfilesListText(entries);
    expect(text).toContain('modes: issue, run');
    expect(text).toContain('modes: invalid');
    expect(JSON.parse(formatProfilesListJson(entries))).toMatchObject([
      { modesStatus: 'declared', meta: { modes: ['issue', 'run'] } },
      { modesStatus: 'invalid' },
    ]);
  });

  it('formats unusable profile with issues', () => {
    const text = formatProfilesListText([
      {
        id: 'with-librarian@user',
        name: 'with-librarian',
        source: 'user',
        path: '/home/user/.ensemble/teams/with-librarian/profile.yaml',
        workersPreview: ['implementer', 'reviewer', 'librarian'],
        modesStatus: 'unspecified',
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
        id: 'implementer-and-reviewer@bundled',
        name: 'implementer-and-reviewer',
        source: 'bundled',
        path: '/profiles/implementer-and-reviewer/profile.yaml',
        workersPreview: ['implementer'],
        modesStatus: 'unspecified',
        availability: 'available',
      },
      {
        id: 'implementer-and-reviewer-v2@bundled',
        name: 'implementer-and-reviewer-v2',
        source: 'bundled',
        path: '/profiles/implementer-and-reviewer-v2/profile.yaml',
        workersPreview: ['implementer'],
        modesStatus: 'unspecified',
        availability: 'available',
      },
    ]);

    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].modesStatus).toBe('unspecified');
    expect(parsed.map((entry: { id: string }) => entry.id)).toEqual([
      'implementer-and-reviewer@bundled',
      'implementer-and-reviewer-v2@bundled',
    ]);
    expect(parsed.every((entry: { availability: string }) => entry.availability === 'available'))
      .toBe(true);
  });

  it('includes availability and issues in JSON output', () => {
    const json = formatProfilesListJson([
      {
        id: 'broken@project',
        name: 'broken',
        source: 'project',
        path: '/repo/.ensemble/teams/broken/profile.yaml',
        workersPreview: ['librarian'],
        modesStatus: 'unspecified',
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
