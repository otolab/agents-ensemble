import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ENSEMBLE_CONFIG } from './defaults.js';
import { deepMerge } from './deep-merge.js';
import { loadEnsembleConfig, ENSEMBLE_CONFIG_FILE } from './load-ensemble-config.js';
import { parseEnsembleConfig } from './parse-config.js';

describe('deepMerge', () => {
  it('merges nested objects recursively', () => {
    const base = {
      github: {
        auth: {
          allowGhAuthTokenFallback: true,
        },
        monitor: {
          enabled: true,
        },
      },
      future: {
        enabled: true,
      },
    };

    const merged = deepMerge(base, {
      github: {
        auth: {
          allowGhAuthTokenFallback: false,
        },
      },
    });

    expect(merged).toEqual({
      github: {
        auth: {
          allowGhAuthTokenFallback: false,
        },
        monitor: {
          enabled: true,
        },
      },
      future: {
        enabled: true,
      },
    });
  });
});

describe('parseEnsembleConfig', () => {
  it('ignores unknown top-level keys', () => {
    expect(
      parseEnsembleConfig({
        conductor: { proxyFromCursorSettings: true },
        github: {
          auth: {
            allowGhAuthTokenFallback: false,
          },
        },
      }),
    ).toEqual({
      github: {
        auth: {
          allowGhAuthTokenFallback: false,
        },
      },
    });
  });

  it('ignores invalid known key types', () => {
    expect(
      parseEnsembleConfig({
        github: {
          auth: {
            allowGhAuthTokenFallback: 'no',
          },
        },
      }),
    ).toEqual({});
  });

  it('parses Phase 1 keys', () => {
    expect(
      parseEnsembleConfig({
        profile: { default: 'my-team' },
        conductor: { model: 'composer-2.5' },
        acp: { defaultPreset: 'claude' },
        session: {
          worktree: 'in-repo',
          maxTurns: { tty: 2, nonTty: 8 },
          postLoop: { wait: false },
        },
        github: {
          monitor: {
            enabled: false,
            debounceMs: 10_000,
          },
        },
      }),
    ).toEqual({
      profile: { default: 'my-team' },
      conductor: { model: 'composer-2.5' },
      acp: { defaultPreset: 'claude' },
      session: {
        worktree: 'in_repo',
        maxTurns: { tty: 2, nonTty: 8 },
        postLoop: { wait: false },
      },
      github: {
        monitor: {
          enabled: false,
          debounceMs: 10_000,
        },
      },
    });
  });
});

describe('loadEnsembleConfig', () => {
  let repoRoot = '';
  let userEnsembleRoot = '';

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-config-repo-'));
    userEnsembleRoot = await mkdtemp(join(tmpdir(), 'ensemble-config-user-'));
  });

  afterEach(() => {
    repoRoot = '';
    userEnsembleRoot = '';
  });

  async function writeConfig(root: string, body: string): Promise<void> {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, ENSEMBLE_CONFIG_FILE), body);
  }

  it('returns defaults when no config files exist', async () => {
    const config = await loadEnsembleConfig(repoRoot, { userEnsembleRoot });

    expect(config).toEqual(DEFAULT_ENSEMBLE_CONFIG);
  });

  it('loads user config only', async () => {
    await writeConfig(userEnsembleRoot, `github:\n  auth:\n    allowGhAuthTokenFallback: false\n`);

    const config = await loadEnsembleConfig(repoRoot, { userEnsembleRoot });

    expect(config.github.auth.allowGhAuthTokenFallback).toBe(false);
    expect(config.session.maxTurns.nonTty).toBe(DEFAULT_ENSEMBLE_CONFIG.session.maxTurns.nonTty);
  });

  it('deep merges project over user', async () => {
    await writeConfig(
      userEnsembleRoot,
      `profile:\n  default: user-team\nsession:\n  maxTurns:\n    nonTty: 9\n`,
    );
    await writeConfig(
      join(repoRoot, '.ensemble'),
      `conductor:\n  model: project-model\nsession:\n  worktree: in-repo\n`,
    );

    const config = await loadEnsembleConfig(repoRoot, { userEnsembleRoot });

    expect(config.profile.default).toBe('user-team');
    expect(config.conductor.model).toBe('project-model');
    expect(config.session.worktree).toBe('in_repo');
    expect(config.session.maxTurns.nonTty).toBe(9);
  });

  it('project overrides user partial merge for github auth', async () => {
    await writeConfig(userEnsembleRoot, `github:\n  auth:\n    allowGhAuthTokenFallback: false\n`);
    await writeConfig(join(repoRoot, '.ensemble'), `github:\n  auth:\n    allowGhAuthTokenFallback: true\n`);

    const config = await loadEnsembleConfig(repoRoot, { userEnsembleRoot });

    expect(config.github.auth.allowGhAuthTokenFallback).toBe(true);
  });
});
