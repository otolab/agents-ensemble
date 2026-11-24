import type { Dirent } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OpenQuestion } from '../escalation/open-question.js';
import type { GitHubMonitorCursor } from '../github/github-monitor-cursor.js';
import {
  computeAcpSpawnEnvDigest,
  type AcpSpawnFingerprint,
} from '../acp/resolve-acp-spawn.js';
import type { AcpModelTag, ConductorBackend } from '../config/types.js';
import type { ResolvedProfile } from '../profile/types.js';
import { parseIssueUrl } from '../issue/issue-ref.js';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import {
  parseWorkspaceSessionUrl,
  workspaceSessionUrl,
} from '../workspace-run/session-url.js';
import {
  resolveSessionPersistenceScope,
  sessionResumeStorePathForScope,
} from './session-persistence-scope.js';
import { resolveUserEnsembleRoot } from '../resolve-user-ensemble-root.js';
import { writeFileIfMissing } from './persisted-file.js';

export const SESSION_RESUME_STORE_VERSION = 1;

export type EnsembleConfigDigestScheme = 'full' | 'resume-feasibility';

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

class InvalidSessionResumeStoreDataError extends Error {
  constructor(path: string, reason: string, cause: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    super(`Invalid session resume store at ${path} (${reason})${detail}`);
    this.name = 'InvalidSessionResumeStoreDataError';
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
  originAcpCwd?: string;
  originAcpSpawn?: AcpSpawnFingerprint;
  repoRoot?: string;
  issueUrl?: string;
  handoffPending?: boolean;
  workspacePromptVersion?: number;
  generations?: WorkerSessionGeneration[];
}

export interface WorkerSessionGeneration {
  acpSessionId: string;
  acpCwd?: string;
  acpSpawn?: AcpSpawnFingerprint;
  repoRoot: string;
  issueUrl: string;
  replacedAt: number;
  reason: 'session_load_failed' | 'prompt_history_unreadable' | 'explicit' | 'workspace_prompt_migration';
  nextSessionId: string;
}

function parseWorkerSessionGenerations(value: unknown, name: string): WorkerSessionGeneration[] {
  if (!Array.isArray(value)) throw new Error(`Invalid worker session generations: ${name}`);
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error(`Invalid worker session generation: ${name}`);
    const generation = item as Record<string, unknown>;
    if (
      typeof generation.acpSessionId !== 'string' ||
      typeof generation.nextSessionId !== 'string' ||
      typeof generation.repoRoot !== 'string' ||
      typeof generation.issueUrl !== 'string' ||
      typeof generation.replacedAt !== 'number' ||
      !Number.isFinite(generation.replacedAt) ||
      !['session_load_failed', 'prompt_history_unreadable', 'explicit', 'workspace_prompt_migration'].includes(String(generation.reason))
    ) throw new Error(`Invalid worker session generation: ${name}`);
    const acpSpawn = parseAcpSpawnFingerprint(generation.acpSpawn, name);
    return {
      acpSessionId: generation.acpSessionId,
      nextSessionId: generation.nextSessionId,
      repoRoot: generation.repoRoot,
      issueUrl: generation.issueUrl,
      replacedAt: generation.replacedAt,
      reason: generation.reason as WorkerSessionGeneration['reason'],
      ...(typeof generation.acpCwd === 'string' ? { acpCwd: generation.acpCwd } : {}),
      ...(acpSpawn ? { acpSpawn } : {}),
    };
  });
}

export interface SessionResumeStore {
  version: typeof SESSION_RESUME_STORE_VERSION;
  conductorAgentId: string;
  /** 起動時に選択した conductor backend。旧形式の欠落値は cursor。 */
  conductorBackend?: ConductorBackend;
  /** この session を作成した CLI package version。旧形式では欠落する。 */
  createdHarnessCliVersion?: string;
  /** Conductor SDK session を作成した working directory。 */
  conductorCwd?: string;
  /** Cursor local run API で bootstrap run を除外する ID。bootstrap の成否は示さない。 */
  cursorBootstrapRunId?: string;
  /** Cursor の compiled prompt の完了状態。欠落した旧形式は unknown。本文は保存しない。 */
  cursorBootstrapComplete?: boolean;
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
  /** Harness-resolved MCP map digest retained as diagnostic metadata. */
  mcpConfigDigest?: string;
  /** Config digest comparison scheme; omitted legacy values mean `full`. */
  ensembleConfigDigestScheme?: EnsembleConfigDigestScheme;
  /** Config digest retained to explain the configuration used by this session. */
  ensembleConfigDigest?: string;
  /** Original ACP model-routing config digest for diagnostics; never a resume gate. */
  acpModelConfigDigest?: string;
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
  issueUrl: string;
  conductorAgentId: string;
}

export interface SessionResumeStoreDirOptions {
  repoRoot: string;
  issueUrl: string;
}

export type SessionResumeStoreLocation = 'canonical-slug' | 'workspace-slug';

export interface LocatedSessionResumeStore {
  resumeStore: SessionResumeStore;
  path: string;
  location: SessionResumeStoreLocation;
}

export interface SessionResumeStoreDuplicateDiagnostic {
  conductorAgentId: string;
  issueUrl: string;
  selectedPath: string;
  selectedLocation: SessionResumeStoreLocation;
  candidates: Array<{
    path: string;
    location: SessionResumeStoreLocation;
    hasHarnessSocketPath: boolean;
  }>;
}

export interface SessionResumeStoreQuery {
  githubRepo?: string;
  issueUrl?: string;
  conductorAgentId?: string;
  limit?: number;
  cursor?: string;
}

export interface SessionResumeStorePage<T> {
  sessions: T[];
  total: number;
  nextCursor?: string;
}

export interface SessionResumeStoreSelector {
  githubRepo?: string;
  issueUrl?: string;
  conductorAgentId: string;
}

const SESSION_RESUME_STORE_PAGE_MAX_LIMIT = 500;
const SESSION_RESUME_STORE_PAGE_CURSOR_VERSION = 1;

/** @deprecated Use SessionResumeStorePathOptions; supported for one release only. */
export type SessionSidecarPathOptions = SessionResumeStorePathOptions;

/** Return the canonical user-store directory for an Issue repository. */
export function sessionResumeStoreDir(
  input: SessionResumeStoreDirOptions,
): string {
  return resolveEnsemblePaths({ repoRoot: input.repoRoot })
    .canonicalRepoSessionsDir(input.issueUrl);
}

export function legacySessionResumeStoreDir(repoRoot: string): string {
  return resolveEnsemblePaths({ repoRoot }).legacySessionsDir;
}

export function legacySessionResumeStorePath(
  options: Pick<SessionResumeStorePathOptions, 'repoRoot' | 'conductorAgentId'>,
): string {
  return resolveEnsemblePaths({
    repoRoot: options.repoRoot,
  }).legacySessionResumeStorePath(options.conductorAgentId);
}

/** Return the canonical user-store path; an Issue URL is required for identity. */
export function sessionResumeStorePath(
  options: SessionResumeStorePathOptions,
): string {
  return canonicalSessionResumeStorePath(options);
}

export function canonicalSessionResumeStorePath(input: {
  repoRoot: string;
  issueUrl: string;
  conductorAgentId: string;
}): string {
  const scope = resolveSessionPersistenceScope(input.issueUrl);
  return sessionResumeStorePathForScope(
    input.repoRoot,
    scope,
    input.conductorAgentId,
  );
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
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new InvalidSessionResumeStoreDataError(path, 'invalid JSON', error);
  }

  let resumeStore: SessionResumeStore;
  try {
    resumeStore = parseSessionResumeStore(value);
  } catch (error) {
    throw new InvalidSessionResumeStoreDataError(path, 'invalid schema', error);
  }
  return {
    resumeStore,
    hasLegacyAcpSpawnEnv: containsLegacyAcpSpawnEnv(value),
    rawValue: value,
  };
}

/** `resumeAgentId` 指定時に SessionResumeStore が無い場合は起動失敗とする。 */
export async function requireSessionResumeStoreForResume(input: {
  repoRoot: string;
  conductorAgentId: string;
  issueUrl: string;
}): Promise<SessionResumeStore> {
  const located = await requireLocatedSessionResumeStoreForResume(input);
  return located.resumeStore;
}

export async function requireLocatedSessionResumeStoreForResume(input: {
  repoRoot: string;
  conductorAgentId: string;
  issueUrl: string;
  onDuplicate?: (diagnostic: SessionResumeStoreDuplicateDiagnostic) => void;
}): Promise<LocatedSessionResumeStore> {
  if (
    typeof input.issueUrl !== 'string' ||
    !input.issueUrl.trim()
  ) {
    throw new Error('issueUrl is required to resume a session.');
  }
  const locations = await listLocatedSessionResumeStoresPage(
    input.repoRoot,
    {
      issueUrl: input.issueUrl,
      conductorAgentId: input.conductorAgentId,
    },
    { onDuplicate: input.onDuplicate },
  );
  const located = locations.sessions[0];
  if (!located) {
    const path = canonicalSessionResumeStorePath(input);
    throw new SessionResumeStoreNotFoundError(input.conductorAgentId, path);
  }

  const loaded = await readSessionResumeStore(located.path);
  if (!loaded) {
    throw new SessionResumeStoreNotFoundError(
      input.conductorAgentId,
      located.path,
    );
  }
  const persistedValue = loaded.hasLegacyAcpSpawnEnv
    ? redactLegacyAcpSpawnEnv(loaded.rawValue, loaded.resumeStore)
    : loaded.resumeStore;
  const resumeStore = parseSessionResumeStore(persistedValue);
  if (loaded.hasLegacyAcpSpawnEnv) {
    // Scrub canonical data before resume validation can reject the session
    // and bypass its normal first write.
    await writeSessionResumeStoreFile(located.path, persistedValue);
  }
  return {
    ...located,
    resumeStore,
  };
}

/** @deprecated Use requireSessionResumeStoreForResume; supported for one release only. */
export async function requireSessionSidecarForResume(input: {
  repoRoot: string;
  conductorAgentId: string;
  issueUrl: string;
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
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      tempPath,
      `${JSON.stringify(value, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true });
  }
}

/** @deprecated Use saveSessionResumeStore; supported for one release only. */
export const saveSessionSidecar = saveSessionResumeStore;

export async function listSessionResumeStores(
  repoRoot: string,
  options: {
    onDuplicate?: (diagnostic: SessionResumeStoreDuplicateDiagnostic) => void;
  } = {},
): Promise<SessionResumeStore[]> {
  return (await listLocatedSessionResumeStores(repoRoot, options)).map(
    ({ resumeStore }) => resumeStore,
  );
}

export async function listLocatedSessionResumeStores(
  repoRoot: string,
  options: {
    onDuplicate?: (diagnostic: SessionResumeStoreDuplicateDiagnostic) => void;
  } = {},
): Promise<LocatedSessionResumeStore[]> {
  return listSessionResumeStoreLocations(repoRoot, options);
}

export async function findSessionResumeStore(
  repoRoot: string,
  conductorAgentId: string,
  options: {
    onDuplicate?: (diagnostic: SessionResumeStoreDuplicateDiagnostic) => void;
  } = {},
): Promise<LocatedSessionResumeStore | undefined> {
  const matches = (await listLocatedSessionResumeStores(repoRoot, options)).filter(
    (candidate) =>
      candidate.resumeStore.conductorAgentId === conductorAgentId,
  );
  if (matches.length > 1) {
    throw new Error(
      `Session ${conductorAgentId} is ambiguous across saved Issues; use findSessionResumeStoreBySelector with githubRepo or issueUrl.`,
    );
  }
  return matches[0];
}

/**
 * List local sessions using canonical GitHub repository identity.
 *
 * With no limit this returns every matching local store. Supplying a limit
 * enables keyset pagination; no GitHub API repository discovery is performed.
 */
export async function listLocatedSessionResumeStoresPage(
  repoRoot: string,
  query: SessionResumeStoreQuery = {},
  options: {
    onDuplicate?: (diagnostic: SessionResumeStoreDuplicateDiagnostic) => void;
    userEnsembleRoot?: string;
  } = {},
): Promise<SessionResumeStorePage<LocatedSessionResumeStore>> {
  const scope = resolveSessionResumeStoreScope(query);
  const workspaceSlug =
    scope.issueKey?.startsWith('workspace:') === true
      ? scope.issueKey.slice('workspace:'.length)
      : undefined;
  const stores = [
    ...(await listSessionResumeStoreLocations(repoRoot, {
      ...options,
      githubRepo:
        scope.githubRepo === 'workspace' ? undefined : scope.githubRepo,
    })),
    ...(workspaceSlug
      ? await listWorkspaceSessionResumeStoreLocations(
          repoRoot,
          workspaceSlug,
          options,
        )
      : []),
  ]
    .filter(({ resumeStore }) => {
      const identity = sessionIssueIdentity(resumeStore.issueUrl);
      return (
        (!scope.githubRepo || identity.repository === scope.githubRepo) &&
        (!scope.issueKey || identity.key === scope.issueKey) &&
        (!query.conductorAgentId ||
          resumeStore.conductorAgentId === query.conductorAgentId)
      );
    })
    .sort(compareLocatedSessionResumeStores);

  const limit =
    query.limit === undefined
      ? query.cursor === undefined
        ? undefined
        : SESSION_RESUME_STORE_PAGE_MAX_LIMIT
      : validateSessionResumeStorePageLimit(query.limit);
  if (limit === undefined) {
    return { sessions: stores, total: stores.length };
  }

  const cursor =
    query.cursor === undefined
      ? undefined
      : decodeSessionResumeStoreCursor(query.cursor);
  const remaining = cursor
    ? stores.filter(
        (store) => compareLocatedSessionResumeStoreToCursor(store, cursor) > 0,
      )
    : stores;
  const sessions = remaining.slice(0, limit);
  const next = remaining.length > sessions.length ? sessions.at(-1) : undefined;
  return {
    sessions,
    total: stores.length,
    ...(next ? { nextCursor: encodeSessionResumeStoreCursor(next) } : {}),
  };
}

/**
 * List user-scoped canonical slug stores.
 *
 * This is intended for repository-independent operator tools. It does not
 * inspect path-hash or checkout-local session data, or call GitHub.
 */
export async function listUserLocatedSessionResumeStoresPage(
  query: SessionResumeStoreQuery = {},
  options: {
    userEnsembleRoot?: string;
    onDuplicate?: (diagnostic: SessionResumeStoreDuplicateDiagnostic) => void;
  } = {},
): Promise<SessionResumeStorePage<LocatedSessionResumeStore>> {
  const userRoot = options.userEnsembleRoot ?? resolveUserEnsembleRoot();
  const scope = resolveSessionResumeStoreScope(query);
  const stores = (
    await listSessionResumeStoreLocations(userRoot, {
      onDuplicate: options.onDuplicate,
      userEnsembleRoot: userRoot,
      githubRepo: scope.githubRepo,
    })
  )
    .filter(({ resumeStore }) => {
      const identity = sessionIssueIdentity(resumeStore.issueUrl);
      return (
        (!scope.githubRepo || identity.repository === scope.githubRepo) &&
        (!scope.issueKey || identity.key === scope.issueKey) &&
        (!query.conductorAgentId ||
          resumeStore.conductorAgentId === query.conductorAgentId)
      );
    })
    .sort(compareLocatedSessionResumeStores);

  return paginateLocatedSessionResumeStores(stores, query);
}

export async function findUserSessionResumeStore(
  conductorAgentId: string,
  options: {
    userEnsembleRoot?: string;
    onDuplicate?: (diagnostic: SessionResumeStoreDuplicateDiagnostic) => void;
  } = {},
): Promise<LocatedSessionResumeStore | undefined> {
  const id = conductorAgentId.trim();
  if (!id) {
    throw new Error('conductorAgentId must be a non-empty string.');
  }
  const page = await listUserLocatedSessionResumeStoresPage(
    { conductorAgentId: id },
    options,
  );
  if (page.sessions.length > 1) {
    throw new Error(
      `Session ${id} is ambiguous across saved Issues; use a repository or Issue selector.`,
    );
  }
  return page.sessions[0];
}

function paginateLocatedSessionResumeStores(
  stores: LocatedSessionResumeStore[],
  query: SessionResumeStoreQuery,
): SessionResumeStorePage<LocatedSessionResumeStore> {
  const limit =
    query.limit === undefined
      ? query.cursor === undefined
        ? undefined
        : SESSION_RESUME_STORE_PAGE_MAX_LIMIT
      : validateSessionResumeStorePageLimit(query.limit);
  if (limit === undefined) {
    return { sessions: stores, total: stores.length };
  }

  const cursor =
    query.cursor === undefined
      ? undefined
      : decodeSessionResumeStoreCursor(query.cursor);
  const remaining = cursor
    ? stores.filter(
        (store) => compareLocatedSessionResumeStoreToCursor(store, cursor) > 0,
      )
    : stores;
  const sessions = remaining.slice(0, limit);
  const next = remaining.length > sessions.length ? sessions.at(-1) : undefined;
  return {
    sessions,
    total: stores.length,
    ...(next ? { nextCursor: encodeSessionResumeStoreCursor(next) } : {}),
  };
}

export async function listSessionResumeStoresPage(
  repoRoot: string,
  query: SessionResumeStoreQuery = {},
  options: {
    onDuplicate?: (diagnostic: SessionResumeStoreDuplicateDiagnostic) => void;
  } = {},
): Promise<SessionResumeStorePage<SessionResumeStore>> {
  const page = await listLocatedSessionResumeStoresPage(
    repoRoot,
    query,
    options,
  );
  return {
    sessions: page.sessions.map(({ resumeStore }) => resumeStore),
    total: page.total,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

/** Read a session only inside an explicit GitHub repository / Issue scope. */
export async function findSessionResumeStoreBySelector(
  repoRoot: string,
  selector: SessionResumeStoreSelector,
  options: {
    onDuplicate?: (diagnostic: SessionResumeStoreDuplicateDiagnostic) => void;
  } = {},
): Promise<LocatedSessionResumeStore | undefined> {
  const conductorAgentId = selector.conductorAgentId.trim();
  if (!conductorAgentId) {
    throw new Error('conductorAgentId must be a non-empty string.');
  }
  const scope = resolveSessionResumeStoreScope(selector);
  if (!scope.githubRepo && !scope.issueKey) {
    throw new Error(
      'Repository scope is required to read a session; pass --github-repo or --issue-url.',
    );
  }
  const page = await listLocatedSessionResumeStoresPage(
    repoRoot,
    { ...selector, conductorAgentId },
    options,
  );
  if (page.sessions.length > 1) {
    throw new Error(
      `Session ${conductorAgentId} is ambiguous in this repository; specify --issue-url.`,
    );
  }
  return page.sessions[0];
}

async function listSessionResumeStoreLocations(
  repoRoot: string,
  options: {
    userEnsembleRoot?: string;
    onDuplicate?: (diagnostic: SessionResumeStoreDuplicateDiagnostic) => void;
    githubRepo?: string;
  } = {},
): Promise<LocatedSessionResumeStore[]> {
  const paths = resolveEnsemblePaths({
    repoRoot,
    ...(options.userEnsembleRoot
      ? { userEnsembleRoot: options.userEnsembleRoot }
      : {}),
  });
  const candidates: LocatedSessionResumeStore[] = [];
  const visited = new Set<string>();

  const readDirectory = async (
    dir: string,
    location: SessionResumeStoreLocation,
    {
      slugRoot,
      skipMalformedStoreData = false,
    }: {
      slugRoot?: string;
      skipMalformedStoreData?: boolean;
    } = {},
  ) => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(dir, entry.name);
      if (visited.has(path)) continue;
      visited.add(path);
      let resumeStore: SessionResumeStore | undefined;
      try {
        resumeStore = await loadSessionResumeStore(path);
      } catch (error) {
        if (
          skipMalformedStoreData &&
          error instanceof InvalidSessionResumeStoreDataError
        ) {
          continue;
        }
        throw error;
      }
      if (!resumeStore) continue;
      if (
        slugRoot &&
        canonicalSessionDirectory(paths, resumeStore.issueUrl) !== slugRoot
      ) {
        continue;
      }
      candidates.push({ resumeStore, path, location });
    }
  };

  // Slug stores are keyed by GitHub repository identity. Search only the
  // host/owner/repository depth; repoRoot is execution context, not a lookup
  // filter for canonical records.
  let hosts: Dirent[];
  try {
    hosts = await readdir(paths.sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (!isEnoent(error)) throw error;
    hosts = [];
  }
  const exactRepository = options.githubRepo?.split('/');
  for (const host of hosts) {
    if (
      !host.isDirectory() ||
      (exactRepository && host.name !== 'github.com') ||
      /^[a-f0-9]{64}$/u.test(host.name) ||
      host.name === 'pi'
    ) {
      continue;
    }
    let owners: Dirent[];
    try {
      owners = await readdir(join(paths.sessionsRoot, host.name), {
        withFileTypes: true,
      });
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    for (const owner of owners) {
      if (
        !owner.isDirectory() ||
        (exactRepository && owner.name !== exactRepository[0])
      ) {
        continue;
      }
      let repositories: Dirent[];
      try {
        repositories = await readdir(
          join(paths.sessionsRoot, host.name, owner.name),
          { withFileTypes: true },
        );
      } catch (error) {
        if (isEnoent(error)) continue;
        throw error;
      }
      for (const repository of repositories) {
        if (
          !repository.isDirectory() ||
          (exactRepository && repository.name !== exactRepository[1])
        ) {
          continue;
        }
        const slugRoot = join(
          paths.sessionsRoot,
          host.name,
          owner.name,
          repository.name,
        );
        await readDirectory(slugRoot, 'canonical-slug', { slugRoot });
      }
    }
  }

  const bySession = new Map<string, LocatedSessionResumeStore[]>();
  for (const candidate of candidates) {
    const sessionKey = JSON.stringify([
      sessionIssueIdentity(candidate.resumeStore.issueUrl).key,
      candidate.resumeStore.conductorAgentId,
    ]);
    const matching = bySession.get(sessionKey) ?? [];
    matching.push(candidate);
    bySession.set(sessionKey, matching);
  }

  const selected: LocatedSessionResumeStore[] = [];
  for (const matches of bySession.values()) {
    matches.sort(
      (left, right) => right.resumeStore.updatedAt - left.resumeStore.updatedAt,
    );
    const chosen = matches[0]!;
    selected.push(chosen);
    if (matches.length > 1) {
      options.onDuplicate?.({
        conductorAgentId: chosen.resumeStore.conductorAgentId,
        issueUrl: chosen.resumeStore.issueUrl,
        selectedPath: chosen.path,
        selectedLocation: chosen.location,
        candidates: matches.map((candidate) => ({
          path: candidate.path,
          location: candidate.location,
          hasHarnessSocketPath:
            candidate.resumeStore.harnessSocketPath !== undefined,
        })),
      });
    }
  }
  return selected;
}

function canonicalSessionDirectory(
  paths: ReturnType<typeof resolveEnsemblePaths>,
  issueUrl: string,
): string | undefined {
  const workspace = parseWorkspaceSessionUrl(issueUrl);
  if (workspace) {
    return paths.workspaceSlugDir(workspace.slugKey);
  }
  try {
    return paths.canonicalRepoSessionsDir(issueUrl);
  } catch {
    return undefined;
  }
}

async function listWorkspaceSessionResumeStoreLocations(
  repoRoot: string,
  slugKey: string,
  options: {
    userEnsembleRoot?: string;
    onDuplicate?: (diagnostic: SessionResumeStoreDuplicateDiagnostic) => void;
  } = {},
): Promise<LocatedSessionResumeStore[]> {
  const paths = resolveEnsemblePaths({
    repoRoot,
    ...(options.userEnsembleRoot
      ? { userEnsembleRoot: options.userEnsembleRoot }
      : {}),
  });
  const slugRoot = paths.workspaceSlugDir(slugKey);
  const candidates: LocatedSessionResumeStore[] = [];
  const visited = new Set<string>();
  let entries: Dirent[];
  try {
    entries = await readdir(slugRoot, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = join(slugRoot, entry.name);
    if (visited.has(path)) continue;
    visited.add(path);
    const resumeStore = await loadSessionResumeStore(path);
    if (!resumeStore) continue;
    if (parseWorkspaceSessionUrl(resumeStore.issueUrl)?.slugKey !== slugKey) {
      continue;
    }
    candidates.push({ resumeStore, path, location: 'workspace-slug' });
  }
  return candidates;
}

interface SessionResumeStorePageCursor {
  version: typeof SESSION_RESUME_STORE_PAGE_CURSOR_VERSION;
  updatedAt: number;
  issueKey: string;
  conductorAgentId: string;
}

function resolveSessionResumeStoreScope(input: {
  githubRepo?: string;
  issueUrl?: string;
}): { githubRepo?: string; issueKey?: string } {
  const githubRepo =
    input.githubRepo === undefined
      ? undefined
      : normalizeGitHubRepo(input.githubRepo);
  let issue: ReturnType<typeof sessionIssueIdentity> | undefined;
  if (input.issueUrl !== undefined) {
    if (!parseWorkspaceSessionUrl(input.issueUrl)) {
      parseIssueUrl(input.issueUrl);
    }
    issue = sessionIssueIdentity(input.issueUrl);
  }
  if (
    githubRepo !== undefined &&
    issue !== undefined &&
    issue.repository !== 'workspace' &&
    githubRepo !== issue.repository
  ) {
    throw new Error(
      '--github-repo and --issue-url refer to different GitHub repositories.',
    );
  }
  return {
    ...(githubRepo ?? issue?.repository
      ? { githubRepo: githubRepo ?? issue?.repository }
      : {}),
    ...(issue ? { issueKey: issue.key } : {}),
  };
}

function normalizeGitHubRepo(value: string): string {
  const segments = value.trim().split('/');
  if (
    segments.length !== 2 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        !/^[A-Za-z0-9_.-]+$/u.test(segment),
    )
  ) {
    throw new Error(
      `Invalid GitHub repository "${value}" (expected <owner>/<repo>).`,
    );
  }
  return `${segments[0]!.toLowerCase()}/${segments[1]!.replace(/\.git$/iu, '').toLowerCase()}`;
}

function sessionIssueIdentity(issueUrl: string): {
  repository: string;
  key: string;
} {
  const workspace = parseWorkspaceSessionUrl(issueUrl);
  if (workspace) {
    return {
      repository: 'workspace',
      key: `workspace:${workspace.slugKey}`,
    };
  }
  try {
    const issue = parseIssueUrl(issueUrl);
    const repository = `${issue.owner.toLowerCase()}/${issue.repo.toLowerCase()}`;
    return {
      repository,
      key: `${repository}#${issue.number}`,
    };
  } catch {
    return { repository: '', key: `invalid:${issueUrl.toLowerCase()}` };
  }
}

function compareLocatedSessionResumeStores(
  left: LocatedSessionResumeStore,
  right: LocatedSessionResumeStore,
): number {
  return (
    right.resumeStore.updatedAt - left.resumeStore.updatedAt ||
    sessionIssueIdentity(left.resumeStore.issueUrl).key.localeCompare(
      sessionIssueIdentity(right.resumeStore.issueUrl).key,
    ) ||
    left.resumeStore.conductorAgentId.localeCompare(
      right.resumeStore.conductorAgentId,
    )
  );
}

function compareLocatedSessionResumeStoreToCursor(
  store: LocatedSessionResumeStore,
  cursor: SessionResumeStorePageCursor,
): number {
  const resumeStore = store.resumeStore;
  return (
    cursor.updatedAt - resumeStore.updatedAt ||
    sessionIssueIdentity(resumeStore.issueUrl).key.localeCompare(
      cursor.issueKey,
    ) ||
    resumeStore.conductorAgentId.localeCompare(cursor.conductorAgentId)
  );
}

function validateSessionResumeStorePageLimit(limit: number): number {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > SESSION_RESUME_STORE_PAGE_MAX_LIMIT
  ) {
    throw new Error(
      `limit must be an integer between 1 and ${SESSION_RESUME_STORE_PAGE_MAX_LIMIT}.`,
    );
  }
  return limit;
}

function encodeSessionResumeStoreCursor(
  store: LocatedSessionResumeStore,
): string {
  const cursor: SessionResumeStorePageCursor = {
    version: SESSION_RESUME_STORE_PAGE_CURSOR_VERSION,
    updatedAt: store.resumeStore.updatedAt,
    issueKey: sessionIssueIdentity(store.resumeStore.issueUrl).key,
    conductorAgentId: store.resumeStore.conductorAgentId,
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeSessionResumeStoreCursor(
  value: string,
): SessionResumeStorePageCursor {
  let cursor: unknown;
  try {
    cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid session list cursor.');
  }
  if (
    !isRecord(cursor) ||
    cursor.version !== SESSION_RESUME_STORE_PAGE_CURSOR_VERSION ||
    typeof cursor.updatedAt !== 'number' ||
    !Number.isFinite(cursor.updatedAt) ||
    typeof cursor.issueKey !== 'string' ||
    typeof cursor.conductorAgentId !== 'string'
  ) {
    throw new Error('Invalid session list cursor.');
  }
  return {
    version: cursor.version,
    updatedAt: cursor.updatedAt,
    issueKey: cursor.issueKey,
    conductorAgentId: cursor.conductorAgentId,
  };
}

/** @deprecated Use listSessionResumeStores; supported for one release only. */
export const listSessionSidecars = listSessionResumeStores;

/**
 * 同一 Issue では close / abort を優先し、exit を除外したうえで
 * updatedAt が最も新しい SessionResumeStore を返す。
 */
export interface FindLatestWorkspaceSessionResumeStoreInput {
  repoRoot: string;
  slugKey: string;
  home?: string;
  userEnsembleRoot?: string;
}

export async function findLatestSessionResumeStoreForWorkspace(
  input: FindLatestWorkspaceSessionResumeStoreInput,
): Promise<SessionResumeStore | undefined> {
  return findLatestSessionResumeStoreForIssue({
    repoRoot: input.repoRoot,
    issueUrl: workspaceSessionUrl(input.slugKey),
    ...(input.home !== undefined ? { home: input.home } : {}),
    ...(input.userEnsembleRoot !== undefined
      ? { userEnsembleRoot: input.userEnsembleRoot }
      : {}),
  });
}

export async function findLatestSessionResumeStoreForIssue(
  input: FindLatestSessionResumeStoreInput,
): Promise<SessionResumeStore | undefined> {
  const issueKey = sessionIssueIdentity(input.issueUrl).key;
  const matches = (
    await listLocatedSessionResumeStoresPage(input.repoRoot, {
      issueUrl: input.issueUrl,
    })
  ).sessions
    .map(({ resumeStore }) => resumeStore)
    .filter(
      (resumeStore) =>
        sessionIssueIdentity(resumeStore.issueUrl).key === issueKey &&
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
    conductorAgentId: string;
    /** @deprecated Retained for source compatibility; root is not an identity check. */
    repoRoot?: string;
    /** @deprecated Retained for source compatibility; backend differences are diagnostic. */
    conductorBackend?: ConductorBackend;
    /** @deprecated Retained for source compatibility; MCP digest differences are diagnostic. */
    mcpConfigDigest?: string;
    /** @deprecated Retained for source compatibility; missing digest is not a gate. */
    mcpConfigConfigured?: boolean;
    /** @deprecated Retained for source compatibility; config digest differences are diagnostic. */
    ensembleConfigDigest?: string;
  },
): void {
  if (resumeStore.conductorAgentId !== input.conductorAgentId) {
    throw new Error(
      `Session resume store conductorAgentId mismatch: ${resumeStore.conductorAgentId} !== ${input.conductorAgentId}`,
    );
  }
  if (
    sessionIssueIdentity(resumeStore.issueUrl).key !==
    sessionIssueIdentity(input.issueUrl).key
  ) {
    throw new Error(
      `Session resume store issueUrl mismatch: ${resumeStore.issueUrl} !== ${input.issueUrl}`,
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
  if (
    record.createdHarnessCliVersion !== undefined &&
    typeof record.createdHarnessCliVersion !== 'string'
  ) {
    throw new Error(
      'Invalid session resume store: createdHarnessCliVersion',
    );
  }
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
    record.acpModelConfigDigest !== undefined &&
    (typeof record.acpModelConfigDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.acpModelConfigDigest))
  ) {
    throw new Error('Invalid session resume store: acpModelConfigDigest');
  }
  const ensembleConfigDigestScheme = parseEnsembleConfigDigestScheme(
    record.ensembleConfigDigestScheme,
  );
  if (
    ensembleConfigDigestScheme === 'resume-feasibility' &&
    record.ensembleConfigDigest === undefined
  ) {
    throw new Error(
      'Invalid session resume store: resume-feasibility scheme requires ensembleConfigDigest',
    );
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
    record.cursorBootstrapComplete !== undefined &&
    typeof record.cursorBootstrapComplete !== 'boolean'
  ) {
    throw new Error('Invalid session resume store: cursorBootstrapComplete');
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
    if (worker.handoffPending !== undefined && typeof worker.handoffPending !== 'boolean') {
      throw new Error(`Invalid session resume store worker handoffPending: ${name}`);
    }
    if (worker.workspacePromptVersion !== undefined && (!Number.isSafeInteger(worker.workspacePromptVersion) || (worker.workspacePromptVersion as number) < 1)) {
      throw new Error(`Invalid session resume store worker workspacePromptVersion: ${name}`);
    }
    workers[name] = {
      ...(typeof worker.workspacePromptVersion === 'number' ? { workspacePromptVersion: worker.workspacePromptVersion } : {}),
      acpSessionId: worker.acpSessionId,
      ...(typeof worker.acpCwd === 'string' ? { acpCwd: worker.acpCwd } : {}),
      ...(typeof worker.repoRoot === 'string' ? { repoRoot: worker.repoRoot } : {}),
      ...(typeof worker.issueUrl === 'string' ? { issueUrl: worker.issueUrl } : {}),
      ...(worker.handoffPending === true ? { handoffPending: true } : {}),
      ...(typeof worker.originAcpCwd === 'string' ? { originAcpCwd: worker.originAcpCwd } : {}),
      ...(parseAcpSpawnFingerprint(worker.originAcpSpawn, name)
        ? { originAcpSpawn: parseAcpSpawnFingerprint(worker.originAcpSpawn, name) }
        : {}),
      ...(parseAcpSpawnFingerprint(worker.acpSpawn, name)
        ? { acpSpawn: parseAcpSpawnFingerprint(worker.acpSpawn, name) }
        : {}),
      ...(worker.generations !== undefined
        ? { generations: parseWorkerSessionGenerations(worker.generations, name) }
        : {}),
    };
  }

  return {
    version: SESSION_RESUME_STORE_VERSION,
    conductorAgentId: record.conductorAgentId,
    conductorBackend,
    ...(typeof record.createdHarnessCliVersion === 'string'
      ? { createdHarnessCliVersion: record.createdHarnessCliVersion }
      : {}),
    ...(typeof record.conductorCwd === 'string'
      ? { conductorCwd: record.conductorCwd }
      : {}),
    ...(typeof record.cursorBootstrapRunId === 'string'
      ? { cursorBootstrapRunId: record.cursorBootstrapRunId }
      : {}),
    ...(typeof record.cursorBootstrapComplete === 'boolean'
      ? { cursorBootstrapComplete: record.cursorBootstrapComplete }
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
    ...(ensembleConfigDigestScheme !== undefined
      ? { ensembleConfigDigestScheme }
      : {}),
    ...(typeof record.ensembleConfigDigest === 'string'
      ? { ensembleConfigDigest: record.ensembleConfigDigest }
      : {}),
    ...(typeof record.acpModelConfigDigest === 'string'
      ? { acpModelConfigDigest: record.acpModelConfigDigest }
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

function parseEnsembleConfigDigestScheme(
  value: unknown,
): EnsembleConfigDigestScheme | undefined {
  if (value === undefined) return undefined;
  if (value === 'full' || value === 'resume-feasibility') return value;
  throw new Error(
    `Unsupported session resume store ensembleConfigDigestScheme: ${String(value)}`,
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
  let piRuntime: AcpSpawnFingerprint['piRuntime'] = undefined;
  if (record.piRuntime === 'builtin') {
    piRuntime = 'builtin';
  } else if (
    record.piRuntime !== undefined &&
    record.piRuntime !== 'byo'
  ) {
    throw new Error(
      `Invalid session resume store worker acpSpawn piRuntime: ${workerName}`,
    );
  }
  let modelTag: AcpModelTag | undefined;
  if (record.modelTag !== undefined) {
    if (typeof record.modelTag !== 'string') {
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
  let reasoning: string | undefined;
  if (record.reasoning !== undefined) {
    if (typeof record.reasoning !== 'string' || record.reasoning.length === 0) {
      throw new Error(
        `Invalid session resume store worker acpSpawn reasoning: ${workerName}`,
      );
    }
    reasoning = record.reasoning;
  }
  let cursorFast: boolean | undefined;
  if (record.cursorFast !== undefined) {
    if (typeof record.cursorFast !== 'boolean') {
      throw new Error(
        `Invalid session resume store worker acpSpawn cursorFast: ${workerName}`,
      );
    }
    cursorFast = record.cursorFast;
  }
  let modelProviderDigest: string | undefined;
  if (record.modelProviderDigest !== undefined) {
    if (
      typeof record.modelProviderDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.modelProviderDigest)
    ) {
      throw new Error(
        `Invalid session resume store worker acpSpawn modelProviderDigest: ${workerName}`,
      );
    }
    modelProviderDigest = record.modelProviderDigest;
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
    ...(piRuntime !== undefined ? { piRuntime } : {}),
    ...(modelTag !== undefined ? { modelTag } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(cursorFast !== undefined ? { cursorFast } : {}),
    ...(modelProviderDigest !== undefined ? { modelProviderDigest } : {}),
    ...(envDigest ? { envDigest } : {}),
  };
}

export interface WorkspaceSlugListEntry {
  slugKey: string;
  latestUpdatedAt?: number;
  latestConductorAgentId?: string;
}

export async function listWorkspaceSlugEntries(input: {
  repoRoot: string;
  userEnsembleRoot?: string;
}): Promise<WorkspaceSlugListEntry[]> {
  const paths = resolveEnsemblePaths({
    repoRoot: input.repoRoot,
    ...(input.userEnsembleRoot
      ? { userEnsembleRoot: input.userEnsembleRoot }
      : {}),
  });
  let slugDirs: Dirent[];
  try {
    slugDirs = await readdir(paths.workspacesRoot, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const entries: WorkspaceSlugListEntry[] = [];
  for (const dirent of slugDirs) {
    if (!dirent.isDirectory()) continue;
    const slugKey = dirent.name;
    const latest = await findLatestSessionResumeStoreForWorkspace({
      repoRoot: input.repoRoot,
      slugKey,
      ...(input.userEnsembleRoot
        ? { userEnsembleRoot: input.userEnsembleRoot }
        : {}),
    });
    entries.push({
      slugKey,
      ...(latest
        ? {
            latestUpdatedAt: latest.updatedAt,
            latestConductorAgentId: latest.conductorAgentId,
          }
        : {}),
    });
  }
  entries.sort(
    (left, right) =>
      (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0) ||
      left.slugKey.localeCompare(right.slugKey),
  );
  return entries;
}
