import type { SpawnAcpProcessOptions } from './acp-process.js';
import {
  resolveAcpAuthenticateStrategy,
  type AcpAuthenticateStrategy,
} from './resolve-acp-auth.js';
import type { EnsembleConfig } from '../config/types.js';

/** Built-in ACP preset id（Phase 1）。拡張時は adapter / capability を別途追加可能。 */
export type BuiltinAcpPresetId = 'cursor' | 'claude' | 'codex' | 'pi';

export type AcpPresetId = BuiltinAcpPresetId | 'custom';

export const ENSEMBLE_DEFAULT_ACP_CLI_ENV = 'ENSEMBLE_DEFAULT_ACP_CLI';

/** spawn 解決結果。 */
export interface ResolvedAcpSpawn {
  preset: AcpPresetId;
  command: string;
  args: string[];
  env?: Record<string, string>;
  authenticate?: AcpAuthenticateStrategy;
}

/** resume 検証用。SessionResumeStore に保存する最小フィンガープリント。 */
export interface AcpSpawnFingerprint {
  preset: AcpPresetId;
  command: string;
  args: string[];
  /** spawn に渡す env（builtin preset → config `acp.env` のマージ結果）。 */
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
 */
export function mergeAcpSpawnEnv(
  preset: AcpPresetId,
  configEnv?: Record<string, string>,
): Record<string, string> | undefined {
  const builtinEnv =
    isBuiltinAcpPresetId(preset) && BUILTIN_PRESETS[preset].env
      ? { ...BUILTIN_PRESETS[preset].env }
      : {};
  const merged = {
    ...builtinEnv,
    ...(configEnv ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function resolveCustomAcpSpawn(
  input: { command: string; args?: string[] },
  configEnv?: Record<string, string>,
): ResolvedAcpSpawn {
  const mergedEnv = mergeAcpSpawnEnv('custom', configEnv);
  return {
    preset: 'custom',
    command: input.command,
    args: [...(input.args ?? [])],
    ...(mergedEnv ? { env: mergedEnv } : {}),
  };
}

function withConfigAcpEnv(
  spawn: ResolvedAcpSpawn,
  configEnv?: Record<string, string>,
): ResolvedAcpSpawn {
  const mergedEnv = mergeAcpSpawnEnv(spawn.preset, configEnv);
  return { ...spawn, ...(mergedEnv ? { env: mergedEnv } : {}) };
}

export function resolveDefaultAcpSpawn(
  options: DefaultAcpResolutionOptions = {},
): ResolvedAcpSpawn {
  const env = options.env ?? process.env;
  const configEnv = options.config?.acp?.env;
  const command = options.defaultAcpCommand?.trim();
  if (command) {
    return resolveCustomAcpSpawn(
      {
        command,
        ...(options.defaultAcpArgs && options.defaultAcpArgs.length > 0
          ? { args: options.defaultAcpArgs }
          : {}),
      },
      configEnv,
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

export function resolveWorkerAcpSpawn(input?: {
  defaultOptions?: DefaultAcpResolutionOptions;
}): ResolvedAcpSpawn {
  return resolveDefaultAcpSpawn(input?.defaultOptions);
}

export function resolveWorkerAcpSpawns(input: {
  workers: Array<{ name: string }>;
  defaultOptions?: DefaultAcpResolutionOptions;
}): Map<string, ResolvedAcpSpawn> {
  const spawn = resolveDefaultAcpSpawn(input.defaultOptions);
  const result = new Map<string, ResolvedAcpSpawn>();
  for (const worker of input.workers) {
    result.set(worker.name, spawn);
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
    envMapsEqualForResume(input.expected.env, actual.env);

  if (same) return;

  const label = input.workerName ? `Worker "${input.workerName}"` : 'Worker';
  throw new Error(
    `${label} resume ACP spawn mismatch: saved resume state has ${formatAcpSpawnFingerprint(input.expected)}, current profile resolves to ${formatAcpSpawnFingerprint(actual)}`,
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

/** 旧形式の SessionResumeStore（env 未保存）では env 比較をスキップし preset/command/args のみ照合する。 */
function envMapsEqualForResume(
  expected?: Record<string, string>,
  actual?: Record<string, string>,
): boolean {
  if (!expected || Object.keys(expected).length === 0) {
    return true;
  }
  return envMapsEqual(expected, actual);
}
