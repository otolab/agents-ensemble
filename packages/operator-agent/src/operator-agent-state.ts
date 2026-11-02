import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type ConductorBackend,
} from '@agents-ensemble/core/operator-runtime';
import {
  operatorRepositoryStatePath,
  resolveOperatorRepositoryStatePaths,
} from './operator-state-paths.js';

export const OPERATOR_AGENT_STATE_VERSION = 1;

export interface OperatorAgentState {
  version: typeof OPERATOR_AGENT_STATE_VERSION;
  agentId: string;
  backend: ConductorBackend;
  repoRoot: string;
}

export function operatorAgentStatePath(
  repoRoot: string,
  options: {
    location?: 'canonical-slug' | 'user-path-hash';
    issueUrl?: string;
  } = {},
): string {
  return operatorRepositoryStatePath(repoRoot, 'session', options);
}

export async function loadOperatorAgentState(
  repoRoot: string,
): Promise<OperatorAgentState | undefined> {
  const paths = await resolveOperatorRepositoryStatePaths(repoRoot, 'session');
  let sourcePath: string | undefined;
  let raw: string | undefined;
  for (const candidate of paths.readPaths) {
    try {
      raw = await readFile(candidate, 'utf8');
      sourcePath = candidate;
      break;
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
  if (raw === undefined || sourcePath === undefined) return undefined;

  const state = parseOperatorAgentState(JSON.parse(raw) as unknown);
  if (sourcePath !== paths.targetPath) {
    await saveOperatorAgentState(repoRoot, state);
  }
  return state;
}

export async function saveOperatorAgentState(
  repoRoot: string,
  state: OperatorAgentState,
): Promise<void> {
  const validated = parseOperatorAgentState(state);
  const path = (
    await resolveOperatorRepositoryStatePaths(repoRoot, 'session')
  ).targetPath;
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
}

export async function clearOperatorAgentState(repoRoot: string): Promise<void> {
  const paths = await resolveOperatorRepositoryStatePaths(repoRoot, 'session');
  await Promise.all(
    paths.readPaths.map((path) => rm(path, { force: true })),
  );
}

function parseOperatorAgentState(value: unknown): OperatorAgentState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid operator-agent session state: expected an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== OPERATOR_AGENT_STATE_VERSION) {
    throw new Error(
      `Unsupported operator-agent session state version: ${String(record.version)}`,
    );
  }
  if (typeof record.agentId !== 'string' || record.agentId.trim() === '') {
    throw new Error('Invalid operator-agent session state: agentId.');
  }
  if (record.backend !== 'cursor' && record.backend !== 'pi') {
    throw new Error('Invalid operator-agent session state: backend.');
  }
  if (typeof record.repoRoot !== 'string' || record.repoRoot.trim() === '') {
    throw new Error('Invalid operator-agent session state: repoRoot.');
  }
  return {
    version: OPERATOR_AGENT_STATE_VERSION,
    agentId: record.agentId,
    backend: record.backend,
    repoRoot: record.repoRoot,
  };
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
