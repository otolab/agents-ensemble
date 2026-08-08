import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OpenQuestion } from '../escalation/open-question.js';
import type { Profile } from '../profile/types.js';

export const SESSION_SIDECAR_VERSION = 1;

export interface WorkerSessionSidecar {
  acpSessionId: string;
}

export interface SessionSidecar {
  version: typeof SESSION_SIDECAR_VERSION;
  conductorAgentId: string;
  issueUrl: string;
  repoRoot: string;
  profile: Profile;
  profilePath?: string;
  openQuestions: OpenQuestion[];
  sequence: number;
  workers: Record<string, WorkerSessionSidecar>;
  /** flush 時刻（Unix ms）。`--continue` で最新セッションを選ぶために使う。 */
  updatedAt: number;
}

export interface FindLatestSessionSidecarInput {
  repoRoot: string;
  issueUrl: string;
}

export interface SessionSidecarPathOptions {
  repoRoot: string;
  conductorAgentId: string;
}

export function sessionSidecarDir(repoRoot: string): string {
  return join(repoRoot, '.ensemble', 'sessions');
}

export function sessionSidecarPath(options: SessionSidecarPathOptions): string {
  return join(sessionSidecarDir(options.repoRoot), `${options.conductorAgentId}.json`);
}

export async function loadSessionSidecar(
  path: string,
): Promise<SessionSidecar | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    return parseSessionSidecar(JSON.parse(raw));
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

export async function saveSessionSidecar(
  path: string,
  sidecar: SessionSidecar,
): Promise<void> {
  const parsed = parseSessionSidecar({
    ...sidecar,
    updatedAt: Date.now(),
  });
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
}

export async function listSessionSidecars(
  repoRoot: string,
): Promise<SessionSidecar[]> {
  const dir = sessionSidecarDir(repoRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }

  const sidecars: SessionSidecar[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.endsWith('.tmp')) continue;
    const sidecar = await loadSessionSidecar(join(dir, entry));
    if (sidecar) sidecars.push(sidecar);
  }
  return sidecars;
}

/** 同一 Issue の sidecar のうち `updatedAt` が最新のものを返す。 */
export async function findLatestSessionSidecarForIssue(
  input: FindLatestSessionSidecarInput,
): Promise<SessionSidecar | undefined> {
  const matches = (await listSessionSidecars(input.repoRoot)).filter(
    (sidecar) =>
      sidecar.issueUrl === input.issueUrl &&
      sidecar.repoRoot === input.repoRoot,
  );
  if (matches.length === 0) return undefined;

  return matches.reduce((latest, sidecar) =>
    sidecar.updatedAt > latest.updatedAt ? sidecar : latest,
  );
}

export function assertSessionSidecarMatches(
  sidecar: SessionSidecar,
  input: { issueUrl: string; repoRoot: string; conductorAgentId: string },
): void {
  if (sidecar.conductorAgentId !== input.conductorAgentId) {
    throw new Error(
      `Session sidecar conductorAgentId mismatch: ${sidecar.conductorAgentId} !== ${input.conductorAgentId}`,
    );
  }
  if (sidecar.issueUrl !== input.issueUrl) {
    throw new Error(
      `Session sidecar issueUrl mismatch: ${sidecar.issueUrl} !== ${input.issueUrl}`,
    );
  }
  if (sidecar.repoRoot !== input.repoRoot) {
    throw new Error(
      `Session sidecar repoRoot mismatch: ${sidecar.repoRoot} !== ${input.repoRoot}`,
    );
  }
}

function parseSessionSidecar(value: unknown): SessionSidecar {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid session sidecar: not an object');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== SESSION_SIDECAR_VERSION) {
    throw new Error(`Unsupported session sidecar version: ${record.version}`);
  }
  if (typeof record.conductorAgentId !== 'string') {
    throw new Error('Invalid session sidecar: conductorAgentId');
  }
  if (typeof record.issueUrl !== 'string') {
    throw new Error('Invalid session sidecar: issueUrl');
  }
  if (typeof record.repoRoot !== 'string') {
    throw new Error('Invalid session sidecar: repoRoot');
  }
  if (!record.profile || typeof record.profile !== 'object') {
    throw new Error('Invalid session sidecar: profile');
  }
  if (!Array.isArray(record.openQuestions)) {
    throw new Error('Invalid session sidecar: openQuestions');
  }
  if (typeof record.sequence !== 'number') {
    throw new Error('Invalid session sidecar: sequence');
  }
  if (!record.workers || typeof record.workers !== 'object') {
    throw new Error('Invalid session sidecar: workers');
  }
  const updatedAt =
    typeof record.updatedAt === 'number' ? record.updatedAt : 0;

  const workers: Record<string, WorkerSessionSidecar> = {};
  for (const [name, entry] of Object.entries(
    record.workers as Record<string, unknown>,
  )) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Invalid session sidecar worker entry: ${name}`);
    }
    const worker = entry as Record<string, unknown>;
    if (typeof worker.acpSessionId !== 'string') {
      throw new Error(`Invalid session sidecar worker acpSessionId: ${name}`);
    }
    workers[name] = { acpSessionId: worker.acpSessionId };
  }

  return {
    version: SESSION_SIDECAR_VERSION,
    conductorAgentId: record.conductorAgentId,
    issueUrl: record.issueUrl,
    repoRoot: record.repoRoot,
    profile: record.profile as Profile,
    ...(typeof record.profilePath === 'string'
      ? { profilePath: record.profilePath }
      : {}),
    openQuestions: record.openQuestions as OpenQuestion[],
    sequence: record.sequence,
    workers,
    updatedAt,
  };
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
