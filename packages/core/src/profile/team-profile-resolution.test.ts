import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundledDefaultProfilePath, bundledProfilePath } from './profile-paths.js';
import {
  listTeamProfiles,
  resolveTeamProfilePath,
  teamProfileId,
  teamProfileRoots,
} from './team-profile-resolution.js';
import { loadProfile, resolveProfilePath } from './load-profile.js';

async function writeTeamProfile(
  teamDir: string,
  workers: string,
  meta?: string,
): Promise<void> {
  await mkdir(teamDir, { recursive: true });
  await writeFile(
    join(teamDir, 'profile.yaml'),
    `${meta ?? ''}workers:\n${workers}`,
  );
}

describe('resolveTeamProfilePath', () => {
  let repoRoot = '';
  let userEnsembleRoot = '';

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-team-profile-repo-'));
    userEnsembleRoot = await mkdtemp(join(tmpdir(), 'ensemble-team-profile-user-'));
  });

  afterEach(() => {
    repoRoot = '';
    userEnsembleRoot = '';
  });

  it('resolves project .ensemble/teams/<name>/profile.yaml first', async () => {
    await writeTeamProfile(
      join(repoRoot, '.ensemble', 'teams', 'my-team'),
      '  - name: project-worker\n    kind: implementer\n',
    );
    await writeTeamProfile(
      join(userEnsembleRoot, 'teams', 'my-team'),
      '  - name: user-worker\n    kind: implementer\n',
    );
    await writeTeamProfile(join(repoRoot, 'profiles', 'my-team'), '  - legacy\n');

    const path = resolveTeamProfilePath('my-team', { repoRoot, userEnsembleRoot });

    expect(path).toBe(join(repoRoot, '.ensemble', 'teams', 'my-team', 'profile.yaml'));
  });

  it('falls back to user ~/.ensemble/teams when project is missing', async () => {
    await writeTeamProfile(
      join(userEnsembleRoot, 'teams', 'shared-team'),
      '  - name: user-worker\n    kind: implementer\n',
    );

    const path = resolveTeamProfilePath('shared-team', { repoRoot, userEnsembleRoot });

    expect(path).toBe(join(userEnsembleRoot, 'teams', 'shared-team', 'profile.yaml'));
  });

  it('resolves bundled default alias and canonical name', () => {
    expect(resolveTeamProfilePath('default', { repoRoot })).toBe(bundledDefaultProfilePath());
    expect(resolveTeamProfilePath('implementer-and-reviewer', { repoRoot })).toBe(
      bundledDefaultProfilePath(),
    );
    expect(bundledProfilePath('default')).toBe(bundledProfilePath('implementer-and-reviewer'));
  });

  it('falls back to legacy profiles/<name>/profile.yaml', async () => {
    await writeTeamProfile(join(repoRoot, 'profiles', 'legacy-team'), '  - legacy\n');

    const path = resolveTeamProfilePath('legacy-team', { repoRoot, userEnsembleRoot });

    expect(path).toBe(join(repoRoot, 'profiles', 'legacy-team', 'profile.yaml'));
  });

  it('accepts explicit relative and absolute paths', async () => {
    const customPath = join(repoRoot, 'custom', 'profile.yaml');
    await mkdir(join(repoRoot, 'custom'), { recursive: true });
    await writeFile(customPath, 'workers: []\n');

    expect(resolveTeamProfilePath('custom/profile.yaml', { repoRoot })).toBe(customPath);
    expect(resolveTeamProfilePath(customPath, { repoRoot })).toBe(customPath);
  });

  it('prefers project over bundled and legacy for same name', async () => {
    await writeTeamProfile(
      join(repoRoot, '.ensemble', 'teams', 'dup'),
      '  - project\n',
    );
    await writeTeamProfile(join(repoRoot, 'profiles', 'dup'), '  - legacy\n');

    const path = resolveTeamProfilePath('dup', { repoRoot, userEnsembleRoot });
    expect(path).toContain('.ensemble/teams/dup');
  });
});

describe('listTeamProfiles', () => {
  let repoRoot = '';
  let userEnsembleRoot = '';

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-team-list-repo-'));
    userEnsembleRoot = await mkdtemp(join(tmpdir(), 'ensemble-team-list-user-'));
  });

  it('lists profiles from all layers with source and id', async () => {
    await writeTeamProfile(
      join(repoRoot, '.ensemble', 'teams', 'proj'),
      '  - implementer\n',
      `meta:\n  title: Project team\n`,
    );
    await writeTeamProfile(
      join(userEnsembleRoot, 'teams', 'user-team'),
      '  - reviewer\n',
    );
    await writeTeamProfile(join(repoRoot, 'profiles', 'legacy'), '  - legacy\n');

    const entries = await listTeamProfiles({ repoRoot, userEnsembleRoot });
    const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]));

    expect(byId['proj@project']).toMatchObject({
      name: 'proj',
      source: 'project',
      workersPreview: ['implementer'],
      meta: { id: 'proj', title: 'Project team' },
    });
    expect(byId['user-team@user']).toMatchObject({
      source: 'user',
      workersPreview: ['reviewer'],
    });
    expect(byId['legacy@legacy']).toMatchObject({
      source: 'legacy',
      workersPreview: ['legacy'],
    });
    expect(byId['implementer-and-reviewer@bundled']).toMatchObject({
      source: 'bundled',
      name: 'implementer-and-reviewer',
    });
  });
});

describe('teamProfileRoots', () => {
  it('returns roots in priority order', () => {
    const roots = teamProfileRoots('/repo', { userEnsembleRoot: '/home/user/.ensemble' });

    expect(roots.map((root) => root.source)).toEqual(['project', 'user', 'bundled', 'legacy']);
    expect(roots[0]?.root).toBe('/repo/.ensemble/teams');
    expect(roots[1]?.root).toBe('/home/user/.ensemble/teams');
  });
});

describe('teamProfileId', () => {
  it('normalizes default alias in id', () => {
    expect(teamProfileId('default', 'bundled')).toBe('implementer-and-reviewer@bundled');
  });
});

describe('loadProfile integration', () => {
  it('loads project team profile via resolveProfilePath', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-team-load-'));
    await writeTeamProfile(
      join(repoRoot, '.ensemble', 'teams', 'cli-team'),
      '  - name: main\n    kind: worker\n',
    );

    const { profile, profilePath } = await loadProfile({
      profile: 'cli-team',
      cwd: repoRoot,
    });

    expect(profilePath).toBe(join(repoRoot, '.ensemble', 'teams', 'cli-team', 'profile.yaml'));
    expect(profile.workers).toEqual([{ name: 'main', kind: 'worker' }]);
    expect(resolveProfilePath('cli-team', repoRoot)).toBe(profilePath);
  });
});
