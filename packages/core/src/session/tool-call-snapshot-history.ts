import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  encodedHistorySize,
  TOOL_CALL_SNAPSHOT_HISTORY_MAX_BYTES,
  TOOL_CALL_SNAPSHOT_HISTORY_MAX_ENTRIES,
  TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS,
  type StoredToolCallSnapshot,
} from '../runtime/tool-call-snapshot-registry.js';
import { sessionResumeStoreDir } from './session-resume-store.js';

const TOOL_CALL_SNAPSHOT_HISTORY_VERSION = 1;
const TOOL_CALL_SNAPSHOT_HISTORY_SUFFIX = '.tool-calls';

export interface LoadToolCallSnapshotHistoryResult {
  entries: StoredToolCallSnapshot[];
  /** The loaded data was partially invalid or pruned and should be rewritten. */
  needsRewrite: boolean;
  warning?: string;
}

export interface PruneToolCallSnapshotHistoryResult {
  removedCount: number;
  failedCount: number;
}

export function toolCallSnapshotHistoryPath(input: {
  repoRoot: string;
  conductorAgentId: string;
}): string {
  return join(
    sessionResumeStoreDir(input.repoRoot),
    `${input.conductorAgentId}${TOOL_CALL_SNAPSHOT_HISTORY_SUFFIX}`,
  );
}

/**
 * Read the optional history independently from the required session resume state.
 * Invalid history is discarded locally so it cannot prevent session resume.
 */
export async function loadToolCallSnapshotHistory(input: {
  repoRoot: string;
  conductorAgentId: string;
  now?: number;
}): Promise<LoadToolCallSnapshotHistoryResult> {
  const path = toolCallSnapshotHistoryPath(input);
  let raw: string;
  try {
    const fileInfo = await stat(path);
    if (fileInfo.size > TOOL_CALL_SNAPSHOT_HISTORY_MAX_BYTES) {
      await removeHistoryFile(path);
      return {
        entries: [],
        needsRewrite: false,
        warning:
          'tool-call snapshot history exceeds the size limit and was discarded',
      };
    }
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) {
      return { entries: [], needsRewrite: false };
    }
    return {
      entries: [],
      needsRewrite: false,
      warning: 'tool-call snapshot history could not be read and was ignored',
    };
  }

  if (Buffer.byteLength(raw, 'utf8') > TOOL_CALL_SNAPSHOT_HISTORY_MAX_BYTES) {
    await removeHistoryFile(path);
    return {
      entries: [],
      needsRewrite: false,
      warning:
        'tool-call snapshot history exceeds the size limit and was discarded',
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    await removeHistoryFile(path);
    return {
      entries: [],
      needsRewrite: false,
      warning: 'tool-call snapshot history is invalid and was discarded',
    };
  }

  if (
    !isRecord(value) ||
    value.version !== TOOL_CALL_SNAPSHOT_HISTORY_VERSION ||
    !Array.isArray(value.snapshots)
  ) {
    await removeHistoryFile(path);
    return {
      entries: [],
      needsRewrite: false,
      warning:
        'tool-call snapshot history has an unsupported format and was discarded',
    };
  }

  const now = input.now ?? Date.now();
  const entries: StoredToolCallSnapshot[] = [];
  let invalidCount = 0;
  for (const candidate of value.snapshots) {
    const entry = parseHistoryEntry(candidate, now);
    if (!entry) {
      invalidCount += 1;
      continue;
    }
    entries.push(entry);
  }

  entries.sort((left, right) => left.updatedAt - right.updatedAt);
  let needsRewrite = invalidCount > 0;
  while (
    entries.length > TOOL_CALL_SNAPSHOT_HISTORY_MAX_ENTRIES ||
    encodedHistorySize(entries) > TOOL_CALL_SNAPSHOT_HISTORY_MAX_BYTES
  ) {
    entries.shift();
    needsRewrite = true;
  }

  const retained = entries.filter(
    (entry) =>
      entry.updatedAt >
      now - TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS,
  );
  if (retained.length !== entries.length) needsRewrite = true;

  return {
    entries: retained,
    needsRewrite,
    ...(invalidCount > 0
      ? {
          warning: `tool-call snapshot history contained ${invalidCount} invalid entr${invalidCount === 1 ? 'y' : 'ies'}; invalid entries were skipped`,
        }
      : {}),
  };
}

/** Save atomically; an empty history removes the optional file. */
export async function saveToolCallSnapshotHistory(
  path: string,
  snapshots: readonly StoredToolCallSnapshot[],
): Promise<void> {
  if (snapshots.length === 0) {
    await removeHistoryFile(path);
    return;
  }
  if (
    snapshots.length > TOOL_CALL_SNAPSHOT_HISTORY_MAX_ENTRIES ||
    encodedHistorySize(snapshots) > TOOL_CALL_SNAPSHOT_HISTORY_MAX_BYTES
  ) {
    throw new Error('tool-call snapshot history exceeds its configured limit');
  }

  const serialized = JSON.stringify({
    version: TOOL_CALL_SNAPSHOT_HISTORY_VERSION,
    snapshots,
  });
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  try {
    await writeFile(tempPath, serialized, 'utf8');
    await rename(tempPath, path);
  } catch (error) {
    await removeHistoryFile(tempPath);
    throw error;
  }
}

/**
 * Remove inactive history files after their retention window. Active files
 * prune individual expired snapshots in the registry as new updates arrive.
 */
export async function pruneExpiredToolCallSnapshotHistoryFiles(
  repoRoot: string,
  now = Date.now(),
): Promise<PruneToolCallSnapshotHistoryResult> {
  const dir = sessionResumeStoreDir(repoRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isEnoent(error)) return { removedCount: 0, failedCount: 0 };
    return { removedCount: 0, failedCount: 1 };
  }

  let removedCount = 0;
  let failedCount = 0;
  const cutoff = now - TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS;
  for (const entry of entries) {
    if (
      !entry.endsWith(TOOL_CALL_SNAPSHOT_HISTORY_SUFFIX) &&
      !entry.endsWith(`${TOOL_CALL_SNAPSHOT_HISTORY_SUFFIX}.tmp`)
    ) {
      continue;
    }
    const path = join(dir, entry);
    try {
      const fileInfo = await stat(path);
      if (!fileInfo.isFile() || fileInfo.mtimeMs > cutoff) continue;
      await rm(path, { force: true });
      removedCount += 1;
    } catch (error) {
      if (!isEnoent(error)) failedCount += 1;
    }
  }
  return { removedCount, failedCount };
}

function parseHistoryEntry(
  value: unknown,
  now: number,
): StoredToolCallSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const snapshot = value.snapshot;
  if (
    typeof value.workerId !== 'string' ||
    value.workerId.trim() === '' ||
    typeof value.workerName !== 'string' ||
    value.workerName.trim() === '' ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.trim() === '' ||
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt) ||
    value.updatedAt <= 0 ||
    value.updatedAt > now ||
    !isRecord(snapshot) ||
    typeof snapshot.toolCallId !== 'string' ||
    snapshot.toolCallId.trim() === ''
  ) {
    return undefined;
  }
  return {
    workerId: value.workerId,
    workerName: value.workerName,
    sessionId: value.sessionId,
    updatedAt: value.updatedAt,
    snapshot: snapshot as StoredToolCallSnapshot['snapshot'],
  };
}

async function removeHistoryFile(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
