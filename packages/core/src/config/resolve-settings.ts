import { ENSEMBLE_DEFAULT_ACP_CLI_ENV } from '../acp/resolve-acp-spawn.js';
import type { WorkerWorktreeMode } from '../worktree/worktree.js';
import { DEFAULT_ENSEMBLE_CONFIG } from './defaults.js';
import type { EnsembleConfig } from './types.js';

/** `--profile` 未指定時の team profile（`load-profile` と共有）。 */
export const ENSEMBLE_DEFAULT_PROFILE_ENV = 'ENSEMBLE_DEFAULT_PROFILE';

/** conductor モデル id（`resolve-conductor-model-id` と共有）。 */
export const CONDUCTOR_MODEL_ID_ENV = 'CONDUCTOR_MODEL_ID';

function normalizeConductorModelId(modelId: string): string {
  return modelId === 'auto' ? 'default' : modelId;
}

/** 解決順: CLI 明示 > env > config > コード内 default */
export interface ResolveStringSettingOptions {
  cli?: string;
  env?: string;
  config?: string;
  defaultValue?: string;
}

export interface ResolveBooleanSettingOptions {
  cli?: boolean;
  env?: boolean;
  config?: boolean;
  defaultValue: boolean;
}

export interface ResolveNumberSettingOptions {
  cli?: number;
  env?: number;
  config?: number;
  defaultValue: number;
}

function trimString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveStringSetting(options: ResolveStringSettingOptions): string | undefined {
  const fromCli = trimString(options.cli);
  if (fromCli !== undefined) {
    return fromCli;
  }
  const fromEnv = trimString(options.env);
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  const fromConfig = trimString(options.config);
  if (fromConfig !== undefined) {
    return fromConfig;
  }
  return options.defaultValue;
}

export function resolveBooleanSetting(options: ResolveBooleanSettingOptions): boolean {
  if (options.cli !== undefined) {
    return options.cli;
  }
  if (options.env !== undefined) {
    return options.env;
  }
  if (options.config !== undefined) {
    return options.config;
  }
  return options.defaultValue;
}

export function resolveNumberSetting(options: ResolveNumberSettingOptions): number {
  if (options.cli !== undefined) {
    return options.cli;
  }
  if (options.env !== undefined) {
    return options.env;
  }
  if (options.config !== undefined) {
    return options.config;
  }
  return options.defaultValue;
}

export function resolveProfileDefaultRef(options: {
  cliProfile?: string;
  env?: NodeJS.ProcessEnv;
  config?: EnsembleConfig;
}): string | undefined {
  return resolveStringSetting({
    cli: options.cliProfile,
    env: options.env?.[ENSEMBLE_DEFAULT_PROFILE_ENV],
    config: options.config?.profile.default,
  });
}

export function resolveConductorModelSetting(options: {
  cliModel?: string;
  env?: NodeJS.ProcessEnv;
  config?: EnsembleConfig;
}): string {
  const resolved = resolveStringSetting({
    cli: options.cliModel,
    env: options.env?.[CONDUCTOR_MODEL_ID_ENV],
    config: options.config?.conductor.model,
    defaultValue: DEFAULT_ENSEMBLE_CONFIG.conductor.model,
  });
  return normalizeConductorModelId(resolved ?? DEFAULT_ENSEMBLE_CONFIG.conductor.model);
}

export function resolveDefaultAcpPresetSetting(options: {
  cliPreset?: string;
  env?: NodeJS.ProcessEnv;
  config?: EnsembleConfig;
}): string | undefined {
  return resolveStringSetting({
    cli: options.cliPreset,
    env: options.env?.[ENSEMBLE_DEFAULT_ACP_CLI_ENV],
    config: options.config?.acp.defaultPreset,
    defaultValue: DEFAULT_ENSEMBLE_CONFIG.acp.defaultPreset,
  });
}

export function resolveSessionWorktreeMode(options: {
  cliWorktree?: string;
  config?: EnsembleConfig;
}): WorkerWorktreeMode {
  const resolved = resolveStringSetting({
    cli: options.cliWorktree,
    config: options.config?.session.worktree,
    defaultValue: DEFAULT_ENSEMBLE_CONFIG.session.worktree,
  });
  return (resolved ?? DEFAULT_ENSEMBLE_CONFIG.session.worktree) as WorkerWorktreeMode;
}

export function resolveSessionMaxTurns(options: {
  interactive: boolean;
  cliNoMaxTurns?: boolean;
  cliMaxTurns?: number;
  config?: EnsembleConfig;
}): number {
  if (options.cliNoMaxTurns) {
    return 0;
  }
  if (options.cliMaxTurns !== undefined) {
    return options.cliMaxTurns;
  }
  const configMaxTurns = options.config?.session.maxTurns ?? DEFAULT_ENSEMBLE_CONFIG.session.maxTurns;
  return options.interactive ? configMaxTurns.tty : configMaxTurns.nonTty;
}

export function resolveSessionPostLoopWait(options: {
  cliNoWait?: boolean;
  config?: EnsembleConfig;
}): boolean {
  if (options.cliNoWait) {
    return false;
  }
  return resolveBooleanSetting({
    config: options.config?.session.postLoop.wait,
    defaultValue: DEFAULT_ENSEMBLE_CONFIG.session.postLoop.wait,
  });
}

export function resolveGitHubMonitorEnabled(options: {
  cliDisabled?: boolean;
  config?: EnsembleConfig;
}): boolean {
  if (options.cliDisabled) {
    return false;
  }
  return resolveBooleanSetting({
    config: options.config?.github.monitor.enabled,
    defaultValue: DEFAULT_ENSEMBLE_CONFIG.github.monitor.enabled,
  });
}

export function resolveGitHubMonitorDebounceMs(options: {
  cliDebounceMs?: number;
  config?: EnsembleConfig;
}): number {
  return resolveNumberSetting({
    cli: options.cliDebounceMs,
    config: options.config?.github.monitor.debounceMs,
    defaultValue: DEFAULT_ENSEMBLE_CONFIG.github.monitor.debounceMs,
  });
}

export function resolveGitHubMonitorPollIntervalMs(options: {
  cliPollIntervalMs?: number;
  config?: EnsembleConfig;
}): number {
  return resolveNumberSetting({
    cli: options.cliPollIntervalMs,
    config: options.config?.github.monitor.pollIntervalMs,
    defaultValue: DEFAULT_ENSEMBLE_CONFIG.github.monitor.pollIntervalMs,
  });
}

export function resolveGitHubMonitorActivePollIntervalMs(options: {
  cliActivePollIntervalMs?: number;
  config?: EnsembleConfig;
}): number {
  return resolveNumberSetting({
    cli: options.cliActivePollIntervalMs,
    config: options.config?.github.monitor.activePollIntervalMs,
    defaultValue: DEFAULT_ENSEMBLE_CONFIG.github.monitor.activePollIntervalMs,
  });
}

export function resolveGitHubMonitorStopPollWaitMs(options: {
  cliStopPollWaitMs?: number;
  config?: EnsembleConfig;
}): number {
  return resolveNumberSetting({
    cli: options.cliStopPollWaitMs,
    config: options.config?.github.monitor.stopPollWaitMs,
    defaultValue: DEFAULT_ENSEMBLE_CONFIG.github.monitor.stopPollWaitMs,
  });
}
