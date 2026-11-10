import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import {
  SessionManager,
  type SessionMessageEntry,
} from '@earendil-works/pi-coding-agent';
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
  workerName: string;
  acpSessionId: string;
  acpCwd: string;
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
}

const PI_ACP_JSONL_READER_ID = 'pi-acp-jsonl';

const workerSessionHistoryReaders = new Map<
  string,
  WorkerSessionHistoryReader
>([
  [
    'pi',
    {
      id: PI_ACP_JSONL_READER_ID,
      preset: 'pi',
      read: readPiAcpSessionHistory,
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
    return { ...base, status: 'unsupported', messages: [] };
  }

  if (!support.preset) {
    return {
      ...base,
      status: 'unsupported',
      reason: '対応 reader の ACP preset を解決できません。',
      messages: [],
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
    };
  }

  try {
    const messages = await reader.read({
      workerName,
      acpSessionId: worker.acpSessionId,
      acpCwd: worker.acpCwd,
    });
    return { ...base, status: 'supported', messages };
  } catch (error) {
    if (!(error instanceof WorkerSessionHistoryUnavailableError)) {
      throw error;
    }
    return {
      ...base,
      status: 'unavailable',
      reason: error.message,
      messages: [],
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

async function readPiAcpSessionHistory(
  input: WorkerSessionHistoryReaderInput,
): Promise<WorkerSessionHistoryMessage[]> {
  const sessionMapPath = join(
    homedir(),
    '.pi',
    'pi-acp',
    'session-map.json',
  );
  let raw: string;
  try {
    raw = await readFile(sessionMapPath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) {
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

  let sessionManager: SessionManager;
  try {
    sessionManager = SessionManager.open(
      session.sessionFile,
      dirname(session.sessionFile),
      input.acpCwd,
    );
  } catch {
    throw new WorkerSessionHistoryUnavailableError(
      'Pi ACP transcript を Pi session format として読み取れませんでした。',
    );
  }
  if (
    sessionManager.getSessionId() !== input.acpSessionId ||
    resolve(sessionManager.getCwd()) !== resolve(input.acpCwd)
  ) {
    throw new WorkerSessionHistoryUnavailableError(
      'Pi ACP transcript の session ID または cwd が保存状態と一致しません。',
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

  return branch
    .flatMap((entry): WorkerSessionHistoryMessage[] => {
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
    });
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
