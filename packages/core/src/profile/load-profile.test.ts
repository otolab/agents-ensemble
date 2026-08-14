import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bundledDefaultProfilePath,
  bundledProfilePath,
  ENSEMBLE_DEFAULT_PROFILE_ENV,
  loadProfile,
  loadProfileFromFile,
  profileDirectoryPath,
  resolveDefaultProfilePath,
  resolveProfilePath,
  resolveProfileRef,
} from './load-profile.js';
import {
  normalizeProfileWorker,
  profileWorkersToSessionSpecs,
  resolveAgentPromptModule,
} from './types.js';
import { compileConductorSystemPrompt } from '../prompt/compile-system-prompt.js';

describe('normalizeProfileWorker', () => {
  it('expands kind string to name=kind', () => {
    expect(normalizeProfileWorker('ping', 'test', 0)).toEqual({
      name: 'ping',
      kind: 'ping',
    });
  });

  it('uses explicit name and kind', () => {
    expect(normalizeProfileWorker({ name: 'main', kind: 'worker' }, 'test', 0)).toEqual({
      name: 'main',
      kind: 'worker',
    });
  });

  it('defaults name to kind when name omitted', () => {
    expect(normalizeProfileWorker({ kind: 'worker' }, 'test', 0)).toEqual({
      name: 'worker',
      kind: 'worker',
    });
  });
});

describe('loadProfileFromFile', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ensemble-profile-'));
  });

  afterEach(async () => {
    dir = '';
  });

  it('loads workers and agents from profile YAML', async () => {
    const path = join(dir, 'profile.yaml');
    await writeFile(
      path,
      `workers:
  - name: ping-1
    kind: ping
agents:
  ping:
    prompt:
      instructions:
        - pong only
materials:
  - id: flow
    title: Flow
    content: step 1
`,
    );

    const profile = await loadProfileFromFile(path);

    expect(profile.workers).toEqual([{ name: 'ping-1', kind: 'ping' }]);
    expect(profile.agents?.ping?.prompt?.instructions).toEqual(['pong only']);
    expect(profile.materials?.[0]?.content).toBe('step 1');
  });

  it('accepts kind-only shorthand', async () => {
    const path = join(dir, 'profile.yaml');
    await writeFile(path, 'workers:\n  - ping\n');

    const profile = await loadProfileFromFile(path);

    expect(profile.workers).toEqual([{ name: 'ping', kind: 'ping' }]);
  });

  it('resolves worker workspace paths from profile and repo root', async () => {
    const repoRoot = join(dir, 'repo');
    const profileDir = join(repoRoot, 'profiles', 'team');
    const docsDir = join(repoRoot, 'docs-repo');
    await mkdir(docsDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, 'profile.yaml'),
      `workers:
  - name: implementer
    kind: implementer
  - name: librarian
    kind: librarian
    workspace: docs-repo
  - name: local
    kind: librarian
    workspace: ../../docs-repo
`,
    );

    const profile = await loadProfileFromFile(join(profileDir, 'profile.yaml'), {
      repoRoot,
    });

    expect(profile.workers[0]).toEqual({
      name: 'implementer',
      kind: 'implementer',
    });
    expect(profile.workers[1]?.resolvedWorkspacePath).toBe(docsDir);
    expect(profile.workers[2]?.resolvedWorkspacePath).toBe(docsDir);
  });

  it('rejects duplicate worker names', async () => {
    const path = join(dir, 'profile.yaml');
    await writeFile(
      path,
      `workers:
  - name: same
    kind: ping
  - name: same
    kind: worker
`,
    );

    await expect(loadProfileFromFile(path)).rejects.toThrow(/duplicate worker name/);
  });

  it('loads material from file relative to profile directory', async () => {
    const profileDir = join(dir, 'profiles', 'sample');
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'notes.md'), 'from file\n');
    await writeFile(
      join(profileDir, 'profile.yaml'),
      `workers: []
materials:
  - id: notes
    file: notes.md
`,
    );

    const profile = await loadProfileFromFile(join(profileDir, 'profile.yaml'));

    expect(profile.materials?.[0]?.content).toBe('from file\n');
  });

  it('loads agent prompt from promptFile', async () => {
    const profileDir = join(dir, 'profiles', 'worker');
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, 'prompt.yaml'),
      `instructions:
  - worker prompt
`,
    );
    await writeFile(
      join(profileDir, 'profile.yaml'),
      `workers:
  - main
agents:
  worker:
    promptFile: prompt.yaml
`,
    );

    const profile = await loadProfileFromFile(join(profileDir, 'profile.yaml'));

    expect(profile.agents?.worker?.prompt?.instructions).toEqual(['worker prompt']);
    expect(profile.workers).toEqual([{ name: 'main', kind: 'main' }]);
  });

  it('rejects legacy systemPrompt fields', async () => {
    const path = join(dir, 'profile.yaml');
    await writeFile(
      path,
      `workers: []
agents:
  ping:
    systemPrompt: legacy
`,
    );

    await expect(loadProfileFromFile(path)).rejects.toThrow(/systemPrompt/);
  });

  it('rejects legacy systemPromptFile fields', async () => {
    const profileDir = join(dir, 'profiles', 'legacy-file');
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'prompt.md'), 'legacy\n');
    await writeFile(
      join(profileDir, 'profile.yaml'),
      `workers: []
agents:
  worker:
    systemPromptFile: prompt.md
`,
    );

    await expect(loadProfileFromFile(join(profileDir, 'profile.yaml'))).rejects.toThrow(
      /systemPrompt/,
    );
  });

  it('rejects agent with both prompt and promptFile', async () => {
    const path = join(dir, 'profile.yaml');
    await writeFile(
      path,
      `workers: []
agents:
  ping:
    prompt:
      instructions:
        - pong
    promptFile: prompt.yaml
`,
    );

    await expect(loadProfileFromFile(path)).rejects.toThrow(/prompt or promptFile/);
  });

  it('rejects material with both content and file', async () => {
    const path = join(dir, 'bad.yaml');
    await writeFile(
      path,
      `workers: []
materials:
  - content: inline
    file: x.md
`,
    );

    await expect(loadProfileFromFile(path)).rejects.toThrow(/content or file/);
  });
});

describe('profileWorkersToSessionSpecs', () => {
  it('resolves agent prompt modules by kind', () => {
    const specs = profileWorkersToSessionSpecs({
      workers: [
        { name: 'ping-1', kind: 'ping' },
        { name: 'main', kind: 'other' },
      ],
      agents: {
        ping: { prompt: { instructions: ['pong'] } },
        default: { prompt: { instructions: ['fallback'] } },
      },
    });

    expect(specs).toEqual([
      { name: 'ping-1', kind: 'ping', prompt: { instructions: ['pong'] } },
      { name: 'main', kind: 'other', prompt: { instructions: ['fallback'] } },
    ]);
  });

  it('uses undefined prompt when no agent definition exists', () => {
    expect(resolveAgentPromptModule('worker', undefined)).toBeUndefined();
  });
});

describe('resolveProfilePath', () => {
  it('resolves default alias to bundled implementer-and-reviewer profile', () => {
    expect(resolveProfilePath('default', '/repo')).toBe(bundledDefaultProfilePath());
    expect(resolveProfilePath('implementer-and-reviewer', '/repo')).toBe(
      bundledDefaultProfilePath(),
    );
  });

  it('resolves profile name to bundled profiles/<name>/profile.yaml', () => {
    expect(resolveProfilePath('default', '/repo')).toBe(bundledProfilePath('default'));
  });

  it('accepts explicit relative path', () => {
    expect(resolveProfilePath('profiles/custom/profile.yaml', '/repo')).toBe(
      '/repo/profiles/custom/profile.yaml',
    );
  });

  it('falls back to cwd profiles/<name> when not bundled', () => {
    expect(resolveProfilePath('custom-only', '/repo')).toBe(
      '/repo/profiles/custom-only/profile.yaml',
    );
  });
});

describe('resolveProfileRef', () => {
  it('prefers CLI profile over env', () => {
    expect(
      resolveProfileRef({
        profile: 'cli-profile',
        env: { [ENSEMBLE_DEFAULT_PROFILE_ENV]: 'env-profile' },
      }),
    ).toBe('cli-profile');
  });

  it('uses env when CLI profile is omitted', () => {
    expect(
      resolveProfileRef({
        env: { [ENSEMBLE_DEFAULT_PROFILE_ENV]: 'env-profile' },
      }),
    ).toBe('env-profile');
  });

  it('treats empty env as unset', () => {
    expect(
      resolveProfileRef({
        env: { [ENSEMBLE_DEFAULT_PROFILE_ENV]: '   ' },
      }),
    ).toBeUndefined();
  });

  it('trims whitespace from profile and env values', () => {
    expect(
      resolveProfileRef({
        profile: '  custom  ',
      }),
    ).toBe('custom');
    expect(
      resolveProfileRef({
        env: { [ENSEMBLE_DEFAULT_PROFILE_ENV]: '  my-team  ' },
      }),
    ).toBe('my-team');
  });
});

describe('resolveDefaultProfilePath', () => {
  it('returns bundled default profile', () => {
    expect(resolveDefaultProfilePath()).toBe(bundledDefaultProfilePath());
  });
});

describe('loadProfile', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('loads bundled default when profile is omitted', async () => {
    const { profile, profilePath } = await loadProfile({
      cwd: '/no-such-cwd',
      env: {},
    });

    expect(profilePath).toBe(bundledDefaultProfilePath());
    expect(profile.workers.length).toBeGreaterThan(0);
    expect(resolveAgentPromptModule('conductor', profile.agents)?.persona?.[0]).toContain(
      'conductor',
    );
  });

  it('loads project-local profile when name is not bundled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ensemble-profile-load-'));
    const profileDir = join(dir, 'profiles', 'custom');
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, 'profile.yaml'),
      `workers:
  - name: main
    kind: worker
`,
    );

    const { profile, profilePath } = await loadProfile({
      profile: 'custom',
      cwd: dir,
    });

    expect(profilePath).toBe(profileDirectoryPath(dir, 'custom'));
    expect(profile.workers).toEqual([{ name: 'main', kind: 'worker' }]);
  });

  it('loads profile from ENSEMBLE_DEFAULT_PROFILE when CLI profile is omitted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ensemble-profile-env-'));
    const profileDir = join(dir, 'profiles', 'env-team');
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, 'profile.yaml'),
      `workers:
  - name: env-worker
    kind: worker
`,
    );

    const { profile, profilePath } = await loadProfile({
      cwd: dir,
      env: { [ENSEMBLE_DEFAULT_PROFILE_ENV]: 'env-team' },
    });

    expect(profilePath).toBe(profileDirectoryPath(dir, 'env-team'));
    expect(profile.workers).toEqual([{ name: 'env-worker', kind: 'worker' }]);
  });

  it('prefers CLI profile over ENSEMBLE_DEFAULT_PROFILE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ensemble-profile-env-cli-'));
    const cliDir = join(dir, 'profiles', 'cli-team');
    const envDir = join(dir, 'profiles', 'env-team');
    await mkdir(cliDir, { recursive: true });
    await mkdir(envDir, { recursive: true });
    await writeFile(
      join(cliDir, 'profile.yaml'),
      `workers:
  - name: cli-worker
    kind: worker
`,
    );
    await writeFile(
      join(envDir, 'profile.yaml'),
      `workers:
  - name: env-worker
    kind: worker
`,
    );

    const { profile, profilePath } = await loadProfile({
      profile: 'cli-team',
      cwd: dir,
      env: { [ENSEMBLE_DEFAULT_PROFILE_ENV]: 'env-team' },
    });

    expect(profilePath).toBe(profileDirectoryPath(dir, 'cli-team'));
    expect(profile.workers).toEqual([{ name: 'cli-worker', kind: 'worker' }]);
  });

  it('loads profile from ENSEMBLE_DEFAULT_PROFILE path ref', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ensemble-profile-env-path-'));
    const profileDir = join(dir, 'profiles', 'path-team');
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, 'profile.yaml'),
      `workers:
  - name: path-worker
    kind: worker
`,
    );

    const { profile, profilePath } = await loadProfile({
      cwd: dir,
      env: { [ENSEMBLE_DEFAULT_PROFILE_ENV]: 'profiles/path-team/profile.yaml' },
    });

    expect(profilePath).toBe(join(dir, 'profiles/path-team/profile.yaml'));
    expect(profile.workers).toEqual([{ name: 'path-worker', kind: 'worker' }]);
  });

  it('falls back to bundled default when ENSEMBLE_DEFAULT_PROFILE is empty', async () => {
    const { profile, profilePath } = await loadProfile({
      cwd: '/no-such-cwd',
      env: { [ENSEMBLE_DEFAULT_PROFILE_ENV]: '' },
    });

    expect(profilePath).toBe(bundledDefaultProfilePath());
    expect(profile.workers.length).toBeGreaterThan(0);
  });
});

describe('default profile compile equivalence', () => {
  it('preserves key conductor profile phrases after modular-prompt migration', async () => {
    const { profile } = await loadProfile({ cwd: '/no-such-cwd' });
    const prompt = compileConductorSystemPrompt({
      issueUrl: 'https://github.com/org/repo/issues/150',
      profile,
      agentModule: resolveAgentPromptModule('conductor', profile.agents),
    });

    expect(prompt).toContain('**conductor**');
    expect(prompt).toContain('§3 conductor');
    expect(prompt).toContain('指示の典型的な内容');
    expect(prompt).toContain('permission.pending');
    expect(prompt).toContain('resolve_permission');
  });
});
