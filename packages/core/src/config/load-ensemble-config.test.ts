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
        config: { loadProjectConfig: false },
        conductor: { proxyFromCursorSettings: true },
        github: {
          auth: {
            allowGhAuthTokenFallback: false,
          },
        },
      }),
    ).toEqual({
      config: { loadProjectConfig: false },
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

    expect(
      parseEnsembleConfig({ conductor: { backend: 'unsupported' } }),
    ).toEqual({});
  });

  it('parses Phase 1 keys', () => {
    expect(
      parseEnsembleConfig({
        profile: { default: 'my-team' },
        conductor: {
          model: 'composer-2.5',
          backend: 'pi',
          verbose: true,
          pi: { agentDir: '~/.ensemble/pi', projectDir: '.ensemble/pi' },
        },
        acp: {
          defaultPreset: 'claude',
          env: { MODEL_PROVIDER: 'litellm' },
        },
        session: {
          worktree: 'in-repo',
          lazyWorkers: true,
          maxTurns: { tty: 2, nonTty: 8 },
          postLoop: { wait: false },
        },
        github: {
          monitor: {
            enabled: false,
            debounceMs: 10_000,
          },
        },
        tui: {
          layout: 'stream',
          forceHyperlink: 'on',
        },
      }),
    ).toEqual({
      profile: { default: 'my-team' },
      conductor: {
        model: 'composer-2.5',
        backend: 'pi',
        verbose: true,
        pi: { agentDir: '~/.ensemble/pi', projectDir: '.ensemble/pi' },
      },
      acp: { defaultPreset: 'claude', env: { MODEL_PROVIDER: 'litellm' } },
      session: {
        worktree: 'in_repo',
        lazyWorkers: true,
        maxTurns: { tty: 2, nonTty: 8 },
        postLoop: { wait: false },
      },
      github: {
        monitor: {
          enabled: false,
          debounceMs: 10_000,
        },
      },
      tui: {
        layout: 'stream',
        forceHyperlink: 'on',
      },
    });
  });

  it('ignores invalid tui values', () => {
    expect(
      parseEnsembleConfig({
        tui: {
          layout: 'grid',
          forceHyperlink: 'maybe',
        },
      }),
    ).toEqual({});
  });

  it('ignores invalid session.lazyWorkers values', () => {
    expect(
      parseEnsembleConfig({ session: { lazyWorkers: 'yes' } }),
    ).toEqual({});
  });

  it('ignores invalid config.loadProjectConfig values', () => {
    expect(parseEnsembleConfig({ config: { loadProjectConfig: 'no' } })).toEqual({});
  });
});

describe('loadEnsembleConfig', () => {
  let repoRoot = '';
  let userEnsembleRoot = '';
  let output: string[] = [];

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-config-repo-'));
    userEnsembleRoot = await mkdtemp(join(tmpdir(), 'ensemble-config-user-'));
    output = [];
  });

  afterEach(() => {
    repoRoot = '';
    userEnsembleRoot = '';
  });

  async function writeConfig(root: string, body: string): Promise<void> {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, ENSEMBLE_CONFIG_FILE), body);
  }

  async function loadConfig() {
    return loadEnsembleConfig(repoRoot, {
      userEnsembleRoot,
      writeStderr: (message) => output.push(message),
    });
  }

  it('returns defaults when no config files exist', async () => {
    const config = await loadConfig();

    expect(config).toEqual(DEFAULT_ENSEMBLE_CONFIG);
    expect(output).toEqual([]);
  });

  it('loads user config only', async () => {
    await writeConfig(userEnsembleRoot, `github:\n  auth:\n    allowGhAuthTokenFallback: false\n`);

    const config = await loadConfig();

    expect(config.github.auth.allowGhAuthTokenFallback).toBe(false);
    expect(config.session.maxTurns.nonTty).toBe(DEFAULT_ENSEMBLE_CONFIG.session.maxTurns.nonTty);
    expect(output).toEqual([]);
  });

  it('deep merges project over user', async () => {
    await writeConfig(
      userEnsembleRoot,
      `profile:\n  default: user-team\nsession:\n  maxTurns:\n    nonTty: 9\n`,
    );
    await writeConfig(
      join(repoRoot, '.ensemble'),
      `conductor:\n  model: project-model\n  backend: pi\nsession:\n  worktree: in-repo\n`,
    );

    const config = await loadConfig();

    expect(config.profile.default).toBe('user-team');
    expect(config.conductor.model).toBe('project-model');
    expect(config.conductor.backend).toBe('pi');
    expect(config.session.worktree).toBe('in_repo');
    expect(config.session.maxTurns.nonTty).toBe(9);
    expect(output).toEqual([
      `ensemble: project config を読み込みました: ${join(repoRoot, '.ensemble', ENSEMBLE_CONFIG_FILE)}`,
    ]);
  });

  it('deep merges lazy worker attach setting and defaults to eager', async () => {
    await writeConfig(userEnsembleRoot, `session:\n  lazyWorkers: true\n`);
    await writeConfig(
      join(repoRoot, '.ensemble'),
      `session:\n  lazyWorkers: false\n`,
    );

    const config = await loadConfig();

    expect(config.session.lazyWorkers).toBe(false);
    expect(DEFAULT_ENSEMBLE_CONFIG.session.lazyWorkers).toBe(false);
  });

  it('project overrides user partial merge for github auth', async () => {
    await writeConfig(userEnsembleRoot, `github:\n  auth:\n    allowGhAuthTokenFallback: false\n`);
    await writeConfig(join(repoRoot, '.ensemble'), `github:\n  auth:\n    allowGhAuthTokenFallback: true\n`);

    const config = await loadConfig();

    expect(config.github.auth.allowGhAuthTokenFallback).toBe(true);
  });

  it('deep merges conductor backend across user and project config', async () => {
    await writeConfig(userEnsembleRoot, `conductor:\n  backend: pi\n`);
    await writeConfig(join(repoRoot, '.ensemble'), `conductor:\n  model: project-model\n`);

    const config = await loadConfig();

    expect(config.conductor.model).toBe('project-model');
    expect(config.conductor.backend).toBe('pi');
  });

  it('deep merges acp env across user and project config', async () => {
    await writeConfig(
      userEnsembleRoot,
      `acp:\n  defaultPreset: codex\n  env:\n    MODEL_PROVIDER: litellm\n    CODEX_CONFIG: ~/.codex/litellm.config.toml\n`,
    );
    await writeConfig(
      join(repoRoot, '.ensemble'),
      `acp:\n  env:\n    CODEX_CONFIG: /project/litellm.config.toml\n`,
    );

    const config = await loadConfig();

    expect(config.acp.defaultPreset).toBe('codex');
    expect(config.acp.env).toEqual({
      MODEL_PROVIDER: 'litellm',
      CODEX_CONFIG: '/project/litellm.config.toml',
    });
  });

  it('uses an explicit config as the user layer, then merges project over it', async () => {
    await writeConfig(
      userEnsembleRoot,
      `conductor:\n  model: standard-user-model\ngithub:\n  auth:\n    allowGhAuthTokenFallback: false\nacp:\n  env:\n    USER_ONLY: user\n`,
    );
    await writeConfig(
      join(repoRoot, '.ensemble'),
      `conductor:\n  model: project-model\n  backend: pi\nsession:\n  maxTurns:\n    nonTty: 12\nacp:\n  env:\n    PROJECT_ONLY: project\n    MODEL_PROVIDER: project-provider\n`,
    );
    const explicitPath = join(repoRoot, 'litellm.config.yaml');
    await writeFile(
      explicitPath,
      `conductor:\n  model: explicit-model\nsession:\n  maxTurns:\n    tty: 7\nacp:\n  env:\n    EXPLICIT_ONLY: explicit\n    MODEL_PROVIDER: litellm\ntui:\n  layout: pane\n`,
    );

    const config = await loadEnsembleConfig(repoRoot, {
      userEnsembleRoot,
      configPath: explicitPath,
    });

    expect(config.conductor).toMatchObject({
      model: 'project-model',
      backend: 'pi',
    });
    expect(config.github.auth.allowGhAuthTokenFallback).toBe(true);
    expect(config.session.maxTurns).toEqual({ tty: 7, nonTty: 12 });
    expect(config.acp.env).toEqual({
      PROJECT_ONLY: 'project',
      EXPLICIT_ONLY: 'explicit',
      MODEL_PROVIDER: 'project-provider',
    });
    expect(config.tui.layout).toBe('pane');
  });

  it('keeps project config active when no explicit user config is selected', async () => {
    await writeConfig(userEnsembleRoot, `conductor:\n  model: user-model\n`);
    await writeConfig(
      join(repoRoot, '.ensemble'),
      `conductor:\n  model: project-model\n`,
    );

    const config = await loadEnsembleConfig(repoRoot, { userEnsembleRoot });

    expect(config.conductor.model).toBe('project-model');
  });

  it('fails clearly when an explicit config file does not exist', async () => {
    const missingPath = join(repoRoot, 'missing.config.yaml');

    await expect(
      loadEnsembleConfig(repoRoot, { userEnsembleRoot, configPath: missingPath }),
    ).rejects.toThrow(`Explicit ensemble config file not found: ${missingPath}`);
  });

  it('uses the explicit user config loadProjectConfig value to skip the project layer', async () => {
    await writeConfig(
      userEnsembleRoot,
      `config:\n  loadProjectConfig: true\nconductor:\n  model: standard-user-model\n`,
    );
    await writeConfig(
      join(repoRoot, '.ensemble'),
      `config:\n  loadProjectConfig: true\nconductor:\n  model: project-model\n`,
    );
    const explicitPath = join(repoRoot, 'litellm.config.yaml');
    await writeFile(
      explicitPath,
      `config:\n  loadProjectConfig: false\nconductor:\n  model: explicit-model\n`,
    );

    const config = await loadEnsembleConfig(repoRoot, {
      userEnsembleRoot,
      configPath: explicitPath,
      writeStderr: (message) => output.push(message),
    });

    expect(config.config.loadProjectConfig).toBe(false);
    expect(config.conductor.model).toBe('explicit-model');
    expect(output).toEqual([
      'ensemble: project config をスキップしました（user 設定）',
    ]);
  });

  it('does not inherit the standard user project-load toggle when an explicit config omits it', async () => {
    await writeConfig(
      userEnsembleRoot,
      `config:\n  loadProjectConfig: false\nconductor:\n  model: standard-user-model\n`,
    );
    await writeConfig(
      join(repoRoot, '.ensemble'),
      `conductor:\n  model: project-model\n`,
    );
    const explicitPath = join(repoRoot, 'litellm.config.yaml');
    await writeFile(
      explicitPath,
      `conductor:\n  model: explicit-model\n`,
    );

    const config = await loadEnsembleConfig(repoRoot, {
      userEnsembleRoot,
      configPath: explicitPath,
      writeStderr: (message) => output.push(message),
    });

    expect(config.config.loadProjectConfig).toBe(true);
    expect(config.conductor.model).toBe('project-model');
    expect(output).toEqual([
      `ensemble: project config を読み込みました: ${join(repoRoot, '.ensemble', ENSEMBLE_CONFIG_FILE)}`,
    ]);
  });

  it('skips project config when disabled in user config, even if project config opts in', async () => {
    await writeConfig(
      userEnsembleRoot,
      `config:\n  loadProjectConfig: false\nconductor:\n  model: user-model\n`,
    );
    await writeConfig(
      join(repoRoot, '.ensemble'),
      `config:\n  loadProjectConfig: true\nconductor:\n  model: project-model\n`,
    );

    const config = await loadConfig();

    expect(config.config.loadProjectConfig).toBe(false);
    expect(config.conductor.model).toBe('user-model');
    expect(output).toEqual([
      'ensemble: project config をスキップしました（user 設定）',
    ]);
  });

  it('ignores the project value for the user-only control setting', async () => {
    await writeConfig(userEnsembleRoot, `conductor:\n  model: user-model\n`);
    await writeConfig(
      join(repoRoot, '.ensemble'),
      `config:\n  loadProjectConfig: false\nconductor:\n  backend: pi\n`,
    );

    const config = await loadConfig();

    expect(config.config.loadProjectConfig).toBe(true);
    expect(config.conductor.model).toBe('user-model');
    expect(config.conductor.backend).toBe('pi');
    expect(output).toEqual([
      `ensemble: project config を読み込みました: ${join(repoRoot, '.ensemble', ENSEMBLE_CONFIG_FILE)}`,
    ]);
  });

  it('reports project config skip even when the file does not exist', async () => {
    await writeConfig(userEnsembleRoot, `config:\n  loadProjectConfig: false\n`);

    const config = await loadConfig();

    expect(config.config.loadProjectConfig).toBe(false);
    expect(output).toEqual([
      'ensemble: project config をスキップしました（user 設定）',
    ]);
  });
});
