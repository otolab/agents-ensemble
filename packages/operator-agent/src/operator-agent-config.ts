import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ConductorBackend } from '@agents-ensemble/core/operator-runtime';

export const OPERATOR_AGENT_CONFIG_FILE = 'operator-agents.config.yaml';
export const OPERATOR_AGENT_PROFILE_ENV = 'ENSEMBLE_OPERATOR_AGENT_PROFILE';
export const OPERATOR_AGENT_BACKEND_ENV = 'ENSEMBLE_OPERATOR_AGENT_BACKEND';
export const OPERATOR_AGENT_MODEL_ENV = 'ENSEMBLE_OPERATOR_AGENT_MODEL';
export const OPERATOR_AGENT_REASONING_ENV =
  'ENSEMBLE_OPERATOR_AGENT_REASONING';

export interface OperatorAgentSettings {
  backend?: ConductorBackend;
  model?: string;
  reasoning?: string;
}

export interface OperatorAgentPiCommonConfig {
  agentDir?: string;
}

export interface OperatorAgentPiProfileConfig {
  projectDir?: string;
  skills?: boolean;
}

export interface OperatorAgentMcpConfig {
  /** Selected names from `~/.ensemble/mcp.json`; an empty list disables MCP. */
  servers?: string[];
}

export interface OperatorAgentSchedulingConfig {
  batchMaxWaitMs?: number;
  pushThreshold?: number;
  sessionStateWeight?: number;
  openQuestionWeight?: number;
  conductorMessageWeight?: number;
  idleCandidateWeight?: number;
  idlePhaseThresholdMs?: number;
  staleRunningThresholdMs?: number;
  idleAgingMs?: number;
  focusInactivityTimeoutMs?: number;
  idleReevaluationIntervalMs?: number;
}

export const DEFAULT_OPERATOR_AGENT_SCHEDULING = {
  batchMaxWaitMs: 30_000,
  pushThreshold: 10,
  sessionStateWeight: 1,
  openQuestionWeight: 10,
  conductorMessageWeight: 5,
  idleCandidateWeight: 1,
  idlePhaseThresholdMs: 30 * 60_000,
  staleRunningThresholdMs: 60 * 60_000,
  idleAgingMs: 5 * 60_000,
  focusInactivityTimeoutMs: 10 * 60_000,
  idleReevaluationIntervalMs: 60_000,
} as const satisfies Required<OperatorAgentSchedulingConfig>;

const SCHEDULING_RANGES = {
  batchMaxWaitMs: [10_000, 120_000],
  pushThreshold: [1, 10_000],
  sessionStateWeight: [0, 10_000],
  openQuestionWeight: [0, 10_000],
  conductorMessageWeight: [0, 10_000],
  idleCandidateWeight: [0, 10_000],
  idlePhaseThresholdMs: [10 * 60_000, 120 * 60_000],
  staleRunningThresholdMs: [30 * 60_000, 240 * 60_000],
  idleAgingMs: [60_000, 30 * 60_000],
  focusInactivityTimeoutMs: [3 * 60_000, 30 * 60_000],
  idleReevaluationIntervalMs: [30_000, 5 * 60_000],
} as const satisfies Record<
  keyof OperatorAgentSchedulingConfig,
  readonly [number, number]
>;

export interface OperatorAgentProfile {
  include?: string[];
  conductor?: OperatorAgentSettings;
  prompt?: { instructions?: string[] };
  pi?: OperatorAgentPiProfileConfig;
  mcp?: OperatorAgentMcpConfig;
  scheduling?: OperatorAgentSchedulingConfig;
}

export interface OperatorAgentConfiguration {
  version: 1;
  defaultProfile?: string;
  common: {
    conductor?: OperatorAgentSettings;
    pi?: OperatorAgentPiCommonConfig;
    mcp?: OperatorAgentMcpConfig;
    scheduling?: OperatorAgentSchedulingConfig;
  };
  profiles: Record<string, OperatorAgentProfile>;
}

export function operatorAgentConfigPath(userEnsembleRoot: string): string {
  return join(userEnsembleRoot, OPERATOR_AGENT_CONFIG_FILE);
}

export async function loadOperatorAgentConfiguration(
  userEnsembleRoot: string,
): Promise<OperatorAgentConfiguration> {
  const path = operatorAgentConfigPath(userEnsembleRoot);
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) {
      throw new Error(
        `Operator-agent config not found: ${path}. Create this file with at least one profile.`,
      );
    }
    throw error;
  }

  let value: unknown;
  try {
    value = parseYaml(source);
  } catch (error) {
    throw new Error(
      `Invalid operator-agent config YAML at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseOperatorAgentConfiguration(value, path);
}

export function parseOperatorAgentConfiguration(
  value: unknown,
  source = OPERATOR_AGENT_CONFIG_FILE,
): OperatorAgentConfiguration {
  const root = asRecord(value, source);
  assertOnlyKeys(root, ['version', 'defaultProfile', 'common', 'profiles'], source);
  if (root.version !== 1) {
    throw new Error(
      `Invalid operator-agent config ${source}: version must be 1.`,
    );
  }
  const defaultProfile = optionalString(root.defaultProfile, 'defaultProfile', source);
  const common = root.common === undefined
    ? {}
    : parseCommon(root.common, source);
  const rawProfiles = asRecord(root.profiles, `${source}.profiles`);
  const profiles: Record<string, OperatorAgentProfile> = {};
  for (const [name, rawProfile] of Object.entries(rawProfiles)) {
    validateProfileName(name);
    profiles[name] = parseProfile(rawProfile, `${source}.profiles.${name}`);
  }
  if (defaultProfile && !Object.hasOwn(profiles, defaultProfile)) {
    throw new Error(
      `Invalid operator-agent config ${source}: defaultProfile "${defaultProfile}" is not defined in profiles.`,
    );
  }
  return {
    version: 1,
    ...(defaultProfile ? { defaultProfile } : {}),
    common,
    profiles,
  };
}

export function validateProfileName(name: string): string {
  if (
    name === '.' ||
    name === '..' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)
  ) {
    throw new Error(
      `Invalid operator-agent profile name "${name}": use one safe path segment starting with a letter or number.`,
    );
  }
  return name;
}

export function resolveOperatorPath(value: string, base: string): string {
  if (value === '~') return resolve(process.env.HOME ?? homedir(), '.');
  if (value.startsWith('~/')) {
    return resolve(process.env.HOME ?? homedir(), value.slice(2));
  }
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

function parseCommon(
  value: unknown,
  source: string,
): OperatorAgentConfiguration['common'] {
  const record = asRecord(value, `${source}.common`);
  assertOnlyKeys(
    record,
    ['conductor', 'pi', 'mcp', 'scheduling'],
    `${source}.common`,
  );
  return {
    ...(record.conductor === undefined
      ? {}
      : { conductor: parseSettings(record.conductor, `${source}.common.conductor`) }),
    ...(record.pi === undefined
      ? {}
      : { pi: parseCommonPi(record.pi, `${source}.common.pi`) }),
    ...(record.mcp === undefined
      ? {}
      : { mcp: parseMcp(record.mcp, `${source}.common.mcp`) }),
    ...(record.scheduling === undefined
      ? {}
      : {
          scheduling: parseScheduling(
            record.scheduling,
            `${source}.common.scheduling`,
          ),
        }),
  };
}

function parseProfile(value: unknown, source: string): OperatorAgentProfile {
  const record = asRecord(value, source);
  assertOnlyKeys(
    record,
    ['include', 'conductor', 'prompt', 'pi', 'mcp', 'scheduling'],
    source,
  );
  const include =
    record.include === undefined
      ? undefined
      : parseInclude(record.include, `${source}.include`);
  return {
    ...(include !== undefined ? { include } : {}),
    ...(record.conductor === undefined
      ? {}
      : { conductor: parseSettings(record.conductor, `${source}.conductor`) }),
    ...(record.prompt === undefined
      ? {}
      : { prompt: parsePrompt(record.prompt, `${source}.prompt`) }),
    ...(record.pi === undefined
      ? {}
      : { pi: parseProfilePi(record.pi, `${source}.pi`) }),
    ...(record.mcp === undefined
      ? {}
      : { mcp: parseMcp(record.mcp, `${source}.mcp`) }),
    ...(record.scheduling === undefined
      ? {}
      : { scheduling: parseScheduling(record.scheduling, `${source}.scheduling`) }),
  };
}

export function resolveOperatorAgentScheduling(
  common?: OperatorAgentSchedulingConfig,
  profile?: OperatorAgentSchedulingConfig,
): Required<OperatorAgentSchedulingConfig> {
  return {
    ...DEFAULT_OPERATOR_AGENT_SCHEDULING,
    ...common,
    ...profile,
  };
}

function parseScheduling(
  value: unknown,
  source: string,
): OperatorAgentSchedulingConfig {
  const record = asRecord(value, source);
  const keys = Object.keys(
    SCHEDULING_RANGES,
  ) as Array<keyof OperatorAgentSchedulingConfig>;
  assertOnlyKeys(record, keys, source);
  const scheduling: OperatorAgentSchedulingConfig = {};
  for (const key of keys) {
    const raw = record[key];
    if (raw === undefined) continue;
    const [minimum, maximum] = SCHEDULING_RANGES[key];
    if (
      typeof raw !== 'number' ||
      !Number.isSafeInteger(raw) ||
      raw < minimum ||
      raw > maximum
    ) {
      throw new Error(
        `Invalid ${source}.${key}: expected an integer from ${minimum} to ${maximum}${key.endsWith('Ms') ? ' milliseconds' : ''}.`,
      );
    }
    scheduling[key] = raw;
  }
  return scheduling;
}

function parseMcp(value: unknown, source: string): OperatorAgentMcpConfig {
  const record = asRecord(value, source);
  assertOnlyKeys(record, ['servers'], source);
  if (record.servers === undefined) return {};
  if (
    !Array.isArray(record.servers) ||
    !record.servers.every(
      (name) => typeof name === 'string' && name.trim().length > 0,
    )
  ) {
    throw new Error(
      `Invalid ${source}.servers: expected an array of non-empty MCP server names.`,
    );
  }
  const servers = record.servers.map((name: string) => name.trim());
  if (new Set(servers).size !== servers.length) {
    throw new Error(`Invalid ${source}.servers: server names must be unique.`);
  }
  return { servers };
}

function parseSettings(value: unknown, source: string): OperatorAgentSettings {
  const record = asRecord(value, source);
  assertOnlyKeys(record, ['backend', 'model', 'reasoning'], source);
  if (
    record.backend !== undefined &&
    record.backend !== 'cursor' &&
    record.backend !== 'pi'
  ) {
    throw new Error(`Invalid ${source}.backend: expected "cursor" or "pi".`);
  }
  const model = optionalString(record.model, `${source}.model`, source);
  const reasoning = optionalString(
    record.reasoning,
    `${source}.reasoning`,
    source,
  );
  return {
    ...(record.backend ? { backend: record.backend } : {}),
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

function parseCommonPi(
  value: unknown,
  source: string,
): OperatorAgentPiCommonConfig {
  const record = asRecord(value, source);
  assertOnlyKeys(record, ['agentDir'], source);
  const agentDir = optionalString(record.agentDir, `${source}.agentDir`, source);
  return agentDir ? { agentDir } : {};
}

function parseProfilePi(
  value: unknown,
  source: string,
): OperatorAgentPiProfileConfig {
  const record = asRecord(value, source);
  assertOnlyKeys(record, ['projectDir', 'skills'], source);
  const projectDir = optionalString(
    record.projectDir,
    `${source}.projectDir`,
    source,
  );
  if (record.skills !== undefined && typeof record.skills !== 'boolean') {
    throw new Error(`Invalid ${source}.skills: expected a boolean.`);
  }
  return {
    ...(projectDir ? { projectDir } : {}),
    ...(record.skills !== undefined ? { skills: record.skills } : {}),
  };
}

function parsePrompt(
  value: unknown,
  source: string,
): NonNullable<OperatorAgentProfile['prompt']> {
  const record = asRecord(value, source);
  assertOnlyKeys(record, ['instructions'], source);
  if (record.instructions === undefined) return {};
  if (
    !Array.isArray(record.instructions) ||
    !record.instructions.every(
      (instruction) =>
        typeof instruction === 'string' && instruction.trim().length > 0,
    )
  ) {
    throw new Error(
      `Invalid ${source}.instructions: expected an array of non-empty strings.`,
    );
  }
  return {
    instructions: record.instructions.map((instruction: string) =>
      instruction.trim(),
    ),
  };
}

function parseInclude(value: unknown, source: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((pattern) => typeof pattern === 'string')
  ) {
    throw new Error(`${source} must be an array of repository patterns.`);
  }
  return value.map((pattern: string) => normalizeRepositoryPattern(pattern, source));
}

export function normalizeRepositoryPattern(
  value: string,
  source = 'repository filter',
): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/(?:[a-z0-9_.-]+|\*)$/u.test(normalized)) {
    throw new Error(
      `Invalid ${source} "${value}": expected <owner>/<repo> or <owner>/*.`,
    );
  }
  const [owner, repo] = normalized.split('/');
  if (!owner || owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    throw new Error(`Invalid ${source} "${value}".`);
  }
  return normalized;
}

export function repositoryMatchesPatterns(
  githubRepo: string,
  patterns: readonly string[],
): boolean {
  const normalized = githubRepo.toLowerCase();
  return patterns.some((pattern) => {
    if (pattern.endsWith('/*')) {
      return normalized.startsWith(`${pattern.slice(0, -1)}`);
    }
    return normalized === pattern;
  });
}

function optionalString(
  value: unknown,
  field: string,
  source: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${source}.${field}: expected a non-empty string.`);
  }
  return value.trim();
}

function asRecord(value: unknown, source: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${source}: expected a mapping.`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  source: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) {
    throw new Error(`Invalid ${source}: unknown key "${unexpected}".`);
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
