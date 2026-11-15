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

export interface OperatorAgentProfile {
  include?: string[];
  conductor?: OperatorAgentSettings;
  prompt?: { instructions?: string[] };
  pi?: OperatorAgentPiProfileConfig;
}

export interface OperatorAgentConfiguration {
  version: 1;
  defaultProfile?: string;
  common: {
    conductor?: OperatorAgentSettings;
    pi?: OperatorAgentPiCommonConfig;
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
  assertOnlyKeys(record, ['conductor', 'pi'], `${source}.common`);
  return {
    ...(record.conductor === undefined
      ? {}
      : { conductor: parseSettings(record.conductor, `${source}.common.conductor`) }),
    ...(record.pi === undefined
      ? {}
      : { pi: parseCommonPi(record.pi, `${source}.common.pi`) }),
  };
}

function parseProfile(value: unknown, source: string): OperatorAgentProfile {
  const record = asRecord(value, source);
  assertOnlyKeys(record, ['include', 'conductor', 'prompt', 'pi'], source);
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
  };
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
