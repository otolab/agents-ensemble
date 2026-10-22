import { chmod, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OpenQuestion } from '../escalation/open-question.js';
import type { GitHubMonitorCursor } from '../github/github-monitor-cursor.js';
import type { AcpSpawnFingerprint } from '../acp/resolve-acp-spawn.js';
import type { ConductorBackend } from '../config/types.js';
import type { ResolvedProfile } from '../profile/types.js';

export const SESSION_RESUME_STATE_VERSION = 1;

/** @deprecated Use SESSION_RESUME_STATE_VERSION; retained until the next major release. */
export const SESSION_SIDECAR_VERSION = SESSION_RESUME_STATE_VERSION;

export type SessionLifecycle =
  | 'closed'
  | 'exited'
  | 'interrupted'
  | 'unknown';

export class SessionResumeStateNotFoundError extends Error {
  readonly code: string = 'SESSION_RESUME_STATE_NOT_FOUND';

  constructor(
    public readonly conductorAgentId: string,
    public readonly path: string,
  ) {
    super(
      `Session resume state not found for resume (agentId=${conductorAgentId}, path=${path})`,
    );
    this.name = 'SessionResumeStateNotFoundError';
  }
}

/** @deprecated Use SessionResumeStateNotFoundError; retained until the next major release. */
export class SessionSidecarNotFoundError extends SessionResumeStateNotFoundError {
  override readonly code = 'SESSION_SIDECAR_NOT_FOUND';

  constructor(conductorAgentId: string, path: string) {
    super(conductorAgentId, path);
    this.name = 'SessionSidecarNotFoundError';
  }
}

/** @deprecated Use WorkerSessionResumeState; retained until the next major release. */
export type WorkerSessionSidecar = WorkerSessionResumeState;

export interface WorkerSessionResumeState {
  acpSessionId: string;
  /** ACP `session/new` / `session/load` に渡した cwd（resume 検証用）。 */
  acpCwd?: string;
  /** resume 時の ACP spawn フィンガープリント（preset + command + args）。 */
  acpSpawn?: AcpSpawnFingerprint;
}

export interface SessionResumeState {
  version: typeof SESSION_RESUME_STATE_VERSION;
  conductorAgentId: string;
  /** 起動時に選択した conductor backend。旧形式の欠落値は cursor。 */
  conductorBackend?: ConductorBackend;
  /** 初回 `prompt_worker` まで ACP attach を遅延する。旧形式は eager。 */
  lazyWorkers?: boolean;
  /** 稼働中 session の local control socket。teardown 時に除去する。 */
  harnessSocketPath?: string;
  issueUrl: string;
  repoRoot: string;
  profile: ResolvedProfile;
  profilePath?: string;
  openQuestions: OpenQuestion[];
  sequence: number;
  workers: Record<string, WorkerSessionResumeState>;
  /** GitHub 監視カーソルと未配送更新（#39）。 */
  githubMonitor?: GitHubMonitorCursor;
  /** Harness-resolved MCP map digest used to reject unsafe resume. */
  mcpConfigDigest?: string;
  /** Last completed process lifecycle; absent legacy values are unknown. */
  lifecycle?: SessionLifecycle;
  /** flush 時刻（Unix ms）。`--continue` で最新セッションを選ぶために使う。 */
  updatedAt: number;
}

/** @deprecated Use SessionResumeState; retained until the next major release. */
export type SessionSidecar = SessionResumeState;

export interface FindLatestSessionResumeStateInput {
  repoRoot: string;
  issueUrl: string;
}

/** @deprecated Use FindLatestSessionResumeStateInput; retained until the next major release. */
export type FindLatestSessionSidecarInput = FindLatestSessionResumeStateInput;

export interface SessionResumeStorePathOptions {
  repoRoot: string;
  conductorAgentId: string;
}

/** @deprecated Use SessionResumeStorePathOptions; retained until the next major release. */
export type SessionSidecarPathOptions = SessionResumeStorePathOptions;

export function sessionResumeStoreDir(repoRoot: string): string {
  return join(repoRoot, '.ensemble', 'sessions');
}

export function sessionResumeStorePath(options: SessionResumeStorePathOptions): string {
  return join(sessionResumeStoreDir(options.repoRoot), `${options.conductorAgentId}.json`);
}

export async function loadSessionResumeState(
  path: string,
): Promise<SessionResumeState | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    return parseSessionResumeState(JSON.parse(raw));
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

/** `resumeAgentId` 指定時に SessionResumeStore が無い場合は起動失敗とする。 */
export async function requireSessionResumeStateForResume(input: {
  repoRoot: string;
  conductorAgentId: string;
}): Promise<SessionResumeState> {
  const path = sessionResumeStorePath(input);
  const resumeState = await loadSessionResumeState(path);
  if (!resumeState) {
    throw new SessionResumeStateNotFoundError(input.conductorAgentId, path);
  }
  return resumeState;
}

/** @deprecated Use requireSessionResumeStateForResume; retained until the next major release. */
export async function requireSessionSidecarForResume(input: {
  repoRoot: string;
  conductorAgentId: string;
}): Promise<SessionSidecar> {
  try {
    return await requireSessionResumeStateForResume(input);
  } catch (error) {
    if (error instanceof SessionResumeStateNotFoundError) {
      throw new SessionSidecarNotFoundError(
        input.conductorAgentId,
        sessionResumeStorePath(input),
      );
    }
    throw error;
  }
}

export async function saveSessionResumeState(
  path: string,
  resumeState: SessionResumeState,
): Promise<void> {
  const parsed = parseSessionResumeState({
    ...resumeState,
    updatedAt: Date.now(),
  });
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tempPath = `${path}.tmp`;
  await writeFile(
    tempPath,
    `${JSON.stringify(parsed, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
}

/** @deprecated Use saveSessionResumeState; retained until the next major release. */
export const saveSessionSidecar = saveSessionResumeState;

export async function listSessionResumeStates(
  repoRoot: string,
): Promise<SessionResumeState[]> {
  const dir = sessionResumeStoreDir(repoRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }

  const resumeStates: SessionResumeState[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.endsWith('.tmp')) continue;
    const resumeState = await loadSessionResumeState(join(dir, entry));
    if (resumeState) resumeStates.push(resumeState);
  }
  return resumeStates;
}

/** @deprecated Use listSessionResumeStates; retained until the next major release. */
export const listSessionSidecars = listSessionResumeStates;

/** 同一 Issue の SessionResumeStore のうち `updatedAt` が最新のものを返す。 */
export async function findLatestSessionResumeStateForIssue(
  input: FindLatestSessionResumeStateInput,
): Promise<SessionResumeState | undefined> {
  const matches = (await listSessionResumeStates(input.repoRoot)).filter(
    (resumeState) =>
      resumeState.issueUrl === input.issueUrl &&
      resumeState.repoRoot === input.repoRoot,
  );
  if (matches.length === 0) return undefined;

  return matches.reduce((latest, resumeState) =>
    resumeState.updatedAt > latest.updatedAt ? resumeState : latest,
  );
}

/** @deprecated Use findLatestSessionResumeStateForIssue; retained until the next major release. */
export const findLatestSessionSidecarForIssue =
  findLatestSessionResumeStateForIssue;

export function assertSessionResumeStateMatches(
  resumeState: SessionResumeState,
  input: {
    issueUrl: string;
    repoRoot: string;
    conductorAgentId: string;
    conductorBackend?: ConductorBackend;
    /** Current harness-resolved MCP map digest. */
    mcpConfigDigest?: string;
    /** Whether the current resolved map contains at least one server. */
    mcpConfigConfigured?: boolean;
  },
): void {
  if (resumeState.conductorAgentId !== input.conductorAgentId) {
    throw new Error(
      `Session resume state conductorAgentId mismatch: ${resumeState.conductorAgentId} !== ${input.conductorAgentId}`,
    );
  }
  if (resumeState.issueUrl !== input.issueUrl) {
    throw new Error(
      `Session resume state issueUrl mismatch: ${resumeState.issueUrl} !== ${input.issueUrl}`,
    );
  }
  if (resumeState.repoRoot !== input.repoRoot) {
    throw new Error(
      `Session resume state repoRoot mismatch: ${resumeState.repoRoot} !== ${input.repoRoot}`,
    );
  }
  if (
    input.conductorBackend !== undefined &&
    (resumeState.conductorBackend ?? 'cursor') !== input.conductorBackend
  ) {
    throw new Error(
      `Session resume state conductorBackend mismatch: ${resumeState.conductorBackend ?? 'cursor'} !== ${input.conductorBackend}`,
    );
  }
  if (input.mcpConfigDigest !== undefined) {
    if (resumeState.mcpConfigDigest === undefined) {
      if (input.mcpConfigConfigured) {
        throw new Error(
          'Session resume state MCP config digest missing; cannot safely resume with MCP configuration.',
        );
      }
    } else if (resumeState.mcpConfigDigest !== input.mcpConfigDigest) {
      throw new Error(
        `Session resume state MCP config digest mismatch: ${resumeState.mcpConfigDigest} !== ${input.mcpConfigDigest}`,
      );
    }
  }
}

/** @deprecated Use assertSessionResumeStateMatches; retained until the next major release. */
export const assertSessionSidecarMatches = assertSessionResumeStateMatches;

/** @deprecated Use sessionResumeStoreDir; retained until the next major release. */
export const sessionSidecarDir = sessionResumeStoreDir;

/** @deprecated Use sessionResumeStorePath; retained until the next major release. */
export const sessionSidecarPath = sessionResumeStorePath;

/** @deprecated Use loadSessionResumeState; retained until the next major release. */
export const loadSessionSidecar = loadSessionResumeState;

function parseSessionResumeState(value: unknown): SessionResumeState {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid session resume state: not an object');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== SESSION_RESUME_STATE_VERSION) {
    throw new Error(`Unsupported session resume state version: ${record.version}`);
  }
  if (typeof record.conductorAgentId !== 'string') {
    throw new Error('Invalid session resume state: conductorAgentId');
  }
  const conductorBackend = parseConductorBackend(record.conductorBackend);
  if (typeof record.issueUrl !== 'string') {
    throw new Error('Invalid session resume state: issueUrl');
  }
  if (typeof record.repoRoot !== 'string') {
    throw new Error('Invalid session resume state: repoRoot');
  }
  if (!record.profile || typeof record.profile !== 'object') {
    throw new Error('Invalid session resume state: profile');
  }
  if (!Array.isArray(record.openQuestions)) {
    throw new Error('Invalid session resume state: openQuestions');
  }
  if (typeof record.sequence !== 'number') {
    throw new Error('Invalid session resume state: sequence');
  }
  if (!record.workers || typeof record.workers !== 'object') {
    throw new Error('Invalid session resume state: workers');
  }
  if (
    record.mcpConfigDigest !== undefined &&
    typeof record.mcpConfigDigest !== 'string'
  ) {
    throw new Error('Invalid session resume state: mcpConfigDigest');
  }
  if (
    record.lazyWorkers !== undefined &&
    typeof record.lazyWorkers !== 'boolean'
  ) {
    throw new Error('Invalid session resume state: lazyWorkers');
  }
  if (
    record.harnessSocketPath !== undefined &&
    (typeof record.harnessSocketPath !== 'string' ||
      record.harnessSocketPath.length === 0)
  ) {
    throw new Error('Invalid session resume state: harnessSocketPath');
  }
  if (
    record.lifecycle !== undefined &&
    record.lifecycle !== 'closed' &&
    record.lifecycle !== 'exited' &&
    record.lifecycle !== 'interrupted' &&
    record.lifecycle !== 'unknown'
  ) {
    throw new Error('Invalid session resume state: lifecycle');
  }
  const updatedAt =
    typeof record.updatedAt === 'number' ? record.updatedAt : 0;

  let githubMonitor: GitHubMonitorCursor | undefined;
  if (record.githubMonitor && typeof record.githubMonitor === 'object') {
    githubMonitor = record.githubMonitor as GitHubMonitorCursor;
  }

  const workers: Record<string, WorkerSessionResumeState> = {};
  for (const [name, entry] of Object.entries(
    record.workers as Record<string, unknown>,
  )) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Invalid session resume state worker entry: ${name}`);
    }
    const worker = entry as Record<string, unknown>;
    if (typeof worker.acpSessionId !== 'string') {
      throw new Error(`Invalid session resume state worker acpSessionId: ${name}`);
    }
    workers[name] = {
      acpSessionId: worker.acpSessionId,
      ...(typeof worker.acpCwd === 'string' ? { acpCwd: worker.acpCwd } : {}),
      ...(parseAcpSpawnFingerprint(worker.acpSpawn, name)
        ? { acpSpawn: parseAcpSpawnFingerprint(worker.acpSpawn, name) }
        : {}),
    };
  }

  return {
    version: SESSION_RESUME_STATE_VERSION,
    conductorAgentId: record.conductorAgentId,
    conductorBackend,
    ...(typeof record.lazyWorkers === 'boolean'
      ? { lazyWorkers: record.lazyWorkers }
      : {}),
    ...(typeof record.harnessSocketPath === 'string'
      ? { harnessSocketPath: record.harnessSocketPath }
      : {}),
    issueUrl: record.issueUrl,
    repoRoot: record.repoRoot,
    profile: record.profile as ResolvedProfile,
    ...(typeof record.profilePath === 'string'
      ? { profilePath: record.profilePath }
      : {}),
    openQuestions: record.openQuestions as OpenQuestion[],
    sequence: record.sequence,
    workers,
    ...(githubMonitor ? { githubMonitor } : {}),
    ...(typeof record.mcpConfigDigest === 'string'
      ? { mcpConfigDigest: record.mcpConfigDigest }
      : {}),
    ...(record.lifecycle !== undefined
      ? { lifecycle: record.lifecycle as SessionLifecycle }
      : {}),
    updatedAt,
  };
}

function parseConductorBackend(value: unknown): ConductorBackend {
  if (value === undefined) {
    // Older SessionResumeStore records used Cursor SDK unconditionally.
    return 'cursor';
  }
  if (value === 'cursor' || value === 'pi') {
    return value;
  }
  throw new Error('Invalid session resume state: conductorBackend');
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function parseAcpSpawnFingerprint(
  raw: unknown,
  workerName: string,
): AcpSpawnFingerprint | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid session resume state worker acpSpawn: ${workerName}`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.preset !== 'string' || typeof record.command !== 'string') {
    throw new Error(`Invalid session resume state worker acpSpawn: ${workerName}`);
  }
  if (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== 'string')) {
    throw new Error(`Invalid session resume state worker acpSpawn args: ${workerName}`);
  }
  let env: Record<string, string> | undefined;
  if (record.env !== undefined) {
    if (!record.env || typeof record.env !== 'object' || Array.isArray(record.env)) {
      throw new Error(`Invalid session resume state worker acpSpawn env: ${workerName}`);
    }
    env = {};
    for (const [key, value] of Object.entries(record.env)) {
      if (typeof value !== 'string') {
        throw new Error(`Invalid session resume state worker acpSpawn env.${key}: ${workerName}`);
      }
      env[key] = value;
    }
    if (Object.keys(env).length === 0) {
      env = undefined;
    }
  }
  return {
    preset: record.preset as AcpSpawnFingerprint['preset'],
    command: record.command,
    args: record.args,
    ...(env ? { env } : {}),
  };
}
