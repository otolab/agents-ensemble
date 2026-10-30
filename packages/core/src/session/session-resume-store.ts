import { chmod, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OpenQuestion } from '../escalation/open-question.js';
import type { GitHubMonitorCursor } from '../github/github-monitor-cursor.js';
import {
  computeAcpSpawnEnvDigest,
  type AcpSpawnFingerprint,
} from '../acp/resolve-acp-spawn.js';
import type { AcpModelTag, ConductorBackend } from '../config/types.js';
import type { ResolvedProfile } from '../profile/types.js';
import { resolveEnsemblePaths } from '../ensemble-paths.js';

export const SESSION_RESUME_STORE_VERSION = 1;

/** @deprecated Use SESSION_RESUME_STORE_VERSION; supported for one release only. */
export const SESSION_SIDECAR_VERSION = SESSION_RESUME_STORE_VERSION;

export type SessionLifecycle =
  | 'closed'
  | 'exited'
  | 'interrupted'
  | 'unknown';

export type HarnessPhase = 'running' | 'idle' | 'close' | 'abort' | 'exit';

export function harnessPhaseFromLegacyLifecycle(
  lifecycle: SessionLifecycle | undefined,
): HarnessPhase | null {
  switch (lifecycle) {
    case 'closed':
      return 'close';
    case 'exited':
      return 'exit';
    case 'interrupted':
      return 'abort';
    default:
      return null;
  }
}

export class SessionResumeStoreNotFoundError extends Error {
  readonly code: string = 'SESSION_RESUME_STORE_NOT_FOUND';

  constructor(
    public readonly conductorAgentId: string,
    public readonly path: string,
  ) {
    super(
      `Session resume store not found for resume (agentId=${conductorAgentId}, path=${path})`,
    );
    this.name = 'SessionResumeStoreNotFoundError';
  }
}

/** @deprecated Use SessionResumeStoreNotFoundError; supported for one release only. */
export class SessionSidecarNotFoundError extends SessionResumeStoreNotFoundError {
  override readonly code = 'SESSION_SIDECAR_NOT_FOUND';

  constructor(conductorAgentId: string, path: string) {
    super(conductorAgentId, path);
    this.name = 'SessionSidecarNotFoundError';
  }
}

/** @deprecated Use WorkerSessionResumeStore; supported for one release only. */
export type WorkerSessionSidecar = WorkerSessionResumeStore;

export interface WorkerSessionResumeStore {
  acpSessionId: string;
  /** ACP `session/new` / `session/load` に渡した cwd（resume 検証用）。 */
  acpCwd?: string;
  /** resume 時の ACP spawn fingerprint（env は canonical digest のみ保存）。 */
  acpSpawn?: AcpSpawnFingerprint;
}

export interface SessionResumeStore {
  version: typeof SESSION_RESUME_STORE_VERSION;
  conductorAgentId: string;
  /** 起動時に選択した conductor backend。旧形式の欠落値は cursor。 */
  conductorBackend?: ConductorBackend;
  /** Conductor SDK session を作成した working directory。 */
  conductorCwd?: string;
  /** Cursor local run API で bootstrap run を除外するための ID。 */
  cursorBootstrapRunId?: string;
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
  workers: Record<string, WorkerSessionResumeStore>;
  /** GitHub 監視カーソルと未配送更新（#39）。 */
  githubMonitor?: GitHubMonitorCursor;
  /** Harness-resolved MCP map digest used to reject unsafe resume. */
  mcpConfigDigest?: string;
  /** Resolved ensemble config digest used to reject resume after config changes. */
  ensembleConfigDigest?: string;
  /** Last completed process lifecycle; absent legacy values are unknown. */
  lifecycle?: SessionLifecycle;
  /** Harness-owned activity / teardown phase. */
  harnessPhase?: HarnessPhase;
  /** Unix ms for the latest harness activity or phase transition. */
  modifiedAt?: number;
  /** flush 時刻（Unix ms）。`--continue` で最新セッションを選ぶために使う。 */
  updatedAt: number;
}

/** @deprecated Use SessionResumeStore; supported for one release only. */
export type SessionSidecar = SessionResumeStore;

export interface FindLatestSessionResumeStoreInput {
  repoRoot: string;
  issueUrl: string;
}

/** @deprecated Use FindLatestSessionResumeStoreInput; supported for one release only. */
export type FindLatestSessionSidecarInput = FindLatestSessionResumeStoreInput;

export interface SessionResumeStorePathOptions {
  repoRoot: string;
  conductorAgentId: string;
}

/** @deprecated Use SessionResumeStorePathOptions; supported for one release only. */
export type SessionSidecarPathOptions = SessionResumeStorePathOptions;

export function sessionResumeStoreDir(repoRoot: string): string {
  return resolveEnsemblePaths({ repoRoot }).sessionsDir;
}

export function legacySessionResumeStoreDir(repoRoot: string): string {
  return resolveEnsemblePaths({ repoRoot }).legacySessionsDir;
}

export function legacySessionResumeStorePath(
  options: SessionResumeStorePathOptions,
): string {
  return resolveEnsemblePaths({
    repoRoot: options.repoRoot,
  }).legacySessionResumeStorePath(options.conductorAgentId);
}

export function sessionResumeStorePath(options: SessionResumeStorePathOptions): string {
  return resolveEnsemblePaths({
    repoRoot: options.repoRoot,
  }).sessionResumeStorePath(options.conductorAgentId);
}

export async function loadSessionResumeStore(
  path: string,
): Promise<SessionResumeStore | undefined> {
  const loaded = await readSessionResumeStore(path);
  return loaded?.resumeStore;
}

async function readSessionResumeStore(
  path: string,
): Promise<
  | {
      resumeStore: SessionResumeStore;
      hasLegacyAcpSpawnEnv: boolean;
      rawValue: unknown;
    }
  | undefined
> {
  try {
    const raw = await readFile(path, 'utf8');
    const value: unknown = JSON.parse(raw);
    return {
      resumeStore: parseSessionResumeStore(value),
      hasLegacyAcpSpawnEnv: containsLegacyAcpSpawnEnv(value),
      rawValue: value,
    };
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

/** `resumeAgentId` 指定時に SessionResumeStore が無い場合は起動失敗とする。 */
export async function requireSessionResumeStoreForResume(input: {
  repoRoot: string;
  conductorAgentId: string;
}): Promise<SessionResumeStore> {
  const path = sessionResumeStorePath(input);
  let loaded = await readSessionResumeStore(path);
  let sourcePath = path;
  if (!loaded) {
    sourcePath = legacySessionResumeStorePath(input);
    loaded = await readSessionResumeStore(sourcePath);
  }
  if (!loaded) {
    throw new SessionResumeStoreNotFoundError(input.conductorAgentId, path);
  }
  if (loaded.hasLegacyAcpSpawnEnv) {
    // Scrub pre-digest env values before resume validation can reject the
    // session and bypass its normal first write.
    await writeSessionResumeStoreFile(
      sourcePath,
      redactLegacyAcpSpawnEnv(loaded.rawValue, loaded.resumeStore),
    );
  }
  if (sourcePath !== path) {
    await writeSessionResumeStoreFile(path, loaded.resumeStore);
  }
  return loaded.resumeStore;
}

/** @deprecated Use requireSessionResumeStoreForResume; supported for one release only. */
export async function requireSessionSidecarForResume(input: {
  repoRoot: string;
  conductorAgentId: string;
}): Promise<SessionSidecar> {
  try {
    return await requireSessionResumeStoreForResume(input);
  } catch (error) {
    if (error instanceof SessionResumeStoreNotFoundError) {
      throw new SessionSidecarNotFoundError(
        input.conductorAgentId,
        sessionResumeStorePath(input),
      );
    }
    throw error;
  }
}

export async function saveSessionResumeStore(
  path: string,
  resumeStore: SessionResumeStore,
): Promise<void> {
  const updatedAt =
    resumeStore.harnessPhase !== undefined &&
    resumeStore.harnessPhase !== 'running' &&
    resumeStore.harnessPhase !== 'idle' &&
    resumeStore.modifiedAt !== undefined
      ? resumeStore.modifiedAt
      : Date.now();
  const parsed = parseSessionResumeStore({
    ...resumeStore,
    updatedAt,
    ...(resumeStore.harnessPhase === 'running' ||
    resumeStore.harnessPhase === 'idle'
      ? { modifiedAt: updatedAt }
      : {}),
  });
  await writeSessionResumeStoreFile(path, parsed);
}

async function writeSessionResumeStoreFile(
  path: string,
  value: unknown,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tempPath = `${path}.tmp`;
  await writeFile(
    tempPath,
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
}

/** @deprecated Use saveSessionResumeStore; supported for one release only. */
export const saveSessionSidecar = saveSessionResumeStore;

export async function listSessionResumeStores(
  repoRoot: string,
): Promise<SessionResumeStore[]> {
  const paths = resolveEnsemblePaths({ repoRoot });
  const byAgentId = new Map<string, SessionResumeStore>();
  for (const dir of [paths.legacySessionsDir, paths.sessionsDir]) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry.endsWith('.tmp')) continue;
      const resumeStore = await loadSessionResumeStore(join(dir, entry));
      if (resumeStore) byAgentId.set(resumeStore.conductorAgentId, resumeStore);
    }
  }
  return [...byAgentId.values()];
}

/** @deprecated Use listSessionResumeStores; supported for one release only. */
export const listSessionSidecars = listSessionResumeStores;

/**
 * 同一 Issue では close / abort を優先し、exit を除外したうえで
 * updatedAt が最も新しい SessionResumeStore を返す。
 */
export async function findLatestSessionResumeStoreForIssue(
  input: FindLatestSessionResumeStoreInput,
): Promise<SessionResumeStore | undefined> {
  const matches = (await listSessionResumeStores(input.repoRoot)).filter(
    (resumeStore) =>
      resumeStore.issueUrl === input.issueUrl &&
      resumeStore.repoRoot === input.repoRoot &&
      (resumeStore.harnessPhase ??
        harnessPhaseFromLegacyLifecycle(resumeStore.lifecycle)) !== 'exit',
  );
  if (matches.length === 0) return undefined;

  return matches.reduce((selected, resumeStore) => {
    const selectedPhase =
      selected.harnessPhase ??
      harnessPhaseFromLegacyLifecycle(selected.lifecycle);
    const resumeStorePhase =
      resumeStore.harnessPhase ??
      harnessPhaseFromLegacyLifecycle(resumeStore.lifecycle);
    const selectedPriority =
      selectedPhase === 'close' || selectedPhase === 'abort' ? 1 : 0;
    const resumeStorePriority =
      resumeStorePhase === 'close' || resumeStorePhase === 'abort' ? 1 : 0;
    if (resumeStorePriority !== selectedPriority) {
      return resumeStorePriority > selectedPriority ? resumeStore : selected;
    }
    return resumeStore.updatedAt > selected.updatedAt ? resumeStore : selected;
  });
}

/** @deprecated Use findLatestSessionResumeStoreForIssue; supported for one release only. */
export const findLatestSessionSidecarForIssue =
  findLatestSessionResumeStoreForIssue;

export function assertSessionResumeStoreMatches(
  resumeStore: SessionResumeStore,
  input: {
    issueUrl: string;
    repoRoot: string;
    conductorAgentId: string;
    conductorBackend?: ConductorBackend;
    /** Current harness-resolved MCP map digest. */
    mcpConfigDigest?: string;
    /** Whether the current resolved map contains at least one server. */
    mcpConfigConfigured?: boolean;
    /** Current resolved ensemble config digest. */
    ensembleConfigDigest?: string;
  },
): void {
  if (resumeStore.conductorAgentId !== input.conductorAgentId) {
    throw new Error(
      `Session resume store conductorAgentId mismatch: ${resumeStore.conductorAgentId} !== ${input.conductorAgentId}`,
    );
  }
  if (resumeStore.issueUrl !== input.issueUrl) {
    throw new Error(
      `Session resume store issueUrl mismatch: ${resumeStore.issueUrl} !== ${input.issueUrl}`,
    );
  }
  if (resumeStore.repoRoot !== input.repoRoot) {
    throw new Error(
      `Session resume store repoRoot mismatch: ${resumeStore.repoRoot} !== ${input.repoRoot}`,
    );
  }
  if (
    input.conductorBackend !== undefined &&
    (resumeStore.conductorBackend ?? 'cursor') !== input.conductorBackend
  ) {
    throw new Error(
      `Session resume store conductorBackend mismatch: ${resumeStore.conductorBackend ?? 'cursor'} !== ${input.conductorBackend}`,
    );
  }
  if (input.mcpConfigDigest !== undefined) {
    if (resumeStore.mcpConfigDigest === undefined) {
      if (input.mcpConfigConfigured) {
        throw new Error(
          'Session resume store MCP config digest missing; cannot safely resume with MCP configuration.',
        );
      }
    } else if (resumeStore.mcpConfigDigest !== input.mcpConfigDigest) {
      throw new Error(
        `Session resume store MCP config digest mismatch: ${resumeStore.mcpConfigDigest} !== ${input.mcpConfigDigest}`,
      );
    }
  }
  if (
    input.ensembleConfigDigest !== undefined &&
    resumeStore.ensembleConfigDigest !== undefined &&
    resumeStore.ensembleConfigDigest !== input.ensembleConfigDigest
  ) {
    throw new Error(
      `Session resume store ensemble config digest mismatch: ${resumeStore.ensembleConfigDigest} !== ${input.ensembleConfigDigest}`,
    );
  }
}

/** @deprecated Use assertSessionResumeStoreMatches; supported for one release only. */
export const assertSessionSidecarMatches = assertSessionResumeStoreMatches;

/** @deprecated Use sessionResumeStoreDir; supported for one release only. */
export const sessionSidecarDir = sessionResumeStoreDir;

/** @deprecated Use sessionResumeStorePath; supported for one release only. */
export const sessionSidecarPath = sessionResumeStorePath;

/** @deprecated Use loadSessionResumeStore; supported for one release only. */
export const loadSessionSidecar = loadSessionResumeStore;

function parseSessionResumeStore(value: unknown): SessionResumeStore {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid session resume store: not an object');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== SESSION_RESUME_STORE_VERSION) {
    throw new Error(`Unsupported session resume store version: ${record.version}`);
  }
  if (typeof record.conductorAgentId !== 'string') {
    throw new Error('Invalid session resume store: conductorAgentId');
  }
  const conductorBackend = parseConductorBackend(record.conductorBackend);
  if (typeof record.issueUrl !== 'string') {
    throw new Error('Invalid session resume store: issueUrl');
  }
  if (typeof record.repoRoot !== 'string') {
    throw new Error('Invalid session resume store: repoRoot');
  }
  if (!record.profile || typeof record.profile !== 'object') {
    throw new Error('Invalid session resume store: profile');
  }
  if (!Array.isArray(record.openQuestions)) {
    throw new Error('Invalid session resume store: openQuestions');
  }
  if (typeof record.sequence !== 'number') {
    throw new Error('Invalid session resume store: sequence');
  }
  if (!record.workers || typeof record.workers !== 'object') {
    throw new Error('Invalid session resume store: workers');
  }
  if (
    record.mcpConfigDigest !== undefined &&
    typeof record.mcpConfigDigest !== 'string'
  ) {
    throw new Error('Invalid session resume store: mcpConfigDigest');
  }
  if (
    record.ensembleConfigDigest !== undefined &&
    typeof record.ensembleConfigDigest !== 'string'
  ) {
    throw new Error('Invalid session resume store: ensembleConfigDigest');
  }
  if (
    record.lazyWorkers !== undefined &&
    typeof record.lazyWorkers !== 'boolean'
  ) {
    throw new Error('Invalid session resume store: lazyWorkers');
  }
  if (
    record.harnessSocketPath !== undefined &&
    (typeof record.harnessSocketPath !== 'string' ||
      record.harnessSocketPath.length === 0)
  ) {
    throw new Error('Invalid session resume store: harnessSocketPath');
  }
  if (
    record.conductorCwd !== undefined &&
    (typeof record.conductorCwd !== 'string' ||
      record.conductorCwd.trim() === '')
  ) {
    throw new Error('Invalid session resume store: conductorCwd');
  }
  if (
    record.cursorBootstrapRunId !== undefined &&
    (typeof record.cursorBootstrapRunId !== 'string' ||
      record.cursorBootstrapRunId.trim() === '')
  ) {
    throw new Error('Invalid session resume store: cursorBootstrapRunId');
  }
  if (
    record.lifecycle !== undefined &&
    record.lifecycle !== 'closed' &&
    record.lifecycle !== 'exited' &&
    record.lifecycle !== 'interrupted' &&
    record.lifecycle !== 'unknown'
  ) {
    throw new Error('Invalid session resume store: lifecycle');
  }
  if (
    record.harnessPhase !== undefined &&
    record.harnessPhase !== 'running' &&
    record.harnessPhase !== 'idle' &&
    record.harnessPhase !== 'close' &&
    record.harnessPhase !== 'abort' &&
    record.harnessPhase !== 'exit'
  ) {
    throw new Error('Invalid session resume store: harnessPhase');
  }
  if (
    record.modifiedAt !== undefined &&
    (typeof record.modifiedAt !== 'number' ||
      !Number.isFinite(record.modifiedAt))
  ) {
    throw new Error('Invalid session resume store: modifiedAt');
  }
  const updatedAt =
    typeof record.updatedAt === 'number' ? record.updatedAt : 0;

  let githubMonitor: GitHubMonitorCursor | undefined;
  if (record.githubMonitor && typeof record.githubMonitor === 'object') {
    githubMonitor = record.githubMonitor as GitHubMonitorCursor;
  }

  const workers: Record<string, WorkerSessionResumeStore> = {};
  for (const [name, entry] of Object.entries(
    record.workers as Record<string, unknown>,
  )) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Invalid session resume store worker entry: ${name}`);
    }
    const worker = entry as Record<string, unknown>;
    if (typeof worker.acpSessionId !== 'string') {
      throw new Error(`Invalid session resume store worker acpSessionId: ${name}`);
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
    version: SESSION_RESUME_STORE_VERSION,
    conductorAgentId: record.conductorAgentId,
    conductorBackend,
    ...(typeof record.conductorCwd === 'string'
      ? { conductorCwd: record.conductorCwd }
      : {}),
    ...(typeof record.cursorBootstrapRunId === 'string'
      ? { cursorBootstrapRunId: record.cursorBootstrapRunId }
      : {}),
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
    ...(typeof record.ensembleConfigDigest === 'string'
      ? { ensembleConfigDigest: record.ensembleConfigDigest }
      : {}),
    ...(record.lifecycle !== undefined
      ? { lifecycle: record.lifecycle as SessionLifecycle }
      : {}),
    ...(record.harnessPhase !== undefined
      ? { harnessPhase: record.harnessPhase as HarnessPhase }
      : {}),
    ...(typeof record.modifiedAt === 'number'
      ? { modifiedAt: record.modifiedAt }
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
  throw new Error('Invalid session resume store: conductorBackend');
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function containsLegacyAcpSpawnEnv(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('workers' in value)) return false;
  const workers = (value as { workers?: unknown }).workers;
  if (!workers || typeof workers !== 'object' || Array.isArray(workers)) {
    return false;
  }
  return Object.values(workers).some((worker) => {
    if (!worker || typeof worker !== 'object' || !('acpSpawn' in worker)) {
      return false;
    }
    const acpSpawn = (worker as { acpSpawn?: unknown }).acpSpawn;
    if (!acpSpawn || typeof acpSpawn !== 'object' || !('env' in acpSpawn)) {
      return false;
    }
    const env = (acpSpawn as { env?: unknown }).env;
    return (
      !!env &&
      typeof env === 'object' &&
      !Array.isArray(env) &&
      Object.keys(env).length > 0
    );
  });
}

function redactLegacyAcpSpawnEnv(
  value: unknown,
  parsed: SessionResumeStore,
): unknown {
  const record = value as Record<string, unknown>;
  const rawWorkers = record.workers as Record<string, unknown>;
  const workers: Record<string, unknown> = { ...rawWorkers };
  for (const [name, rawWorker] of Object.entries(rawWorkers)) {
    const worker = rawWorker as Record<string, unknown>;
    if (!worker.acpSpawn || typeof worker.acpSpawn !== 'object') continue;
    const acpSpawn = { ...(worker.acpSpawn as Record<string, unknown>) };
    if (!('env' in acpSpawn)) continue;
    delete acpSpawn.env;
    const envDigest = parsed.workers[name]?.acpSpawn?.envDigest;
    if (envDigest) acpSpawn.envDigest = envDigest;
    workers[name] = { ...worker, acpSpawn };
  }
  return { ...record, workers };
}

function parseAcpSpawnFingerprint(
  raw: unknown,
  workerName: string,
): AcpSpawnFingerprint | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid session resume store worker acpSpawn: ${workerName}`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.preset !== 'string' || typeof record.command !== 'string') {
    throw new Error(`Invalid session resume store worker acpSpawn: ${workerName}`);
  }
  if (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== 'string')) {
    throw new Error(`Invalid session resume store worker acpSpawn args: ${workerName}`);
  }
  const validModelTags: AcpModelTag[] = ['high', 'default', 'low', 'fast'];
  let modelTag: AcpModelTag | undefined;
  if (record.modelTag !== undefined) {
    if (
      typeof record.modelTag !== 'string' ||
      !validModelTags.includes(record.modelTag as AcpModelTag)
    ) {
      throw new Error(
        `Invalid session resume store worker acpSpawn modelTag: ${workerName}`,
      );
    }
    modelTag = record.modelTag as AcpModelTag;
  }
  let model: string | undefined;
  if (record.model !== undefined) {
    if (typeof record.model !== 'string' || record.model.length === 0) {
      throw new Error(
        `Invalid session resume store worker acpSpawn model: ${workerName}`,
      );
    }
    model = record.model;
  }
  let envDigest: string | undefined;
  if (record.envDigest !== undefined) {
    if (
      typeof record.envDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.envDigest)
    ) {
      throw new Error(
        `Invalid session resume store worker acpSpawn envDigest: ${workerName}`,
      );
    }
    envDigest = record.envDigest;
  }
  if (record.env !== undefined) {
    if (!record.env || typeof record.env !== 'object' || Array.isArray(record.env)) {
      throw new Error(`Invalid session resume store worker acpSpawn env: ${workerName}`);
    }
    const legacyEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(record.env)) {
      if (typeof value !== 'string') {
        throw new Error(`Invalid session resume store worker acpSpawn env.${key}: ${workerName}`);
      }
      legacyEnv[key] = value;
    }
    if (Object.keys(legacyEnv).length > 0) {
      if (envDigest !== undefined) {
        throw new Error(
          `Invalid session resume store worker acpSpawn env: duplicate env and envDigest for ${workerName}`,
        );
      }
      // Redact values from legacy records while keeping resume comparison possible.
      envDigest = computeAcpSpawnEnvDigest(legacyEnv);
    }
  }
  return {
    preset: record.preset as AcpSpawnFingerprint['preset'],
    command: record.command,
    args: record.args,
    ...(modelTag !== undefined ? { modelTag } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(envDigest ? { envDigest } : {}),
  };
}
