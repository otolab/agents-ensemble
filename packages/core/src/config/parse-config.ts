import {
  isBuiltinAcpPresetId,
  type BuiltinAcpPresetId,
} from '../acp/resolve-acp-spawn.js';
import type { WorkerWorktreeMode } from '../worktree/worktree.js';
import type {
  ConductorBackend,
  AcpModelTag,
  EnsembleAcpConfig,
  EnsembleConfigControlConfig,
  EnsembleConductorConfig,
  EnsembleConfig,
  EnsembleConfigLayer,
  EnsembleConductorPiConfig,
  EnsembleGitHubAuthConfig,
  EnsembleGitHubConfig,
  EnsembleGitHubMonitorConfig,
  EnsembleProfileConfig,
  EnsembleSessionConfig,
  EnsembleSessionMaxTurnsConfig,
  EnsembleSessionPostLoopConfig,
  EnsembleTuiConfig,
  TuiForceHyperlinkMode,
  TuiLayoutMode,
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

function parseConfigControlConfig(
  raw: unknown,
): EnsembleConfigControlConfig | undefined {
  const obj = readObject(raw);
  if (!obj) {
    return undefined;
  }
  const loadProjectConfig = readBoolean(obj.loadProjectConfig);
  return loadProjectConfig === undefined ? undefined : { loadProjectConfig };
}

function parseConductorConfig(raw: unknown): EnsembleConductorConfig | undefined {
  const obj = readObject(raw);
  if (!obj) {
    return undefined;
  }
  const model = readString(obj.model);
  const backend = parseConductorBackend(obj.backend);
  const verbose = readBoolean(obj.verbose);
  const pi = parseConductorPiConfig(obj.pi);
  if (
    model === undefined &&
    backend === undefined &&
    verbose === undefined &&
    pi === undefined
  ) {
    return undefined;
  }
  return {
    ...(model !== undefined ? { model } : {}),
    ...(backend !== undefined ? { backend } : {}),
    ...(verbose !== undefined ? { verbose } : {}),
    ...(pi !== undefined ? { pi } : {}),
  } as EnsembleConductorConfig;
}

function parseConductorPiConfig(raw: unknown): EnsembleConductorPiConfig | undefined {
  const obj = readObject(raw);
  if (!obj) {
    return undefined;
  }
  const agentDir = readString(obj.agentDir);
  const projectDir = readString(obj.projectDir);
  if (agentDir === undefined && projectDir === undefined) {
    return undefined;
  }
  return {
    ...(agentDir !== undefined ? { agentDir } : {}),
    ...(projectDir !== undefined ? { projectDir } : {}),
  };
}

function parseConductorBackend(value: unknown): ConductorBackend | undefined {
  const raw = readString(value);
  return raw === 'cursor' || raw === 'pi' ? raw : undefined;
}

function parseStringMap(
  raw: unknown,
  label: string,
): Record<string, string> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      continue;
    }
    env[key] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

const ACP_MODEL_TAGS: readonly AcpModelTag[] = [
  'high',
  'default',
  'low',
  'fast',
];

function parseAcpModels(raw: unknown): Record<string, string> | undefined {
  const obj = readObject(raw);
  if (!obj) return undefined;
  const models: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const modelKey = key.trim();
    const modelId = readString(value);
    if (modelKey && modelId) models[modelKey] = modelId;
  }
  return Object.keys(models).length > 0 ? models : undefined;
}

function parseAcpTags(
  raw: unknown,
): Partial<Record<AcpModelTag, string>> | undefined {
  const obj = readObject(raw);
  if (!obj) return undefined;
  const tags: Partial<Record<AcpModelTag, string>> = {};
  for (const tag of ACP_MODEL_TAGS) {
    const modelKey = readString(obj[tag]);
    if (modelKey) tags[tag] = modelKey;
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function parseAcpConfig(raw: unknown): Partial<EnsembleAcpConfig> | undefined {
  const obj = readObject(raw);
  if (!obj) {
    return undefined;
  }
  const preset = readString(obj.defaultPreset);
  const env = parseStringMap(obj.env, 'acp.env');
  const models = parseAcpModels(obj.models);
  const tags = parseAcpTags(obj.tags);
  const validPreset =
    preset && isBuiltinAcpPresetId(preset) ? (preset as BuiltinAcpPresetId) : undefined;
  if (
    validPreset === undefined &&
    env === undefined &&
    models === undefined &&
    tags === undefined
  ) {
    return undefined;
  }
  return {
    ...(validPreset !== undefined ? { defaultPreset: validPreset } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(tags !== undefined ? { tags } : {}),
  };
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
  const lazyWorkers = readBoolean(obj.lazyWorkers);
  const maxTurns = parseSessionMaxTurns(obj.maxTurns);
  const postLoop = parseSessionPostLoop(obj.postLoop);
  if (
    worktree === undefined &&
    lazyWorkers === undefined &&
    maxTurns === undefined &&
    postLoop === undefined
  ) {
    return undefined;
  }
  return {
    ...(worktree !== undefined ? { worktree } : {}),
    ...(lazyWorkers !== undefined ? { lazyWorkers } : {}),
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

function parseTuiLayoutMode(value: unknown): TuiLayoutMode | undefined {
  const raw = readString(value);
  if (raw === 'stream') {
    return 'stream';
  }
  if (raw === 'pane') {
    return 'pane';
  }
  return undefined;
}

function parseTuiForceHyperlinkMode(value: unknown): TuiForceHyperlinkMode | undefined {
  const raw = readString(value);
  if (raw === 'auto' || raw === 'on' || raw === 'off') {
    return raw;
  }
  return undefined;
}

function parseTuiConfig(raw: unknown): EnsembleTuiConfig | undefined {
  const obj = readObject(raw);
  if (!obj) {
    return undefined;
  }
  const layout = parseTuiLayoutMode(obj.layout);
  const forceHyperlink = parseTuiForceHyperlinkMode(obj.forceHyperlink);
  if (layout === undefined && forceHyperlink === undefined) {
    return undefined;
  }
  return {
    ...(layout !== undefined ? { layout } : {}),
    ...(forceHyperlink !== undefined ? { forceHyperlink } : {}),
  } as EnsembleTuiConfig;
}

/**
 * YAML から既知スキーマのみ抽出する。未知キーは無視（将来拡張用）。
 * 無効な型の既知キーは無視し、下位層 / デフォルトにフォールバックする。
 */
export function parseEnsembleConfig(raw: unknown): EnsembleConfigLayer {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const root = raw as Record<string, unknown>;
  const result: EnsembleConfigLayer = {};

  const config = parseConfigControlConfig(root.config);
  if (config !== undefined) {
    result.config = config;
  }

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

  const tui = parseTuiConfig(root.tui);
  if (tui !== undefined) {
    result.tui = tui;
  }

  return result;
}
