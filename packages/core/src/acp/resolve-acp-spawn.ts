import type { SpawnAcpProcessOptions } from './acp-process.js';
import type { Profile, ProfileAcpConfig } from '../profile/types.js';

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
}

/** resume 検証用。sidecar に保存する最小フィンガープリント。 */
export interface AcpSpawnFingerprint {
  preset: AcpPresetId;
  command: string;
  args: string[];
}

export interface DefaultAcpResolutionOptions {
  /** CLI `--default-acp-cli` */
  defaultAcpCli?: string;
  /** CLI `--default-acp-command`（custom 用） */
  defaultAcpCommand?: string;
  /** CLI `--default-acp-arg`（repeatable、custom 用） */
  defaultAcpArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

const BUILTIN_PRESETS: Record<BuiltinAcpPresetId, Omit<ResolvedAcpSpawn, 'preset'>> = {
  cursor: {
    command: 'agent',
    args: ['acp'],
  },
  claude: {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
  },
  codex: {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp'],
  },
  pi: {
    command: 'npx',
    args: ['-y', 'pi-acp'],
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

  if (!preset && !command) {
    throw new Error(
      `Invalid profile acp in ${label}: needs "preset" or "command"`,
    );
  }

  if (preset === 'custom' && !command) {
    throw new Error(`Invalid profile acp in ${label}: preset "custom" requires "command"`);
  }

  if (command && !preset) {
    return { preset: 'custom', command, ...(args ? { args } : {}), ...(env ? { env } : {}) };
  }

  return {
    ...(preset ? { preset } : {}),
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
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
  };
}

export function resolveAcpConfig(config: ProfileAcpConfig): ResolvedAcpSpawn {
  const preset = config.preset ?? (config.command ? 'custom' : 'cursor');

  if (preset === 'custom') {
    if (!config.command) {
      throw new Error('ACP custom preset requires "command"');
    }
    return {
      preset: 'custom',
      command: config.command,
      args: [...(config.args ?? [])],
      ...(config.env && Object.keys(config.env).length > 0 ? { env: { ...config.env } } : {}),
    };
  }

  if (!isBuiltinAcpPresetId(preset)) {
    throw new Error(`Unknown ACP preset "${preset}"`);
  }

  const builtin = resolveBuiltinAcpPreset(preset);
  const mergedEnv = {
    ...(builtin.env ?? {}),
    ...(config.env ?? {}),
  };
  return {
    ...builtin,
    args: [...builtin.args, ...(config.args ?? [])],
    ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {}),
  };
}

export function resolveDefaultAcpSpawn(
  options: DefaultAcpResolutionOptions = {},
): ResolvedAcpSpawn {
  const env = options.env ?? process.env;
  const command = options.defaultAcpCommand?.trim();
  if (command) {
    return resolveAcpConfig({
      preset: 'custom',
      command,
      ...(options.defaultAcpArgs && options.defaultAcpArgs.length > 0
        ? { args: options.defaultAcpArgs }
        : {}),
    });
  }

  const cliPreset = options.defaultAcpCli?.trim();
  if (cliPreset) {
    if (!isBuiltinAcpPresetId(cliPreset)) {
      throw new Error(
        `Invalid --default-acp-cli "${cliPreset}" (expected ${listBuiltinAcpPresetIds().join(' | ')})`,
      );
    }
    return resolveBuiltinAcpPreset(cliPreset);
  }

  const envPreset = env[ENSEMBLE_DEFAULT_ACP_CLI_ENV]?.trim();
  if (envPreset) {
    if (!isBuiltinAcpPresetId(envPreset)) {
      throw new Error(
        `Invalid ${ENSEMBLE_DEFAULT_ACP_CLI_ENV}="${envPreset}" (expected ${listBuiltinAcpPresetIds().join(' | ')})`,
      );
    }
    return resolveBuiltinAcpPreset(envPreset);
  }

  return resolveBuiltinAcpPreset('cursor');
}

export function resolveWorkerAcpSpawn(input: {
  profileAcp?: ProfileAcpConfig;
  workerAcp?: ProfileAcpConfig;
  defaultOptions?: DefaultAcpResolutionOptions;
}): ResolvedAcpSpawn {
  const merged = mergeProfileAcpConfig(input.profileAcp, input.workerAcp);
  if (merged) {
    return resolveAcpConfig(merged);
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
    arraysEqual(input.expected.args, actual.args);

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
