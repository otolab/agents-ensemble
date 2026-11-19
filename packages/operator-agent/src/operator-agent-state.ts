import { isEnoentError as isEnoent } from './operator-utils.js';
import type { Dirent } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ConductorBackend } from '@agents-ensemble/core/operator-runtime';
import { validateProfileName } from './operator-agent-config.js';

export const OPERATOR_AGENT_STATE_VERSION = 2;
export const OPERATOR_AGENT_CONVERSATIONS_DIRECTORY = 'conversations';
export const OPERATOR_AGENT_CONVERSATION_FILE = 'conversation.json';

export interface OperatorAgentState {
  version: typeof OPERATOR_AGENT_STATE_VERSION;
  operatorAgentId: string;
  providerSessionId: string;
  backend: ConductorBackend;
  /** Profile that created this global conversation record. */
  profile: string;
  workspace: string;
  piResourceRoots?: {
    agentDir: string;
    projectDir: string;
  };
  createdAt: number;
  updatedAt: number;
}

export function operatorAgentStatePath(
  userEnsembleRoot: string,
  operatorAgentId: string,
): string {
  validateOperatorAgentId(operatorAgentId);
  return join(
    userEnsembleRoot,
    'operator-agents',
    OPERATOR_AGENT_CONVERSATIONS_DIRECTORY,
    operatorAgentId,
    OPERATOR_AGENT_CONVERSATION_FILE,
  );
}

export function operatorPiSessionDirectory(
  userEnsembleRoot: string,
  operatorAgentId: string,
): string {
  validateOperatorAgentId(operatorAgentId);
  return join(
    userEnsembleRoot,
    'operator-agents',
    OPERATOR_AGENT_CONVERSATIONS_DIRECTORY,
    operatorAgentId,
    'pi-sessions',
  );
}

export async function loadOperatorAgentState(
  userEnsembleRoot: string,
  operatorAgentId: string,
): Promise<OperatorAgentState | undefined> {
  const path = operatorAgentStatePath(userEnsembleRoot, operatorAgentId);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  return parseOperatorAgentState(JSON.parse(raw) as unknown, path);
}

export async function listOperatorAgentStates(
  userEnsembleRoot: string,
): Promise<OperatorAgentState[]> {
  const conversationsDir = join(
    userEnsembleRoot,
    'operator-agents',
    OPERATOR_AGENT_CONVERSATIONS_DIRECTORY,
  );
  let entries: Dirent[];
  try {
    entries = await readdir(conversationsDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = operatorAgentStatePath(userEnsembleRoot, entry.name);
        try {
          const raw = await readFile(path, 'utf8');
          return parseOperatorAgentState(JSON.parse(raw) as unknown, path);
        } catch (error) {
          if (isEnoent(error)) return undefined;
          throw error;
        }
      }),
  );
  return records
    .filter((record): record is OperatorAgentState => record !== undefined)
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        left.operatorAgentId.localeCompare(right.operatorAgentId),
    );
}

export async function saveOperatorAgentState(
  userEnsembleRoot: string,
  state: OperatorAgentState,
): Promise<void> {
  const validated = parseOperatorAgentState(state, '<operator-agent state>');
  const path = operatorAgentStatePath(
    userEnsembleRoot,
    validated.operatorAgentId,
  );
  const existing = await loadOperatorAgentState(
    userEnsembleRoot,
    validated.operatorAgentId,
  );
  if (
    existing &&
    existing.providerSessionId !== validated.providerSessionId
  ) {
    throw new Error(
      `Operator-agent conversation ${validated.operatorAgentId} already refers to a different provider session.`,
    );
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
}

/** Remove the selectable record only; provider transcripts remain untouched. */
export async function clearOperatorAgentState(
  userEnsembleRoot: string,
  operatorAgentId: string,
): Promise<void> {
  await rm(operatorAgentStatePath(userEnsembleRoot, operatorAgentId), {
    force: true,
  });
}

function parseOperatorAgentState(
  value: unknown,
  source: string,
): OperatorAgentState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid operator-agent conversation record at ${source}.`);
  }
  const record = value as Record<string, unknown>;
  if (record.version !== OPERATOR_AGENT_STATE_VERSION) {
    throw new Error(
      `Unsupported operator-agent conversation record version at ${source}: ${String(record.version)}.`,
    );
  }
  const operatorAgentId = requireString(
    record.operatorAgentId,
    'operatorAgentId',
    source,
  );
  validateOperatorAgentId(operatorAgentId);
  const providerSessionId = requireString(
    record.providerSessionId,
    'providerSessionId',
    source,
  );
  const profile = requireString(record.profile, 'profile', source);
  validateProfileName(profile);
  const workspace = requireString(record.workspace, 'workspace', source);
  if (record.backend !== 'cursor' && record.backend !== 'pi') {
    throw new Error(`Invalid operator-agent backend at ${source}.`);
  }
  const createdAt = requireTimestamp(record.createdAt, 'createdAt', source);
  const updatedAt = requireTimestamp(record.updatedAt, 'updatedAt', source);
  const piResourceRoots = record.piResourceRoots;
  if (piResourceRoots !== undefined) {
    if (
      !piResourceRoots ||
      typeof piResourceRoots !== 'object' ||
      Array.isArray(piResourceRoots)
    ) {
      throw new Error(`Invalid operator-agent Pi resource roots at ${source}.`);
    }
    const roots = piResourceRoots as Record<string, unknown>;
    return {
      version: OPERATOR_AGENT_STATE_VERSION,
      operatorAgentId,
      providerSessionId,
      backend: record.backend,
      profile,
      workspace,
      piResourceRoots: {
        agentDir: requireString(roots.agentDir, 'piResourceRoots.agentDir', source),
        projectDir: requireString(
          roots.projectDir,
          'piResourceRoots.projectDir',
          source,
        ),
      },
      createdAt,
      updatedAt,
    };
  }
  return {
    version: OPERATOR_AGENT_STATE_VERSION,
    operatorAgentId,
    providerSessionId,
    backend: record.backend,
    profile,
    workspace,
    createdAt,
    updatedAt,
  };
}

function validateOperatorAgentId(value: string): string {
  if (
    value === '.' ||
    value === '..' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) {
    throw new Error(
      `Invalid operatorAgentId "${value}": expected one safe path segment.`,
    );
  }
  return value;
}

function requireString(value: unknown, field: string, source: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid operator-agent ${field} at ${source}.`);
  }
  return value.trim();
}

function requireTimestamp(value: unknown, field: string, source: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid operator-agent ${field} at ${source}.`);
  }
  return value;
}
