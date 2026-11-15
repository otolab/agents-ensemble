import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Transform } from 'node:stream';
import {
  SessionManager,
  parseSessionEntries,
  type SessionMessageEntry,
} from '@earendil-works/pi-coding-agent';
import { parseIssueUrl } from '../issue/issue-ref.js';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import { resolvePiAcpSessionMapPaths } from '../acp/pi-session-map.js';
import type { PiAcpRuntimeMarker } from '../acp/resolve-acp-spawn.js';
import {
  findSessionResumeStoreBySelector,
  listUserLocatedSessionResumeStoresPage,
} from './session-resume-store.js';

export type WorkerSessionHistoryMessageRole = 'user' | 'assistant';

export interface WorkerSessionHistoryMessage {
  source: string;
  providerId: string;
  role: WorkerSessionHistoryMessageRole;
  at?: number;
  text: string;
}

export type WorkerSessionHistoryReaderStatus =
  | 'supported'
  | 'unsupported'
  | 'unavailable';

export interface WorkerSessionHistoryReaderSupport {
  preset: string | null;
  status: 'supported' | 'unsupported';
  reader?: string;
  reason?: string;
}

export interface WorkerSessionHistoryReaderInput {
  repoRoot: string;
  fallbackRepoRoots?: readonly string[];
  userEnsembleRoot?: string;
  workerName: string;
  acpSessionId: string;
  acpCwd: string;
  piRuntime?: PiAcpRuntimeMarker;
  issueNumber?: number;
}

/** Adapter contract for reading a provider's local worker transcript. */
export interface WorkerSessionHistoryReader {
  id: string;
  preset: string;
  read(
    input: WorkerSessionHistoryReaderInput,
  ): Promise<WorkerSessionHistoryMessage[]>;
}

export interface WorkerSessionHistoryResult
  extends Omit<WorkerSessionHistoryReaderSupport, 'status'> {
  conductorAgentId: string;
  worker: string;
  status: WorkerSessionHistoryReaderStatus;
  messages: WorkerSessionHistoryMessage[];
  /** Absolute source transcript paths, returned only when explicitly requested. */
  sourceFiles?: string[];
}

interface WorkerSessionHistoryReaderWithSources
  extends WorkerSessionHistoryReader {
  readWithSources(
    input: WorkerSessionHistoryReaderInput,
  ): Promise<{
    messages: WorkerSessionHistoryMessage[];
    sourceFiles: string[];
  }>;
}

const PI_ACP_JSONL_READER_ID = 'pi-acp-jsonl';
const CODEX_CLI_ROLLOUT_READER_ID = 'codex-cli-rollout-jsonl';
const CURSOR_ACP_SQLITE_READER_ID = 'cursor-acp-sqlite';
const CODEX_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const workerSessionHistoryReaders = new Map<
  string,
  WorkerSessionHistoryReaderWithSources
>([
  [
    'pi',
    {
      id: PI_ACP_JSONL_READER_ID,
      preset: 'pi',
      read: async (input) =>
        (await readPiAcpSessionHistoryWithSources(input)).messages,
      readWithSources: readPiAcpSessionHistoryWithSources,
    },
  ],
  [
    'codex',
    {
      id: CODEX_CLI_ROLLOUT_READER_ID,
      preset: 'codex',
      read: async (input) =>
        (await readCodexAcpSessionHistoryWithSources(input)).messages,
      readWithSources: readCodexAcpSessionHistoryWithSources,
    },
  ],
  [
    'cursor',
    {
      id: CURSOR_ACP_SQLITE_READER_ID,
      preset: 'cursor',
      read: async (input) =>
        (await readCursorAcpSessionHistoryWithSources(input)).messages,
      readWithSources: readCursorAcpSessionHistoryWithSources,
    },
  ],
]);

export function getWorkerSessionHistoryReaderSupport(
  preset: string | undefined,
): WorkerSessionHistoryReaderSupport {
  const normalizedPreset = preset?.trim() || undefined;
  if (!normalizedPreset) {
    return {
      preset: null,
      status: 'unsupported',
      reason:
        'SessionResumeStore に ACP preset がないため、読み取り方式を判定できません。',
    };
  }

  const reader = workerSessionHistoryReaders.get(normalizedPreset);
  if (reader) {
    return {
      preset: normalizedPreset,
      status: 'supported',
      reader: reader.id,
    };
  }

  return {
    preset: normalizedPreset,
    status: 'unsupported',
    reason: `ACP preset「${normalizedPreset}」のオフライン transcript reader は未対応です。`,
  };
}

export async function readWorkerSessionHistory(input: {
  repoRoot?: string;
  userEnsembleRoot?: string;
  conductorAgentId: string;
  workerName: string;
  githubRepo?: string;
  issueUrl?: string;
  includeSourceFiles?: boolean;
}): Promise<WorkerSessionHistoryResult> {
  const conductorAgentId = requireNonEmpty(
    input.conductorAgentId,
    'conductorAgentId',
  );
  const workerName = requireNonEmpty(input.workerName, 'workerName');
  const located = input.userEnsembleRoot
    ? await findUserWorkerSessionResumeStore({
        userEnsembleRoot: input.userEnsembleRoot,
        conductorAgentId,
        githubRepo: input.githubRepo,
        issueUrl: input.issueUrl,
      })
    : await findSessionResumeStoreBySelector(
        requireRepoRoot(input.repoRoot),
        {
          githubRepo: input.githubRepo,
          issueUrl: input.issueUrl,
          conductorAgentId,
        },
      );
  if (!located) {
    throw new Error(`No saved session found for ${conductorAgentId}.`);
  }
  const repoRoot = resolve(input.repoRoot ?? located.resumeStore.repoRoot);

  const worker = located.resumeStore.workers[workerName];
  if (!worker) {
    throw new Error(
      `No saved worker session found for ${workerName} in ${conductorAgentId}.`,
    );
  }

  const support = getWorkerSessionHistoryReaderSupport(
    worker.acpSpawn?.preset,
  );
  const base = {
    conductorAgentId,
    worker: workerName,
    ...support,
  };
  if (support.status === 'unsupported') {
    return {
      ...base,
      status: 'unsupported',
      messages: [],
      ...(input.includeSourceFiles ? { sourceFiles: [] } : {}),
    };
  }

  if (!support.preset) {
    return {
      ...base,
      status: 'unsupported',
      reason: '対応 reader の ACP preset を解決できません。',
      messages: [],
      ...(input.includeSourceFiles ? { sourceFiles: [] } : {}),
    };
  }
  const reader = workerSessionHistoryReaders.get(support.preset);
  if (!reader) {
    throw new Error(`Worker session history reader is missing: ${support.preset}`);
  }
  if (!worker.acpCwd?.trim()) {
    return {
      ...base,
      status: 'unavailable',
      reason:
        'SessionResumeStore に worker ACP cwd がないため、transcript を照合できません。',
      messages: [],
      ...(input.includeSourceFiles ? { sourceFiles: [] } : {}),
    };
  }

  try {
    const piRuntime = worker.acpSpawn?.piRuntime;
    let issueNumber: number | undefined;
    if (piRuntime === 'builtin') {
      try {
        issueNumber = parseIssueUrl(located.resumeStore.issueUrl).number;
      } catch {
        throw new WorkerSessionHistoryUnavailableError(
          'SessionResumeStore に有効な Issue URL がないため、builtin Pi の保存先を解決できません。',
        );
      }
    }
    const readerInput: WorkerSessionHistoryReaderInput = {
      repoRoot,
      fallbackRepoRoots: [located.resumeStore.repoRoot],
      ...(input.userEnsembleRoot
        ? { userEnsembleRoot: input.userEnsembleRoot }
        : {}),
      workerName,
      acpSessionId: worker.acpSessionId,
      acpCwd: worker.acpCwd,
      ...(piRuntime
        ? { piRuntime }
        : {}),
      ...(issueNumber !== undefined ? { issueNumber } : {}),
    };
    const result = input.includeSourceFiles
      ? await reader.readWithSources(readerInput)
      : {
          messages: await reader.read(readerInput),
          sourceFiles: [],
        };
    return {
      ...base,
      status: 'supported',
      messages: result.messages,
      ...(input.includeSourceFiles
        ? { sourceFiles: result.sourceFiles }
        : {}),
    };
  } catch (error) {
    if (!(error instanceof WorkerSessionHistoryUnavailableError)) {
      throw error;
    }
    return {
      ...base,
      status: 'unavailable',
      reason: error.message,
      messages: [],
      ...(input.includeSourceFiles ? { sourceFiles: [] } : {}),
    };
  }
}

async function findUserWorkerSessionResumeStore(input: {
  userEnsembleRoot: string;
  conductorAgentId: string;
  githubRepo?: string;
  issueUrl?: string;
}) {
  if (!input.githubRepo && !input.issueUrl) {
    throw new Error(
      'Repository scope is required to read a session; pass githubRepo or issueUrl.',
    );
  }
  const page = await listUserLocatedSessionResumeStoresPage(
    {
      githubRepo: input.githubRepo,
      issueUrl: input.issueUrl,
      conductorAgentId: input.conductorAgentId,
    },
    { userEnsembleRoot: input.userEnsembleRoot },
  );
  if (page.sessions.length > 1) {
    throw new Error(
      `Session ${input.conductorAgentId} is ambiguous in this repository; specify issueUrl.`,
    );
  }
  return page.sessions[0];
}

function requireRepoRoot(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error('repoRoot is required to read a repository-scoped session.');
  }
  return resolve(value);
}

class WorkerSessionHistoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerSessionHistoryUnavailableError';
  }
}

interface PiAcpSessionMapEntry {
  sessionId: string;
  cwd: string;
  sessionFile: string;
}

async function readPiAcpSessionHistoryWithSources(
  input: WorkerSessionHistoryReaderInput,
): Promise<{
  messages: WorkerSessionHistoryMessage[];
  sourceFiles: string[];
}> {
  const paths =
    input.piRuntime === 'builtin'
      ? resolveEnsemblePaths({
          repoRoot: input.repoRoot,
          userEnsembleRoot: input.userEnsembleRoot,
        })
      : undefined;
  let session: PiAcpSessionMapEntry | undefined;
  let foundMap = false;
  let malformedMap = false;
  let sessionMapPaths: string[];
  if (paths) {
    const issueNumber = input.issueNumber;
    if (
      issueNumber === undefined ||
      !Number.isSafeInteger(issueNumber) ||
      issueNumber < 1
    ) {
      throw new WorkerSessionHistoryUnavailableError(
        'builtin Pi の Issue number がなく、session map を解決できません。',
      );
    }
    sessionMapPaths = [
      ...[input.repoRoot, ...(input.fallbackRepoRoots ?? [])].flatMap(
        (repoRoot) => {
          const rootPaths = resolveEnsemblePaths({
            repoRoot,
            userEnsembleRoot: input.userEnsembleRoot,
          });
          const mapPaths = resolvePiAcpSessionMapPaths(
            rootPaths.piWorkerDir(input.workerName, issueNumber),
            rootPaths.legacyPiWorkerDir(input.workerName),
          );
          return [mapPaths.upstreamPath, ...mapPaths.compatibilityPaths];
        },
      ),
    ];
  } else {
    sessionMapPaths = [join(homedir(), '.pi', 'pi-acp', 'session-map.json')];
  }

  for (const path of new Set(sessionMapPaths)) {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
      foundMap = true;
    } catch (error) {
      if (isEnoent(error)) continue;
      throw new WorkerSessionHistoryUnavailableError(
        'Pi ACP の session map を読み取れませんでした。',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      malformedMap = true;
      continue;
    }

    session = findPiAcpSessionMapEntry(parsed, input.acpSessionId);
    if (session) break;
  }
  if (!session) {
    if (!foundMap) {
      throw new WorkerSessionHistoryUnavailableError(
        'Pi ACP の session map が見つかりません。',
      );
    }
    if (malformedMap) {
      throw new WorkerSessionHistoryUnavailableError(
        'Pi ACP の session map が不正な JSON です。',
      );
    }
    throw new WorkerSessionHistoryUnavailableError(
      'Pi ACP の session map に対象 session がありません。',
    );
  }

  if (!isAbsolute(session.cwd) || resolve(session.cwd) !== resolve(input.acpCwd)) {
    throw new WorkerSessionHistoryUnavailableError(
      'Pi ACP session map の cwd が SessionResumeStore と一致しません。',
    );
  }
  if (
    !isAbsolute(session.sessionFile) ||
    extname(session.sessionFile).toLowerCase() !== '.jsonl'
  ) {
    throw new WorkerSessionHistoryUnavailableError(
      'Pi ACP session map に有効な transcript path がありません。',
    );
  }

  let transcriptStat;
  try {
    transcriptStat = await stat(session.sessionFile);
  } catch (error) {
    if (isEnoent(error)) {
      throw new WorkerSessionHistoryUnavailableError(
        'Pi ACP session map が指す transcript file が見つかりません。',
      );
    }
    throw new WorkerSessionHistoryUnavailableError(
      'Pi ACP transcript file を読み取れませんでした。',
    );
  }
  if (!transcriptStat.isFile()) {
    throw new WorkerSessionHistoryUnavailableError(
      'Pi ACP session map が指す transcript path は file ではありません。',
    );
  }

  let transcript: string;
  try {
    transcript = await readFile(session.sessionFile, 'utf8');
  } catch (error) {
    if (isEnoent(error)) {
      throw new WorkerSessionHistoryUnavailableError(
        'Pi ACP session map が指す transcript file が見つかりません。',
      );
    }
    throw new WorkerSessionHistoryUnavailableError(
      'Pi ACP transcript file を読み取れませんでした。',
    );
  }

  const entries = parseSessionEntries(transcript);
  const header = getPiSessionHeader(entries[0]);
  if (!header) {
    throw new WorkerSessionHistoryUnavailableError(
      'Pi ACP transcript に有効な session header がありません。',
    );
  }
  if (header.id !== input.acpSessionId) {
    throw new WorkerSessionHistoryUnavailableError(
      'Pi ACP transcript の session ID が保存状態と一致しません。',
    );
  }
  if (
    !isAbsolute(header.cwd) ||
    resolve(header.cwd) !== resolve(input.acpCwd)
  ) {
    throw new WorkerSessionHistoryUnavailableError(
      'Pi ACP transcript header の cwd が保存状態と一致しません。',
    );
  }

  let sessionManager: SessionManager;
  try {
    // `open()` persists empty-session initialization and legacy migrations.
    sessionManager = SessionManager.inMemory(header.cwd, undefined, entries);
  } catch {
    throw new WorkerSessionHistoryUnavailableError(
      'Pi ACP transcript を Pi session format として読み取れませんでした。',
    );
  }
  if (sessionManager.getSessionId() !== input.acpSessionId) {
    throw new WorkerSessionHistoryUnavailableError(
      'Pi ACP transcript の session ID が保存状態と一致しません。',
    );
  }

  let branch: ReturnType<SessionManager['getBranch']>;
  try {
    branch = sessionManager.getBranch();
  } catch {
    throw new WorkerSessionHistoryUnavailableError(
      'Pi ACP transcript の active branch を読み取れませんでした。',
    );
  }

  return {
    messages: branch.flatMap((entry): WorkerSessionHistoryMessage[] => {
      if (!isSessionMessageEntry(entry)) return [];
      const role = entry.message.role;
      if (role !== 'user' && role !== 'assistant') return [];
      const text = extractPiMessageText(entry.message.content);
      if (!text.trim()) return [];
      const at = getMessageTimestamp(entry);
      return [
        {
          source: `worker:${input.workerName}`,
          providerId: entry.id,
          role,
          ...(at !== undefined ? { at } : {}),
          text,
        },
      ];
    }),
    sourceFiles: [session.sessionFile],
  };
}

async function readCodexAcpSessionHistoryWithSources(
  input: WorkerSessionHistoryReaderInput,
): Promise<{
  messages: WorkerSessionHistoryMessage[];
  sourceFiles: string[];
}> {
  const sessionId = input.acpSessionId.trim();
  if (!sessionId) {
    throw new WorkerSessionHistoryUnavailableError(
      'SessionResumeStore に Codex ACP session ID がありません。',
    );
  }
  if (!isAbsolute(input.acpCwd)) {
    throw new WorkerSessionHistoryUnavailableError(
      'SessionResumeStore に有効な Codex ACP cwd がありません。',
    );
  }

  const codexHome = resolveCodexHome(input.acpCwd);
  const rolloutPath = await findCodexAcpRollout(codexHome, sessionId);
  if (!rolloutPath) {
    throw new WorkerSessionHistoryUnavailableError(
      '現在の Codex home に対象 session の rollout が見つかりません。',
    );
  }

  let decompressor: Transform | undefined;
  if (rolloutPath.endsWith('.jsonl.zst')) {
    const zlib = await import('node:zlib');
    const createZstdDecompress = (
      zlib as unknown as {
        createZstdDecompress?: () => Transform;
      }
    ).createZstdDecompress;
    if (!createZstdDecompress) {
      throw new WorkerSessionHistoryUnavailableError(
        '現在の Node.js は Codex の圧縮 rollout（zstd）に対応していません。',
      );
    }
    decompressor = createZstdDecompress();
  }

  const sourceStream = createReadStream(rolloutPath);
  const inputStream: Readable = decompressor
    ? sourceStream.pipe(decompressor)
    : sourceStream;
  let streamError: unknown;
  const recordStreamError = (error: Error): void => {
    streamError ??= error;
  };
  sourceStream.on('error', (error) => {
    recordStreamError(error);
    if (decompressor) decompressor.destroy(error);
  });
  if (decompressor) decompressor.on('error', recordStreamError);

  try {
    const lines = createInterface({
      input: inputStream,
      crlfDelay: Infinity,
    });
    let header:
      | {
          id: string;
          cwd: string;
        }
      | undefined;
    let lineNumber = 0;
    const messages: WorkerSessionHistoryMessage[] = [];

    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (!line.trim()) continue;

        let envelope: unknown;
        try {
          envelope = JSON.parse(line);
        } catch {
          throw new WorkerSessionHistoryUnavailableError(
            'Codex CLI rollout の JSONL に不正な行があります。',
          );
        }

        if (!header) {
          header = getCodexSessionHeader(envelope);
          if (!header) {
            throw new WorkerSessionHistoryUnavailableError(
              'Codex CLI rollout に有効な session_meta がありません。',
            );
          }
          if (header.id !== sessionId) {
            throw new WorkerSessionHistoryUnavailableError(
              'Codex CLI rollout の session ID が保存状態と一致しません。',
            );
          }
          if (
            !isAbsolute(header.cwd) ||
            resolve(header.cwd) !== resolve(input.acpCwd)
          ) {
            throw new WorkerSessionHistoryUnavailableError(
              'Codex CLI rollout の cwd が保存状態と一致しません。',
            );
          }
          continue;
        }

        const message = codexRolloutMessage(
          envelope,
          input.workerName,
          lineNumber,
        );
        if (message) messages.push(message);
      }
    } finally {
      lines.close();
    }

    if (streamError) {
      throw new WorkerSessionHistoryUnavailableError(
        'Codex CLI rollout を読み取れませんでした。',
      );
    }
    if (!header) {
      throw new WorkerSessionHistoryUnavailableError(
        'Codex CLI rollout に有効な session_meta がありません。',
      );
    }
    return {
      messages,
      sourceFiles: [rolloutPath],
    };
  } catch (error) {
    if (error instanceof WorkerSessionHistoryUnavailableError) throw error;
    throw new WorkerSessionHistoryUnavailableError(
      'Codex CLI rollout を読み取れませんでした。',
    );
  } finally {
    decompressor?.destroy();
    sourceStream.destroy();
  }
}

interface CursorAcpSessionMetadata {
  schemaVersion: number;
  cwd: string;
}

interface CursorStoreMetadata {
  agentId: string;
  latestRootBlobId: string;
}

interface CursorProtobufField {
  number: number;
  wireType: number;
  bytes?: Uint8Array;
  integer?: bigint;
}

async function readCursorAcpSessionHistoryWithSources(
  input: WorkerSessionHistoryReaderInput,
): Promise<{
  messages: WorkerSessionHistoryMessage[];
  sourceFiles: string[];
}> {
  const sessionId = input.acpSessionId.trim();
  if (
    !sessionId ||
    /[/\\\0]/u.test(sessionId) ||
    sessionId === '.' ||
    sessionId === '..'
  ) {
    throw new WorkerSessionHistoryUnavailableError(
      'SessionResumeStore に有効な Cursor ACP session ID がありません。',
    );
  }
  if (!isAbsolute(input.acpCwd)) {
    throw new WorkerSessionHistoryUnavailableError(
      'SessionResumeStore に有効な Cursor ACP cwd がありません。',
    );
  }

  const sessionDirectory = join(
    resolveCursorConfigRoot(input.acpCwd),
    'acp-sessions',
    sessionId,
  );
  const metadataPath = join(sessionDirectory, 'meta.json');
  let metadata: CursorAcpSessionMetadata;
  try {
    metadata = parseCursorAcpSessionMetadata(
      await readFile(metadataPath, 'utf8'),
    );
  } catch (error) {
    if (error instanceof WorkerSessionHistoryUnavailableError) throw error;
    if (isEnoent(error)) {
      throw new WorkerSessionHistoryUnavailableError(
        'Cursor ACP session の meta.json が見つかりません。',
      );
    }
    throw new WorkerSessionHistoryUnavailableError(
      'Cursor ACP session の meta.json を読み取れませんでした。',
    );
  }
  if (metadata.schemaVersion !== 1) {
    throw new WorkerSessionHistoryUnavailableError(
      'Cursor ACP session の保存形式に対応していません。',
    );
  }
  if (
    !isAbsolute(metadata.cwd) ||
    resolve(metadata.cwd) !== resolve(input.acpCwd)
  ) {
    throw new WorkerSessionHistoryUnavailableError(
      'Cursor ACP session metadata の cwd が SessionResumeStore と一致しません。',
    );
  }

  const storePath = join(sessionDirectory, 'store.db');
  try {
    if (!(await stat(storePath)).isFile()) {
      throw new WorkerSessionHistoryUnavailableError(
        'Cursor ACP session の store.db が file ではありません。',
      );
    }
  } catch (error) {
    if (error instanceof WorkerSessionHistoryUnavailableError) throw error;
    if (isEnoent(error)) {
      throw new WorkerSessionHistoryUnavailableError(
        'Cursor ACP session の store.db が見つかりません。',
      );
    }
    throw new WorkerSessionHistoryUnavailableError(
      'Cursor ACP session の store.db を確認できませんでした。',
    );
  }

  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    throw new WorkerSessionHistoryUnavailableError(
      'Cursor ACP store の SQLite 読み取りには node:sqlite が必要です（Node.js 22.13.0 以降）。',
    );
  }

  let database: InstanceType<typeof sqlite.DatabaseSync> | undefined;
  try {
    database = new sqlite.DatabaseSync(storePath, { readOnly: true });
    const metadataRow = database
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('0');
    const storeMetadata = parseCursorStoreMetadata(metadataRow?.value);
    if (storeMetadata.agentId !== sessionId) {
      throw new WorkerSessionHistoryUnavailableError(
        'Cursor ACP store の session ID が SessionResumeStore と一致しません。',
      );
    }

    const blobStatement = database.prepare(
      'SELECT data FROM blobs WHERE id = ?',
    );
    const readBlob = (blobId: string): Uint8Array => {
      const row = blobStatement.get(`agentKv:blob:${blobId}`);
      const data = row?.data;
      if (!(data instanceof Uint8Array)) {
        throw new WorkerSessionHistoryUnavailableError(
          'Cursor ACP store の transcript blob が見つからないか、読み取れません。',
        );
      }
      return data;
    };
    const messages = readCursorConversation(
      readBlob,
      storeMetadata.latestRootBlobId,
      input.workerName,
    );
    return {
      messages,
      sourceFiles: [metadataPath, storePath],
    };
  } catch (error) {
    if (error instanceof WorkerSessionHistoryUnavailableError) throw error;
    throw new WorkerSessionHistoryUnavailableError(
      'Cursor ACP store を読み取れませんでした。',
    );
  } finally {
    database?.close();
  }
}

function resolveCursorConfigRoot(acpCwd: string): string {
  const configuredRoot = process.env.CURSOR_CONFIG_DIR?.trim();
  if (configuredRoot) return resolve(acpCwd, configuredRoot);

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return join(resolve(acpCwd, xdgConfigHome), 'cursor');
  }
  return join(homedir(), '.cursor');
}

function parseCursorAcpSessionMetadata(raw: string): CursorAcpSessionMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkerSessionHistoryUnavailableError(
      'Cursor ACP session の meta.json が不正な JSON です。',
    );
  }
  if (!isRecord(parsed) || typeof parsed.cwd !== 'string') {
    throw new WorkerSessionHistoryUnavailableError(
      'Cursor ACP session の meta.json に cwd がありません。',
    );
  }
  return {
    schemaVersion:
      typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : -1,
    cwd: parsed.cwd,
  };
}

function parseCursorStoreMetadata(value: unknown): CursorStoreMetadata {
  let serialized: string;
  if (typeof value === 'string') {
    if (value.trimStart().startsWith('{')) {
      serialized = value;
    } else if (/^(?:[0-9a-f]{2})+$/iu.test(value)) {
      serialized = Buffer.from(value, 'hex').toString('utf8');
    } else {
      throw new WorkerSessionHistoryUnavailableError(
        'Cursor ACP store に有効な metadata がありません。',
      );
    }
  } else if (value instanceof Uint8Array) {
    serialized = new TextDecoder('utf-8', { fatal: true }).decode(value);
  } else {
    throw new WorkerSessionHistoryUnavailableError(
      'Cursor ACP store に metadata がありません。',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new WorkerSessionHistoryUnavailableError(
      'Cursor ACP store の metadata が不正です。',
    );
  }
  if (!isRecord(parsed)) {
    throw new WorkerSessionHistoryUnavailableError(
      'Cursor ACP store の metadata が不正です。',
    );
  }
  const agentId = parsed.agentId;
  const latestRootBlobId = parsed.latestRootBlobId;
  if (
    typeof agentId !== 'string' ||
    typeof latestRootBlobId !== 'string' ||
    !/^[0-9a-f]{64}$/iu.test(latestRootBlobId)
  ) {
    throw new WorkerSessionHistoryUnavailableError(
      'Cursor ACP store の session metadata または transcript root が不正です。',
    );
  }
  return { agentId, latestRootBlobId: latestRootBlobId.toLowerCase() };
}

function readCursorConversation(
  readBlob: (blobId: string) => Uint8Array,
  rootBlobId: string,
  workerName: string,
): WorkerSessionHistoryMessage[] {
  const messages: WorkerSessionHistoryMessage[] = [];
  const root = parseCursorProtobuf(readBlob(rootBlobId));
  const turnBlobIds = cursorProtobufBytes(root, 8);

  for (const [turnIndex, turnBlobId] of turnBlobIds.entries()) {
    const turn = parseCursorProtobuf(
      readBlob(readCursorBlobReference(turnBlobId)),
    );
    const agentTurns = cursorProtobufBytes(turn, 1);
    for (const agentTurnBytes of agentTurns) {
      const agentTurn = parseCursorProtobuf(agentTurnBytes);
      const userMessageBlobId = cursorProtobufBytes(agentTurn, 1)[0];
      if (!userMessageBlobId) {
        throw new WorkerSessionHistoryUnavailableError(
          'Cursor ACP transcript の user message 参照がありません。',
        );
      }
      const userMessage = parseCursorProtobuf(
        readBlob(readCursorBlobReference(userMessageBlobId)),
      );
      const userText = cursorProtobufString(userMessage, 1);
      if (userText?.trim()) {
        const at = cursorProtobufTimestamp(userMessage, 25);
        messages.push({
          source: `worker:${workerName}`,
          providerId: `cursor:${turnIndex}:user`,
          role: 'user',
          ...(at !== undefined ? { at } : {}),
          text: userText,
        });
      }

      const stepBlobIds = cursorProtobufBytes(agentTurn, 2);
      for (const [stepIndex, stepBlobId] of stepBlobIds.entries()) {
        const step = parseCursorProtobuf(
          readBlob(readCursorBlobReference(stepBlobId)),
        );
        const assistantMessages = cursorProtobufBytes(step, 1);
        for (const assistantMessageBytes of assistantMessages) {
          const assistantMessage = parseCursorProtobuf(assistantMessageBytes);
          const assistantText = cursorProtobufString(assistantMessage, 1);
          if (!assistantText?.trim()) continue;
          const at = cursorProtobufTimestamp(assistantMessage, 2);
          messages.push({
            source: `worker:${workerName}`,
            providerId: `cursor:${turnIndex}:assistant:${stepIndex}`,
            role: 'assistant',
            ...(at !== undefined ? { at } : {}),
            text: assistantText,
          });
        }
      }
    }
  }
  return messages;
}

function readCursorBlobReference(bytes: Uint8Array): string {
  if (bytes.byteLength !== 32) {
    throw new WorkerSessionHistoryUnavailableError(
      'Cursor ACP transcript の blob 参照が不正です。',
    );
  }
  return Buffer.from(bytes).toString('hex');
}

function parseCursorProtobuf(bytes: Uint8Array): CursorProtobufField[] {
  const fields: CursorProtobufField[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const tag = readCursorVarint(bytes, offset);
    offset = tag.nextOffset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNumber < 1 || fieldNumber > 0x1fffffff) {
      throw new WorkerSessionHistoryUnavailableError(
        'Cursor ACP transcript の protobuf field が不正です。',
      );
    }

    if (wireType === 0) {
      const value = readCursorVarint(bytes, offset);
      fields.push({ number: fieldNumber, wireType, integer: value.value });
      offset = value.nextOffset;
    } else if (wireType === 1 || wireType === 5) {
      const width = wireType === 1 ? 8 : 4;
      if (offset + width > bytes.byteLength) {
        throw new WorkerSessionHistoryUnavailableError(
          'Cursor ACP transcript の protobuf field が途中で終わっています。',
        );
      }
      fields.push({ number: fieldNumber, wireType });
      offset += width;
    } else if (wireType === 2) {
      const length = readCursorVarint(bytes, offset);
      offset = length.nextOffset;
      if (length.value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new WorkerSessionHistoryUnavailableError(
          'Cursor ACP transcript の protobuf field が大きすぎます。',
        );
      }
      const end = offset + Number(length.value);
      if (end > bytes.byteLength) {
        throw new WorkerSessionHistoryUnavailableError(
          'Cursor ACP transcript の protobuf field が途中で終わっています。',
        );
      }
      fields.push({
        number: fieldNumber,
        wireType,
        bytes: bytes.subarray(offset, end),
      });
      offset = end;
    } else {
      throw new WorkerSessionHistoryUnavailableError(
        'Cursor ACP transcript に未対応の protobuf wire type があります。',
      );
    }
  }
  return fields;
}

function readCursorVarint(
  bytes: Uint8Array,
  startOffset: number,
): { value: bigint; nextOffset: number } {
  let value = 0n;
  let shift = 0n;
  let offset = startOffset;
  while (offset < bytes.byteLength && shift < 70n) {
    const next = bytes[offset]!;
    offset += 1;
    value |= BigInt(next & 0x7f) << shift;
    if ((next & 0x80) === 0) return { value, nextOffset: offset };
    shift += 7n;
  }
  throw new WorkerSessionHistoryUnavailableError(
    'Cursor ACP transcript の protobuf varint が不正です。',
  );
}

function cursorProtobufBytes(
  fields: readonly CursorProtobufField[],
  fieldNumber: number,
): Uint8Array[] {
  return fields
    .filter((field) => field.number === fieldNumber)
    .map((field) => {
      if (field.wireType !== 2 || !field.bytes) {
        throw new WorkerSessionHistoryUnavailableError(
          'Cursor ACP transcript の protobuf bytes field が不正です。',
        );
      }
      return field.bytes;
    });
}

function cursorProtobufString(
  fields: readonly CursorProtobufField[],
  fieldNumber: number,
): string | undefined {
  const bytes = cursorProtobufBytes(fields, fieldNumber).at(-1);
  if (!bytes) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new WorkerSessionHistoryUnavailableError(
      'Cursor ACP transcript の文字列 field が不正な UTF-8 です。',
    );
  }
}

function cursorProtobufTimestamp(
  fields: readonly CursorProtobufField[],
  fieldNumber: number,
): number | undefined {
  const field = fields
    .filter((candidate) => candidate.number === fieldNumber)
    .at(-1);
  if (!field) return undefined;
  if (
    field.wireType !== 0 ||
    field.integer === undefined ||
    field.integer > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new WorkerSessionHistoryUnavailableError(
      'Cursor ACP transcript の timestamp が不正です。',
    );
  }
  return Number(field.integer);
}

function resolveCodexHome(acpCwd: string): string {
  const configuredHome = process.env.CODEX_HOME;
  if (configuredHome) {
    return resolve(acpCwd, configuredHome);
  }
  return join(homedir(), '.codex');
}

interface CodexAcpRolloutCandidate {
  path: string;
}

async function findCodexAcpRollout(
  codexHome: string,
  sessionId: string,
): Promise<string | undefined> {
  const candidates: CodexAcpRolloutCandidate[] = [];
  for (const directoryName of ['sessions', 'archived_sessions']) {
    const directory = join(codexHome, directoryName);
    await collectCodexAcpRolloutCandidates(directory, sessionId, candidates);
  }
  if (candidates.length > 1) {
    throw new WorkerSessionHistoryUnavailableError(
      'Codex CLI store に同じ session ID の rollout が複数あり、対象を一意に決められません。',
    );
  }
  return candidates[0]?.path;
}

async function collectCodexAcpRolloutCandidates(
  directory: string,
  sessionId: string,
  candidates: CodexAcpRolloutCandidate[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return;
    throw new WorkerSessionHistoryUnavailableError(
      'Codex CLI store を探索できませんでした。',
    );
  }

  const plainRolloutNames = new Set(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name),
  );

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectCodexAcpRolloutCandidates(path, sessionId, candidates);
      continue;
    }
    if (!entry.isFile()) continue;

    const plainFileName = codexRolloutPlainFileName(entry.name);
    if (
      !plainFileName ||
      (entry.name.endsWith('.jsonl.zst') &&
        plainRolloutNames.has(plainFileName))
    ) {
      continue;
    }

    const threadId = codexThreadIdFromRolloutFileName(entry.name);
    if (threadId !== sessionId) continue;

    candidates.push({ path });
  }
}

function codexRolloutPlainFileName(fileName: string): string | undefined {
  if (fileName.endsWith('.jsonl.zst')) return fileName.slice(0, -4);
  if (fileName.endsWith('.jsonl')) return fileName;
  return undefined;
}

function codexThreadIdFromRolloutFileName(
  fileName: string,
): string | undefined {
  const plainFileName = codexRolloutPlainFileName(fileName);
  if (!plainFileName) return undefined;

  const baseName = plainFileName.slice(0, -'.jsonl'.length);
  if (!baseName.startsWith('rollout-')) return undefined;
  const identity = baseName.slice('rollout-'.length);
  const timestamp = identity.slice(0, 19);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/u.test(timestamp) ||
    identity[19] !== '-'
  ) {
    return undefined;
  }

  const rolloutIds = identity.slice(20);
  const separator = rolloutIds.indexOf('_');
  const threadId =
    separator < 0 ? rolloutIds : rolloutIds.slice(0, separator);
  const rolloutId =
    separator < 0 ? threadId : rolloutIds.slice(separator + 1);
  if (!threadId || (separator >= 0 && !rolloutIds.slice(separator + 1))) {
    return undefined;
  }
  if (
    !CODEX_UUID_PATTERN.test(threadId) ||
    !CODEX_UUID_PATTERN.test(rolloutId) ||
    !isCodexRolloutTimestamp(timestamp)
  ) {
    return undefined;
  }
  return threadId;
}

function isCodexRolloutTimestamp(value: string): boolean {
  const isoTimestamp = `${value.slice(0, 10)}T${value.slice(11, 13)}:${value.slice(14, 16)}:${value.slice(17, 19)}Z`;
  const timestamp = new Date(isoTimestamp);
  return (
    Number.isFinite(timestamp.getTime()) &&
    timestamp.toISOString().slice(0, 19).replaceAll(':', '-') === value
  );
}

function getCodexSessionHeader(
  value: unknown,
): { id: string; cwd: string } | undefined {
  if (
    !isRecord(value) ||
    value.type !== 'session_meta' ||
    !isRecord(value.payload) ||
    typeof value.payload.id !== 'string' ||
    !value.payload.id.trim() ||
    typeof value.payload.cwd !== 'string' ||
    !value.payload.cwd.trim()
  ) {
    return undefined;
  }
  return {
    id: value.payload.id,
    cwd: value.payload.cwd,
  };
}

function codexRolloutMessage(
  value: unknown,
  workerName: string,
  lineNumber: number,
): WorkerSessionHistoryMessage | undefined {
  if (
    !isRecord(value) ||
    value.type !== 'response_item' ||
    !isRecord(value.payload) ||
    value.payload.type !== 'message' ||
    (value.payload.role !== 'user' && value.payload.role !== 'assistant')
  ) {
    return undefined;
  }
  const text = extractCodexMessageText(value.payload.content);
  if (!text.trim()) return undefined;
  const ordinal = value.ordinal;
  const providerId =
    typeof ordinal === 'number' && Number.isSafeInteger(ordinal)
      ? `codex:${ordinal}`
      : `codex:${lineNumber}`;
  const timestamp =
    typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN;
  return {
    source: `worker:${workerName}`,
    providerId,
    role: value.payload.role,
    ...(Number.isFinite(timestamp) ? { at: timestamp } : {}),
    text,
  };
}

function extractCodexMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        isRecord(block) &&
        (block.type === 'input_text' || block.type === 'output_text') &&
        typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

function getPiSessionHeader(
  value: unknown,
): { id: string; cwd: string } | undefined {
  if (
    !isRecord(value) ||
    value.type !== 'session' ||
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    typeof value.cwd !== 'string' ||
    !value.cwd.trim()
  ) {
    return undefined;
  }
  return { id: value.id, cwd: value.cwd };
}

function findPiAcpSessionMapEntry(
  value: unknown,
  sessionId: string,
): PiAcpSessionMapEntry | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.sessions)) {
    return undefined;
  }
  const entry = value.sessions[sessionId];
  if (
    !isRecord(entry) ||
    entry.sessionId !== sessionId ||
    typeof entry.cwd !== 'string' ||
    typeof entry.sessionFile !== 'string'
  ) {
    return undefined;
  }
  return {
    sessionId,
    cwd: entry.cwd,
    sessionFile: entry.sessionFile,
  };
}

function isSessionMessageEntry(
  entry: unknown,
): entry is SessionMessageEntry {
  return (
    isRecord(entry) &&
    entry.type === 'message' &&
    isRecord(entry.message) &&
    typeof entry.message.role === 'string'
  );
}

function extractPiMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        isRecord(block) &&
        block.type === 'text' &&
        typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

function getMessageTimestamp(entry: SessionMessageEntry): number | undefined {
  const messageTimestamp = entry.message.timestamp;
  if (
    typeof messageTimestamp === 'number' &&
    Number.isFinite(messageTimestamp)
  ) {
    return messageTimestamp;
  }
  const entryTimestamp = Date.parse(entry.timestamp);
  return Number.isFinite(entryTimestamp) ? entryTimestamp : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return (
    isRecord(error) &&
    error.code === 'ENOENT'
  );
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return normalized;
}
