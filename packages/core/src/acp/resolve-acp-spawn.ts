import { createHash } from 'node:crypto';
import type { SpawnAcpProcessOptions } from './acp-process.js';
import {
  resolveAcpAuthenticateStrategy,
  type AcpAuthenticateStrategy,
} from './resolve-acp-auth.js';
import type { AcpModelTag, EnsembleConfig } from '../config/types.js';

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
  /** Effective profile tier and environment-specific model ID. */
  modelTag?: AcpModelTag;
  model?: string;
  /** Preset-specific session metadata, currently used by Claude ACP. */
  sessionMeta?: Record<string, unknown>;
}

/** resume 検証用。SessionResumeStore に保存する最小フィンガープリント。 */
export interface AcpSpawnFingerprint {
  preset: AcpPresetId;
  command: string;
  args: string[];
  /** spawn env の canonical SHA-256。値そのものは保存しない。 */
  envDigest?: string;
  /** Worker tier used to resolve this process. */
  modelTag?: AcpModelTag;
  /** Resolved ACP model ID (model IDs are not credentials). */
  model?: string;
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
  modelTag?: AcpModelTag;
}): ResolvedAcpSpawn {
  const modelTag = input?.modelTag ?? 'default';
  const spawn = resolveDefaultAcpSpawn(input?.defaultOptions);
  const modelKey = input?.defaultOptions?.config?.acp.tags?.[modelTag];
  if (!modelKey) {
    return { ...spawn, modelTag };
  }

  const model = input?.defaultOptions?.config?.acp.models?.[modelKey];
  if (!model) {
    throw new Error(
      `ACP model tag "${modelTag}" references undefined acp.models key "${modelKey}"`,
    );
  }

  return injectAcpModel(
    spawn,
    modelTag,
    model,
    input?.defaultOptions?.env ?? process.env,
  );
}

export function resolveWorkerAcpSpawns(input: {
  workers: Array<{ name: string; modelTag?: AcpModelTag }>;
  defaultOptions?: DefaultAcpResolutionOptions;
}): Map<string, ResolvedAcpSpawn> {
  const result = new Map<string, ResolvedAcpSpawn>();
  for (const worker of input.workers) {
    result.set(
      worker.name,
      resolveWorkerAcpSpawn({
        defaultOptions: input.defaultOptions,
        modelTag: worker.modelTag,
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
    ...(spawn.modelTag !== undefined ? { modelTag: spawn.modelTag } : {}),
    ...(spawn.model !== undefined ? { model: spawn.model } : {}),
    ...(spawn.env && Object.keys(spawn.env).length > 0
      ? { envDigest: computeAcpSpawnEnvDigest(spawn.env) }
      : {}),
  };
}

/** Hash a canonical env map so resume can compare it without persisting values. */
export function computeAcpSpawnEnvDigest(env: Record<string, string>): string {
  const canonicalEnv = Object.fromEntries(
    Object.keys(env)
      .sort()
      .map((key) => [key, env[key]]),
  );
  return createHash('sha256').update(JSON.stringify(canonicalEnv)).digest('hex');
}

export function formatAcpSpawnFingerprint(spawn: AcpSpawnFingerprint): string {
  const args = spawn.args.length > 0 ? ` ${spawn.args.join(' ')}` : '';
  const model = spawn.model
    ? `, modelTag=${spawn.modelTag ?? 'unknown'}, model=${spawn.model}`
    : spawn.modelTag
      ? `, modelTag=${spawn.modelTag}`
      : '';
  return `${spawn.preset} (${spawn.command}${args}${model})`;
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
    (input.expected.modelTag === undefined ||
      input.expected.modelTag === actual.modelTag) &&
    (input.expected.model === undefined ||
      input.expected.model === actual.model) &&
    (input.expected.envDigest === undefined ||
      input.expected.envDigest === actual.envDigest);

  if (same) return;

  const label = input.workerName ? `Worker "${input.workerName}"` : 'Worker';
  throw new Error(
    `${label} resume ACP spawn mismatch: saved resume store has ${formatAcpSpawnFingerprint(input.expected)}, current profile resolves to ${formatAcpSpawnFingerprint(actual)}`,
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
    ...(spawn.sessionMeta ? { sessionMeta: spawn.sessionMeta } : {}),
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

function injectAcpModel(
  spawn: ResolvedAcpSpawn,
  modelTag: AcpModelTag,
  model: string,
  processEnv: NodeJS.ProcessEnv,
): ResolvedAcpSpawn {
  switch (spawn.preset) {
    case 'cursor':
      return {
        ...spawn,
        args: ['--model', model, ...spawn.args],
        modelTag,
        model,
      };
    case 'claude':
      return {
        ...spawn,
        modelTag,
        model,
        sessionMeta: {
          ...(spawn.sessionMeta ?? {}),
          claudeCode: {
            options: {
              settings: { model },
            },
          },
        },
      };
    case 'codex': {
      const env = { ...(spawn.env ?? {}) };
      let sessionConfig: Record<string, unknown> = {};
      const existing =
        env.CODEX_CONFIG ?? processEnv.CODEX_CONFIG;
      if (existing !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(existing);
        } catch {
          throw new Error(
            'ACP model injection for codex requires acp.env.CODEX_CONFIG to be a JSON object',
          );
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error(
            'ACP model injection for codex requires acp.env.CODEX_CONFIG to be a JSON object',
          );
        }
        sessionConfig = parsed as Record<string, unknown>;
      }
      env.CODEX_CONFIG = JSON.stringify({ ...sessionConfig, model });
      return { ...spawn, env, modelTag, model };
    }
    case 'pi':
    case 'custom':
      throw new Error(
        `ACP preset "${spawn.preset}" does not support configured model injection (worker modelTag "${modelTag}", model "${model}")`,
      );
  }
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
