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
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import type { PiAcpRuntimeMarker } from '../acp/resolve-acp-spawn.js';
import { findSessionResumeStore } from './session-resume-store.js';

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
  workerName: string;
  acpSessionId: string;
  acpCwd: string;
  piRuntime?: PiAcpRuntimeMarker;
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
  repoRoot: string;
  conductorAgentId: string;
  workerName: string;
  includeSourceFiles?: boolean;
}): Promise<WorkerSessionHistoryResult> {
  const repoRoot = resolve(input.repoRoot);
  const conductorAgentId = requireNonEmpty(
    input.conductorAgentId,
    'conductorAgentId',
  );
  const workerName = requireNonEmpty(input.workerName, 'workerName');
  const located = await findSessionResumeStore(repoRoot, conductorAgentId);
  if (
    !located ||
    resolve(located.resumeStore.repoRoot) !== repoRoot
  ) {
    throw new Error(`No saved session found for ${conductorAgentId}.`);
  }

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
    const readerInput: WorkerSessionHistoryReaderInput = {
      repoRoot,
      workerName,
      acpSessionId: worker.acpSessionId,
      acpCwd: worker.acpCwd,
      ...(worker.acpSpawn?.piRuntime
        ? { piRuntime: worker.acpSpawn.piRuntime }
        : {}),
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
      ? resolveEnsemblePaths({ repoRoot: input.repoRoot })
      : undefined;
  const sessionMapPaths = paths
    ? [
        paths.piWorkerSessionMapPath(input.workerName),
        paths.legacyPiWorkerSessionMapPath(input.workerName),
      ]
    : [join(homedir(), '.pi', 'pi-acp', 'session-map.json')];
  let raw: string | undefined;
  let lastReadError: unknown;
  for (const path of sessionMapPaths) {
    try {
      raw = await readFile(path, 'utf8');
      break;
    } catch (error) {
      lastReadError = error;
      if (!isEnoent(error)) {
        throw new WorkerSessionHistoryUnavailableError(
          'Pi ACP の session map を読み取れませんでした。',
        );
      }
    }
  }
  if (raw === undefined) {
    if (lastReadError === undefined || isEnoent(lastReadError)) {
      throw new WorkerSessionHistoryUnavailableError(
        'Pi ACP の session map が見つかりません。',
      );
    }
    throw new WorkerSessionHistoryUnavailableError(
      'Pi ACP の session map を読み取れませんでした。',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkerSessionHistoryUnavailableError(
      'Pi ACP の session map が不正な JSON です。',
    );
  }
  const session = findPiAcpSessionMapEntry(parsed, input.acpSessionId);
  if (!session) {
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
