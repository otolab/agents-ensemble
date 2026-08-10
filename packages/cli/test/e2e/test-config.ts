import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { hasConductorAuth } from '@agents-ensemble/core';

const CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../core/test/integration/test-acp.yaml',
);

const FIXTURE_CONDUCTOR_CWD = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../',
);

const SMOKE_PROFILE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/e2e-smoke/profile.yaml',
);

export const OPERATOR_E2E_PROFILE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/e2e-operator/profile.yaml',
);

export const ROUNDTRIP_E2E_PROFILE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/e2e-roundtrip/profile.yaml',
);

export interface E2eConfig {
  agentCommand?: string;
  agentArgs?: string[];
  cwd?: string;
  issueUrl: string;
  repoRoot: string;
  name?: string;
  kind?: string;
  systemPrompt?: string;
  conductorCwd?: string;
  conductorModelId?: string;
  profilePath?: string;
}

interface RawE2eConfig {
  agentCommand?: string;
  agentArgs?: string[];
  cwd?: string;
  issueUrl?: string;
  name?: string;
  kind?: string;
  systemPrompt?: string;
  repoRoot?: string;
  conductorCwd?: string;
  conductorModelId?: string;
  profilePath?: string;
}

function loadRawE2eConfig(): RawE2eConfig | undefined {
  if (!existsSync(CONFIG_PATH)) return undefined;
  return yaml.load(readFileSync(CONFIG_PATH, 'utf-8')) as RawE2eConfig;
}

export function loadDispatchWorkerE2eConfig(): E2eConfig | undefined {
  const config = loadRawE2eConfig();
  if (!config?.issueUrl || !config.repoRoot) {
    return undefined;
  }

  return {
    agentCommand: config.agentCommand,
    agentArgs: config.agentArgs,
    cwd: config.cwd,
    issueUrl: config.issueUrl,
    kind: config.kind,
    systemPrompt: config.systemPrompt,
    name: config.name,
    repoRoot: config.repoRoot,
    conductorCwd: config.conductorCwd,
    conductorModelId: config.conductorModelId,
  };
}

export function hasDispatchWorkerE2eConfig(): boolean {
  return loadDispatchWorkerE2eConfig() != null;
}

export interface IssueE2eConfig {
  issueUrl: string;
  repoRoot: string;
  conductorCwd: string;
  conductorModelId: string;
  profilePath: string;
}

export function loadIssueE2eConfig(): IssueE2eConfig | undefined {
  const config = loadRawE2eConfig();
  if (!config?.issueUrl || !config.repoRoot) return undefined;

  return {
    issueUrl: config.issueUrl,
    repoRoot: config.repoRoot,
    conductorCwd: config.conductorCwd ?? FIXTURE_CONDUCTOR_CWD,
    conductorModelId:
      config.conductorModelId ??
      process.env.CONDUCTOR_MODEL_ID ??
      'auto',
    profilePath: config.profilePath ?? SMOKE_PROFILE_PATH,
  };
}

export function hasIssueE2eConfig(): boolean {
  return loadIssueE2eConfig() != null && hasConductorAuth();
}
