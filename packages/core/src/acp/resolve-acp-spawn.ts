import type { SpawnAcpProcessOptions } from './acp-process.js';
import {
  parseProfileAcpAuthenticate,
  resolveAcpAuthenticateStrategy,
  type AcpAuthenticateStrategy,
} from './resolve-acp-auth.js';
import type { Profile, ProfileAcpConfig } from '../profile/types.js';
import type { EnsembleConfig } from '../config/types.js';

/** Built-in ACP preset id（Phase 1）。拡張時は adapter / capability を別途追加可能。 */
export type BuiltinAcpPresetId = 'cursor' | 'claude' | 'codex' | 'pi';

export type AcpPresetId = BuiltinAcpPresetId | 'custom';

export const ENSEMBLE_DEFAULT_ACP_CLI_ENV = 'ENSEMBLE_DEFAULT_ACP_CLI';

/** profile / CLI から解決した spawn 定義。 */
export interface ResolvedAcpSpawn {
  preset: AcpPresetId;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** profile / worker `acp.authenticate` 指定時のみ。未指定時は preset 既定へフォールバック。 */
  authenticate?: AcpAuthenticateStrategy;
}

/** resume 検証用。sidecar に保存する最小フィンガープリント。 */
export interface AcpSpawnFingerprint {
  preset: AcpPresetId;
  command: string;
  args: string[];
  /** spawn に渡す env（builtin preset → config `acp.env` → profile `acp.env` のマージ結果）。 */
  env?: Record<string, string>;
}

export interface DefaultAcpResolutionOptions {
  /** CLI `--default-acp-cli` */
  defaultAcpCli?: string;
  /** CLI `--default-acp-command`（custom 用） */
  defaultAcpCommand?: string;
  /** CLI `--default-acp-arg`（repeatable、custom 用） */
  defaultAcpArgs?: string[];
  env?: NodeJS.ProcessEnv;
  config?: EnsembleConfig;
}

const BUILTIN_PRESETS: Record<BuiltinAcpPresetId, Omit<ResolvedAcpSpawn, 'preset'>> = {
  cursor: {
    command: 'agent',
    args: ['acp'],
  },
  claude: {
    command: 'claude-agent-acp',
    args: [],
  },
  codex: {
    command: 'codex-acp',
    args: [],
    // Codex ACP's normal Agent mode is workspace-write + on-request approval.
    env: { INITIAL_AGENT_MODE: 'agent' },
  },
  pi: {
    command: 'pi-acp',
    args: [],
  },
};

export function listBuiltinAcpPresetIds(): BuiltinAcpPresetId[] {
  return ['cursor', 'claude', 'codex', 'pi'];
}

export function isBuiltinAcpPresetId(value: string): value is BuiltinAcpPresetId {
  return listBuiltinAcpPresetIds().includes(value as BuiltinAcpPresetId);
}

export function resolveBuiltinAcpPreset(preset: BuiltinAcpPresetId): ResolvedAcpSpawn {
  const definition = BUILTIN_PRESETS[preset];
  return {
    preset,
    command: definition.command,
    args: [...definition.args],
    ...(definition.env ? { env: { ...definition.env } } : {}),
  };
}

/**
 * ACP spawn env のマージ順（後勝ち）:
 * 1. builtin preset 既定（例: codex の `INITIAL_AGENT_MODE`）
 * 2. ensemble config `acp.env`（user → project deep merge 済み）
 * 3. team profile `acp.env` / `workers[].acp.env`（非推奨・移行期間の後勝ち）
 */
export function mergeAcpSpawnEnv(
  preset: AcpPresetId,
  layers: {
    configEnv?: Record<string, string>;
    profileEnv?: Record<string, string>;
  } = {},
): Record<string, string> | undefined {
  const builtinEnv =
    isBuiltinAcpPresetId(preset) && BUILTIN_PRESETS[preset].env
      ? { ...BUILTIN_PRESETS[preset].env }
      : {};
  const merged = {
    ...builtinEnv,
    ...(layers.configEnv ?? {}),
    ...(layers.profileEnv ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

const warnedDeprecatedProfileAcp = new Set<string>();

function warnDeprecatedProfileAcp(source: 'profile' | 'worker', label?: string): void {
  const key = `${source}:${label ?? ''}`;
  if (warnedDeprecatedProfileAcp.has(key)) {
    return;
  }
  warnedDeprecatedProfileAcp.add(key);
  const where = source === 'profile' ? 'profile acp' : `worker acp (${label ?? 'unknown'})`;
  console.warn(
    `[ensemble] Deprecated: team profile ${where} for ACP spawn settings. ` +
      'Use `.ensemble/config.yaml` `acp.defaultPreset` and `acp.env` instead. ' +
      'See docs/config.md.',
  );
}

function normalizeProfileAcpConfig(
  raw: unknown,
  label: string,
): ProfileAcpConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid profile acp in ${label}: expected object`);
  }

  const config = raw as Record<string, unknown>;
  const preset =
    typeof config.preset === 'string' && config.preset.trim()
      ? config.preset.trim()
      : undefined;
  const command =
    typeof config.command === 'string' && config.command.trim()
      ? config.command.trim()
      : undefined;

  let args: string[] | undefined;
  if (config.args !== undefined) {
    if (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== 'string')) {
      throw new Error(`Invalid profile acp.args in ${label}: expected string array`);
    }
    args = config.args;
  }

  let env: Record<string, string> | undefined;
  if (config.env !== undefined) {
    if (!config.env || typeof config.env !== 'object' || Array.isArray(config.env)) {
      throw new Error(`Invalid profile acp.env in ${label}: expected string map`);
    }
    env = {};
    for (const [key, value] of Object.entries(config.env)) {
      if (typeof value !== 'string') {
        throw new Error(`Invalid profile acp.env.${key} in ${label}: expected string`);
      }
      env[key] = value;
    }
  }

  let authenticate: string | undefined;
  if (config.authenticate !== undefined) {
    if (typeof config.authenticate !== 'string' || !config.authenticate.trim()) {
      throw new Error(`Invalid profile acp.authenticate in ${label}: expected non-empty string`);
    }
    authenticate = config.authenticate.trim();
    parseProfileAcpAuthenticate(authenticate, label);
  }

  if (!preset && !command) {
    throw new Error(
      `Invalid profile acp in ${label}: needs "preset" or "command"`,
    );
  }

  if (preset === 'custom' && !command) {
    throw new Error(`Invalid profile acp in ${label}: preset "custom" requires "command"`);
  }

  if (command && !preset) {
    return {
      preset: 'custom',
      command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(authenticate ? { authenticate } : {}),
    };
  }

  return {
    ...(preset ? { preset } : {}),
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(authenticate ? { authenticate } : {}),
  };
}

export function parseProfileAcpConfig(
  raw: unknown,
  label: string,
): ProfileAcpConfig | undefined {
  return normalizeProfileAcpConfig(raw, label);
}

function mergeProfileAcpConfig(
  base?: ProfileAcpConfig,
  override?: ProfileAcpConfig,
): ProfileAcpConfig | undefined {
  if (!base && !override) return undefined;
  if (!base) return override;
  if (!override) return base;

  return {
    preset: override.preset ?? base.preset,
    command: override.command ?? base.command,
    args: [...(base.args ?? []), ...(override.args ?? [])],
    env: { ...(base.env ?? {}), ...(override.env ?? {}) },
    authenticate: override.authenticate ?? base.authenticate,
  };
}

function profileAuthenticateOverride(
  config: ProfileAcpConfig,
): AcpAuthenticateStrategy | undefined {
  if (config.authenticate === undefined) {
    return undefined;
  }
  return parseProfileAcpAuthenticate(config.authenticate);
}

export function resolveAcpConfig(
  config: ProfileAcpConfig,
  options?: { configEnv?: Record<string, string> },
): ResolvedAcpSpawn {
  const preset = config.preset ?? (config.command ? 'custom' : 'cursor');
  const authenticateOverride = profileAuthenticateOverride(config);

  if (preset === 'custom') {
    if (!config.command) {
      throw new Error('ACP custom preset requires "command"');
    }
    const mergedEnv = mergeAcpSpawnEnv('custom', {
      configEnv: options?.configEnv,
      profileEnv: config.env,
    });
    const spawn: ResolvedAcpSpawn = {
      preset: 'custom',
      command: config.command,
      args: [...(config.args ?? [])],
      ...(mergedEnv ? { env: mergedEnv } : {}),
    };
    if (authenticateOverride) {
      spawn.authenticate = authenticateOverride;
    }
    return spawn;
  }

  if (!isBuiltinAcpPresetId(preset)) {
    throw new Error(`Unknown ACP preset "${preset}"`);
  }

  const builtin = resolveBuiltinAcpPreset(preset);
  const mergedEnv = mergeAcpSpawnEnv(preset, {
    configEnv: options?.configEnv,
    profileEnv: config.env,
  });
  const spawn: ResolvedAcpSpawn = {
    ...builtin,
    args: [...builtin.args, ...(config.args ?? [])],
    ...(mergedEnv ? { env: mergedEnv } : {}),
  };
  if (authenticateOverride) {
    spawn.authenticate = authenticateOverride;
  }
  return spawn;
}

function withConfigAcpEnv(
  spawn: ResolvedAcpSpawn,
  configEnv?: Record<string, string>,
): ResolvedAcpSpawn {
  const mergedEnv = mergeAcpSpawnEnv(spawn.preset, { configEnv });
  return { ...spawn, ...(mergedEnv ? { env: mergedEnv } : {}) };
}

export function resolveDefaultAcpSpawn(
  options: DefaultAcpResolutionOptions = {},
): ResolvedAcpSpawn {
  const env = options.env ?? process.env;
  const configEnv = options.config?.acp?.env;
  const command = options.defaultAcpCommand?.trim();
  if (command) {
    return resolveAcpConfig(
      {
        preset: 'custom',
        command,
        ...(options.defaultAcpArgs && options.defaultAcpArgs.length > 0
          ? { args: options.defaultAcpArgs }
          : {}),
      },
      { configEnv },
    );
  }

  const cliPreset = options.defaultAcpCli?.trim();
  if (cliPreset) {
    if (!isBuiltinAcpPresetId(cliPreset)) {
      throw new Error(
        `Invalid --default-acp-cli "${cliPreset}" (expected ${listBuiltinAcpPresetIds().join(' | ')})`,
      );
    }
    return withConfigAcpEnv(resolveBuiltinAcpPreset(cliPreset), configEnv);
  }

  const envPreset = env[ENSEMBLE_DEFAULT_ACP_CLI_ENV]?.trim();
  if (envPreset) {
    if (!isBuiltinAcpPresetId(envPreset)) {
      throw new Error(
        `Invalid ${ENSEMBLE_DEFAULT_ACP_CLI_ENV}="${envPreset}" (expected ${listBuiltinAcpPresetIds().join(' | ')})`,
      );
    }
    return withConfigAcpEnv(resolveBuiltinAcpPreset(envPreset), configEnv);
  }

  const configPreset = options.config?.acp.defaultPreset;
  if (configPreset) {
    return withConfigAcpEnv(resolveBuiltinAcpPreset(configPreset), configEnv);
  }

  return withConfigAcpEnv(resolveBuiltinAcpPreset('cursor'), configEnv);
}

export function resolveWorkerAcpSpawn(input: {
  profileAcp?: ProfileAcpConfig;
  workerAcp?: ProfileAcpConfig;
  workerName?: string;
  defaultOptions?: DefaultAcpResolutionOptions;
}): ResolvedAcpSpawn {
  const configEnv = input.defaultOptions?.config?.acp?.env;
  if (input.profileAcp) {
    warnDeprecatedProfileAcp('profile');
  }
  if (input.workerAcp) {
    warnDeprecatedProfileAcp('worker', input.workerName);
  }
  const merged = mergeProfileAcpConfig(input.profileAcp, input.workerAcp);
  if (merged) {
    return resolveAcpConfig(merged, { configEnv });
  }
  return resolveDefaultAcpSpawn(input.defaultOptions);
}

export function resolveWorkerAcpSpawns(input: {
  profile: Pick<Profile, 'acp' | 'workers'>;
  defaultOptions?: DefaultAcpResolutionOptions;
}): Map<string, ResolvedAcpSpawn> {
  const result = new Map<string, ResolvedAcpSpawn>();
  for (const worker of input.profile.workers) {
    result.set(
      worker.name,
      resolveWorkerAcpSpawn({
        profileAcp: input.profile.acp,
        workerAcp: worker.acp,
        workerName: worker.name,
        defaultOptions: input.defaultOptions,
      }),
    );
  }
  return result;
}

export function acpSpawnFingerprint(spawn: ResolvedAcpSpawn): AcpSpawnFingerprint {
  return {
    preset: spawn.preset,
    command: spawn.command,
    args: [...spawn.args],
    ...(spawn.env && Object.keys(spawn.env).length > 0 ? { env: { ...spawn.env } } : {}),
  };
}

export function formatAcpSpawnFingerprint(spawn: AcpSpawnFingerprint): string {
  const args = spawn.args.length > 0 ? ` ${spawn.args.join(' ')}` : '';
  return `${spawn.preset} (${spawn.command}${args})`;
}

export function assertAcpSpawnMatchesResume(input: {
  expected?: AcpSpawnFingerprint;
  actual: AcpSpawnFingerprint;
  workerName?: string;
}): void {
  if (!input.expected) return;

  const actual = input.actual;
  const same =
    input.expected.preset === actual.preset &&
    input.expected.command === actual.command &&
    arraysEqual(input.expected.args, actual.args) &&
    envMapsEqual(input.expected.env, actual.env);

  if (same) return;

  const label = input.workerName ? `Worker "${input.workerName}"` : 'Worker';
  throw new Error(
    `${label} resume ACP spawn mismatch: sidecar has ${formatAcpSpawnFingerprint(input.expected)}, current profile resolves to ${formatAcpSpawnFingerprint(actual)}`,
  );
}

export function resolvedAcpSpawnToOptions(
  spawn: ResolvedAcpSpawn,
  base?: SpawnAcpProcessOptions,
): SpawnAcpProcessOptions {
  return {
    ...base,
    command: spawn.command,
    args: [...spawn.args],
    authenticate: spawn.authenticate ?? resolveAcpAuthenticateStrategy(spawn),
    ...(spawn.env
      ? {
          env: {
            ...(base?.env ?? process.env),
            ...spawn.env,
          },
        }
      : {}),
  };
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function envMapsEqual(
  left?: Record<string, string>,
  right?: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left ?? {}).sort();
  const rightKeys = Object.keys(right ?? {}).sort();
  if (!arraysEqual(leftKeys, rightKeys)) {
    return false;
  }
  return leftKeys.every((key) => left?.[key] === right?.[key]);
}
