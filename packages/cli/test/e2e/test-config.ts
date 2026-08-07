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

export interface E2eConfig {
  agentCommand?: string;
  agentArgs?: string[];
  cwd?: string;
  issueUrl: string;
  skillName: string;
  repoRoot: string;
  conductorCwd?: string;
  conductorModelId?: string;
}

interface RawE2eConfig {
  agentCommand?: string;
  agentArgs?: string[];
  cwd?: string;
  issueUrl?: string;
  skillName?: string;
  repoRoot?: string;
  conductorCwd?: string;
  conductorModelId?: string;
}

function loadRawE2eConfig(): RawE2eConfig | undefined {
  if (!existsSync(CONFIG_PATH)) return undefined;
  return yaml.load(readFileSync(CONFIG_PATH, 'utf-8')) as RawE2eConfig;
}

export function loadDispatchWorkerE2eConfig(): E2eConfig | undefined {
  const config = loadRawE2eConfig();
  if (!config?.issueUrl || !config.skillName || !config.repoRoot) {
    return undefined;
  }

  return {
    agentCommand: config.agentCommand,
    agentArgs: config.agentArgs,
    cwd: config.cwd,
    issueUrl: config.issueUrl,
    skillName: config.skillName,
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
  };
}

export function hasIssueE2eConfig(): boolean {
  return loadIssueE2eConfig() != null && hasConductorAuth();
}
