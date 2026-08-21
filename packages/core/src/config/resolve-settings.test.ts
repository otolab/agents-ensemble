import { describe, expect, it } from 'vitest';
import { ENSEMBLE_DEFAULT_ACP_CLI_ENV } from '../acp/resolve-acp-spawn.js';
import { DEFAULT_ENSEMBLE_CONFIG } from './defaults.js';
import {
  CONDUCTOR_MODEL_ID_ENV,
  ENSEMBLE_DEFAULT_PROFILE_ENV,
  resolveBooleanSetting,
  resolveConductorModelSetting,
  resolveDefaultAcpPresetSetting,
  resolveGitHubMonitorDebounceMs,
  resolveGitHubMonitorEnabled,
  resolveNumberSetting,
  resolveProfileDefaultRef,
  resolveSessionMaxTurns,
  resolveSessionPostLoopWait,
  resolveSessionWorktreeMode,
  resolveStringSetting,
} from './resolve-settings.js';
import type { EnsembleConfig } from './types.js';

const projectConfig: EnsembleConfig = {
  ...DEFAULT_ENSEMBLE_CONFIG,
  profile: { default: 'project-profile' },
  conductor: { model: 'project-model' },
  acp: { defaultPreset: 'claude' },
  session: {
    worktree: 'in_repo',
    maxTurns: { tty: 3, nonTty: 7 },
    postLoop: { wait: false },
  },
  github: {
    ...DEFAULT_ENSEMBLE_CONFIG.github,
    monitor: {
      ...DEFAULT_ENSEMBLE_CONFIG.github.monitor,
      enabled: false,
      debounceMs: 12_000,
    },
  },
};

describe('resolveStringSetting', () => {
  it('follows CLI > env > config > default', () => {
    expect(
      resolveStringSetting({
        cli: 'cli',
        env: 'env',
        config: 'config',
        defaultValue: 'default',
      }),
    ).toBe('cli');
    expect(
      resolveStringSetting({
        env: 'env',
        config: 'config',
        defaultValue: 'default',
      }),
    ).toBe('env');
    expect(
      resolveStringSetting({
        config: 'config',
        defaultValue: 'default',
      }),
    ).toBe('config');
    expect(resolveStringSetting({ defaultValue: 'default' })).toBe('default');
  });

  it('treats empty strings as unset', () => {
    expect(
      resolveStringSetting({
        cli: '   ',
        env: 'env',
      }),
    ).toBe('env');
  });
});

describe('resolveBooleanSetting', () => {
  it('follows CLI > env > config > default', () => {
    expect(
      resolveBooleanSetting({
        cli: false,
        env: true,
        config: true,
        defaultValue: true,
      }),
    ).toBe(false);
    expect(
      resolveBooleanSetting({
        env: false,
        config: true,
        defaultValue: true,
      }),
    ).toBe(false);
    expect(
      resolveBooleanSetting({
        config: false,
        defaultValue: true,
      }),
    ).toBe(false);
    expect(resolveBooleanSetting({ defaultValue: true })).toBe(true);
  });
});

describe('resolveNumberSetting', () => {
  it('follows CLI > env > config > default', () => {
    expect(
      resolveNumberSetting({
        cli: 1,
        env: 2,
        config: 3,
        defaultValue: 4,
      }),
    ).toBe(1);
    expect(
      resolveNumberSetting({
        env: 2,
        config: 3,
        defaultValue: 4,
      }),
    ).toBe(2);
    expect(
      resolveNumberSetting({
        config: 3,
        defaultValue: 4,
      }),
    ).toBe(3);
    expect(resolveNumberSetting({ defaultValue: 4 })).toBe(4);
  });
});

describe('resolveProfileDefaultRef', () => {
  it('prefers CLI over env and config', () => {
    expect(
      resolveProfileDefaultRef({
        cliProfile: 'cli-profile',
        env: { [ENSEMBLE_DEFAULT_PROFILE_ENV]: 'env-profile' },
        config: projectConfig,
      }),
    ).toBe('cli-profile');
  });

  it('prefers env over config when CLI is omitted', () => {
    expect(
      resolveProfileDefaultRef({
        env: { [ENSEMBLE_DEFAULT_PROFILE_ENV]: 'env-profile' },
        config: projectConfig,
      }),
    ).toBe('env-profile');
  });

  it('uses config when env is unset', () => {
    expect(
      resolveProfileDefaultRef({
        config: projectConfig,
      }),
    ).toBe('project-profile');
  });
});

describe('resolveConductorModelSetting', () => {
  it('prefers CLI over env and config', () => {
    process.env[CONDUCTOR_MODEL_ID_ENV] = 'env-model';
    expect(
      resolveConductorModelSetting({
        cliModel: 'cli-model',
        env: process.env,
        config: projectConfig,
      }),
    ).toBe('cli-model');
    delete process.env[CONDUCTOR_MODEL_ID_ENV];
  });

  it('prefers env over config when CLI is omitted', () => {
    process.env[CONDUCTOR_MODEL_ID_ENV] = 'env-model';
    expect(
      resolveConductorModelSetting({
        env: process.env,
        config: projectConfig,
      }),
    ).toBe('env-model');
    delete process.env[CONDUCTOR_MODEL_ID_ENV];
  });

  it('normalizes auto from env', () => {
    process.env[CONDUCTOR_MODEL_ID_ENV] = 'auto';
    expect(resolveConductorModelSetting({ env: process.env })).toBe('default');
    delete process.env[CONDUCTOR_MODEL_ID_ENV];
  });
});

describe('resolveDefaultAcpPresetSetting', () => {
  it('prefers env over config when CLI is omitted', () => {
    expect(
      resolveDefaultAcpPresetSetting({
        env: { [ENSEMBLE_DEFAULT_ACP_CLI_ENV]: 'codex' },
        config: projectConfig,
      }),
    ).toBe('codex');
  });
});

describe('resolveSessionWorktreeMode', () => {
  it('uses config when CLI is omitted', () => {
    expect(
      resolveSessionWorktreeMode({
        config: projectConfig,
      }),
    ).toBe('in_repo');
  });
});

describe('resolveSessionMaxTurns', () => {
  it('prefers CLI flags over config defaults', () => {
    expect(
      resolveSessionMaxTurns({
        interactive: false,
        cliNoMaxTurns: true,
        config: projectConfig,
      }),
    ).toBe(0);
    expect(
      resolveSessionMaxTurns({
        interactive: false,
        cliMaxTurns: 10,
        config: projectConfig,
      }),
    ).toBe(10);
  });

  it('uses config tty/nonTty when CLI is omitted', () => {
    expect(
      resolveSessionMaxTurns({
        interactive: true,
        config: projectConfig,
      }),
    ).toBe(3);
    expect(
      resolveSessionMaxTurns({
        interactive: false,
        config: projectConfig,
      }),
    ).toBe(7);
  });

  it('falls back to code defaults when config is absent', () => {
    expect(resolveSessionMaxTurns({ interactive: true })).toBe(0);
    expect(resolveSessionMaxTurns({ interactive: false })).toBe(5);
  });
});

describe('resolveSessionPostLoopWait', () => {
  it('disables wait when --no-wait is set', () => {
    expect(
      resolveSessionPostLoopWait({
        cliNoWait: true,
        config: projectConfig,
      }),
    ).toBe(false);
  });

  it('uses config when CLI is omitted', () => {
    expect(resolveSessionPostLoopWait({ config: projectConfig })).toBe(false);
  });
});

describe('resolveGitHubMonitorEnabled', () => {
  it('disables when CLI --no-github-monitor is set', () => {
    expect(
      resolveGitHubMonitorEnabled({
        cliDisabled: true,
        config: {
          ...projectConfig,
          github: {
            ...projectConfig.github,
            monitor: { ...projectConfig.github.monitor, enabled: true },
          },
        },
      }),
    ).toBe(false);
  });

  it('uses config when CLI is omitted', () => {
    expect(resolveGitHubMonitorEnabled({ config: projectConfig })).toBe(false);
  });
});

describe('resolveGitHubMonitorDebounceMs', () => {
  it('prefers CLI over config', () => {
    expect(
      resolveGitHubMonitorDebounceMs({
        cliDebounceMs: 1_000,
        config: projectConfig,
      }),
    ).toBe(1_000);
    expect(resolveGitHubMonitorDebounceMs({ config: projectConfig })).toBe(12_000);
  });
});

describe('backward compatibility without config', () => {
  it('keeps env-only behavior for profile, model, and acp preset', () => {
    const env = {
      [ENSEMBLE_DEFAULT_PROFILE_ENV]: 'legacy-profile',
      [CONDUCTOR_MODEL_ID_ENV]: 'legacy-model',
      [ENSEMBLE_DEFAULT_ACP_CLI_ENV]: 'pi',
    } as NodeJS.ProcessEnv;

    expect(resolveProfileDefaultRef({ env })).toBe('legacy-profile');
    expect(resolveConductorModelSetting({ env })).toBe('legacy-model');
    expect(resolveDefaultAcpPresetSetting({ env })).toBe('pi');
  });
});
