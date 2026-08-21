import {
  isBuiltinAcpPresetId,
  type BuiltinAcpPresetId,
} from '../acp/resolve-acp-spawn.js';
import type { WorkerWorktreeMode } from '../worktree/worktree.js';
import type {
  EnsembleAcpConfig,
  EnsembleConductorConfig,
  EnsembleConfig,
  EnsembleGitHubAuthConfig,
  EnsembleGitHubConfig,
  EnsembleGitHubMonitorConfig,
  EnsembleProfileConfig,
  EnsembleSessionConfig,
  EnsembleSessionMaxTurnsConfig,
  EnsembleSessionPostLoopConfig,
} from './types.js';

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseWorktreeMode(value: unknown): WorkerWorktreeMode | undefined {
  const raw = readString(value);
  if (!raw) {
    return undefined;
  }
  const normalized = raw.toLowerCase().replace(/_/g, '-');
  if (normalized === 'isolated') {
    return 'isolated';
  }
  if (normalized === 'in-repo') {
    return 'in_repo';
  }
  return undefined;
}

function parseProfileConfig(raw: unknown): EnsembleProfileConfig | undefined {
  const obj = readObject(raw);
  if (!obj) {
    return undefined;
  }
  const defaultProfile = readString(obj.default);
  return defaultProfile ? { default: defaultProfile } : {};
}

function parseConductorConfig(raw: unknown): EnsembleConductorConfig | undefined {
  const obj = readObject(raw);
  if (!obj) {
    return undefined;
  }
  const model = readString(obj.model);
  return model ? { model } : undefined;
}

function parseAcpConfig(raw: unknown): EnsembleAcpConfig | undefined {
  const obj = readObject(raw);
  if (!obj) {
    return undefined;
  }
  const preset = readString(obj.defaultPreset);
  if (!preset || !isBuiltinAcpPresetId(preset)) {
    return undefined;
  }
  return { defaultPreset: preset as BuiltinAcpPresetId };
}

function parseSessionMaxTurns(raw: unknown): EnsembleSessionMaxTurnsConfig | undefined {
  const obj = readObject(raw);
  if (!obj) {
    return undefined;
  }
  const tty = readNumber(obj.tty);
  const nonTty = readNumber(obj.nonTty);
  if (tty === undefined && nonTty === undefined) {
    return undefined;
  }
  return {
    ...(tty !== undefined ? { tty } : {}),
    ...(nonTty !== undefined ? { nonTty } : {}),
  } as EnsembleSessionMaxTurnsConfig;
}

function parseSessionPostLoop(raw: unknown): EnsembleSessionPostLoopConfig | undefined {
  const obj = readObject(raw);
  if (!obj) {
    return undefined;
  }
  const wait = readBoolean(obj.wait);
  return wait === undefined ? undefined : { wait };
}

function parseSessionConfig(raw: unknown): EnsembleSessionConfig | undefined {
  const obj = readObject(raw);
  if (!obj) {
    return undefined;
  }
  const worktree = parseWorktreeMode(obj.worktree);
  const maxTurns = parseSessionMaxTurns(obj.maxTurns);
  const postLoop = parseSessionPostLoop(obj.postLoop);
  if (worktree === undefined && maxTurns === undefined && postLoop === undefined) {
    return undefined;
  }
  return {
    ...(worktree !== undefined ? { worktree } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(postLoop !== undefined ? { postLoop } : {}),
  } as EnsembleSessionConfig;
}

function parseGitHubAuthConfig(raw: unknown): EnsembleGitHubAuthConfig | undefined {
  const obj = readObject(raw);
  if (!obj) {
    return undefined;
  }
  const allowGhAuthTokenFallback = readBoolean(obj.allowGhAuthTokenFallback);
  return allowGhAuthTokenFallback === undefined
    ? undefined
    : { allowGhAuthTokenFallback };
}

function parseGitHubMonitorConfig(raw: unknown): EnsembleGitHubMonitorConfig | undefined {
  const obj = readObject(raw);
  if (!obj) {
    return undefined;
  }
  const enabled = readBoolean(obj.enabled);
  const debounceMs = readNumber(obj.debounceMs);
  const pollIntervalMs = readNumber(obj.pollIntervalMs);
  const activePollIntervalMs = readNumber(obj.activePollIntervalMs);
  const stopPollWaitMs = readNumber(obj.stopPollWaitMs);
  if (
    enabled === undefined &&
    debounceMs === undefined &&
    pollIntervalMs === undefined &&
    activePollIntervalMs === undefined &&
    stopPollWaitMs === undefined
  ) {
    return undefined;
  }
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(debounceMs !== undefined ? { debounceMs } : {}),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
    ...(activePollIntervalMs !== undefined ? { activePollIntervalMs } : {}),
    ...(stopPollWaitMs !== undefined ? { stopPollWaitMs } : {}),
  } as EnsembleGitHubMonitorConfig;
}

function parseGitHubConfig(raw: unknown): EnsembleGitHubConfig | undefined {
  const obj = readObject(raw);
  if (!obj) {
    return undefined;
  }
  const auth = parseGitHubAuthConfig(obj.auth);
  const monitor = parseGitHubMonitorConfig(obj.monitor);
  if (auth === undefined && monitor === undefined) {
    return undefined;
  }
  return {
    ...(auth !== undefined ? { auth } : {}),
    ...(monitor !== undefined ? { monitor } : {}),
  } as EnsembleGitHubConfig;
}

/**
 * YAML から既知スキーマのみ抽出する。未知キーは無視（将来拡張用）。
 * 無効な型の既知キーは無視し、下位層 / デフォルトにフォールバックする。
 */
export function parseEnsembleConfig(raw: unknown): Partial<EnsembleConfig> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const root = raw as Record<string, unknown>;
  const result: Partial<EnsembleConfig> = {};

  const profile = parseProfileConfig(root.profile);
  if (profile !== undefined) {
    result.profile = profile;
  }

  const conductor = parseConductorConfig(root.conductor);
  if (conductor !== undefined) {
    result.conductor = conductor;
  }

  const acp = parseAcpConfig(root.acp);
  if (acp !== undefined) {
    result.acp = acp;
  }

  const session = parseSessionConfig(root.session);
  if (session !== undefined) {
    result.session = session;
  }

  const github = parseGitHubConfig(root.github);
  if (github !== undefined) {
    result.github = github;
  }

  return result;
}
