import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../core/test/integration/test-acp.yaml',
);

export interface DispatchWorkerE2eConfig {
  agentCommand?: string;
  agentArgs?: string[];
  issueUrl: string;
  skillName: string;
  repoRoot: string;
}

export function loadDispatchWorkerE2eConfig(): DispatchWorkerE2eConfig | undefined {
  if (!existsSync(CONFIG_PATH)) return undefined;
  const config = yaml.load(readFileSync(CONFIG_PATH, 'utf-8')) as {
    agentCommand?: string;
    agentArgs?: string[];
    issueUrl?: string;
    skillName?: string;
    repoRoot?: string;
  };
  if (!config.issueUrl || !config.skillName || !config.repoRoot) return undefined;
  return {
    agentCommand: config.agentCommand,
    agentArgs: config.agentArgs,
    issueUrl: config.issueUrl,
    skillName: config.skillName,
    repoRoot: config.repoRoot,
  };
}

export function hasDispatchWorkerE2eConfig(): boolean {
  return loadDispatchWorkerE2eConfig() != null;
}
