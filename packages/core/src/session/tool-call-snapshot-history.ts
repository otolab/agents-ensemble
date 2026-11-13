import {
  chmod,
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
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import { writeFileIfMissing } from './persisted-file.js';

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
  issueUrl: string;
}): string {
  const paths = resolveEnsemblePaths({ repoRoot: input.repoRoot });
  return paths.canonicalToolCallHistoryPath(
    input.issueUrl,
    input.conductorAgentId,
  );
}

/**
 * Read the optional history independently from the required session resume store.
 * Invalid history is discarded locally so it cannot prevent session resume.
 */
export async function loadToolCallSnapshotHistory(input: {
  repoRoot: string;
  conductorAgentId: string;
  issueUrl: string;
  now?: number;
}): Promise<LoadToolCallSnapshotHistoryResult> {
  const paths = resolveEnsemblePaths({ repoRoot: input.repoRoot });
  const canonicalPath = toolCallSnapshotHistoryPath(input);
  const fallbackPaths = [
    paths.toolCallHistoryPath(input.conductorAgentId),
    paths.legacyToolCallHistoryPath(input.conductorAgentId),
  ].filter((path) => path !== canonicalPath);
  const now = input.now ?? Date.now();
  // A present slug file has precedence, even when malformed. Keep it intact
  // and report the problem instead of deleting it or promoting legacy data.
  const canonical = await readToolCallHistoryFile(canonicalPath, now);
  if (canonical.found) return canonical.result;

  for (const fallbackPath of fallbackPaths) {
    const fallback = await readToolCallHistoryFile(fallbackPath, now);
    if (!fallback.found) continue;
    if (fallback.result.entries.length > 0) {
      try {
        const created = await writeFileIfMissing(
          canonicalPath,
          serializeHistory(fallback.result.entries),
        );
        if (!created) {
          // A slug file appeared after lookup; use it instead of merging the
          // fallback into or replacing it.
          const racedCanonical = await readToolCallHistoryFile(
            canonicalPath,
            now,
          );
          if (racedCanonical.found) return racedCanonical.result;
        }
      } catch {
        // Tool-call history is optional; an unsuccessful migration must not
        // make the session resume fail.
      }
    }
    return fallback.result;
  }

  return { entries: [], needsRewrite: false };
}

async function readToolCallHistoryFile(
  path: string,
  now: number,
): Promise<{
  found: boolean;
  result: LoadToolCallSnapshotHistoryResult;
}> {
  let fileInfo: Awaited<ReturnType<typeof stat>>;
  try {
    fileInfo = await stat(path);
  } catch (error) {
    if (isEnoent(error)) {
      return { found: false, result: { entries: [], needsRewrite: false } };
    }
    return {
      found: true,
      result: {
        entries: [],
        needsRewrite: false,
        warning: 'tool-call snapshot history could not be read and was ignored',
      },
    };
  }
  if (fileInfo.size > TOOL_CALL_SNAPSHOT_HISTORY_MAX_BYTES) {
    return {
      found: true,
      result: {
        entries: [],
        needsRewrite: false,
        warning:
          'tool-call snapshot history exceeds the size limit and was discarded',
      },
    };
  }

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) {
      return { found: false, result: { entries: [], needsRewrite: false } };
    }
    return {
      found: true,
      result: {
        entries: [],
        needsRewrite: false,
        warning: 'tool-call snapshot history could not be read and was ignored',
      },
    };
  }

  const discard = async (warning: string): Promise<{
    found: true;
    result: LoadToolCallSnapshotHistoryResult;
  }> => {
    return {
      found: true,
      result: { entries: [], needsRewrite: false, warning },
    };
  };
  if (Buffer.byteLength(raw, 'utf8') > TOOL_CALL_SNAPSHOT_HISTORY_MAX_BYTES) {
    return discard(
      'tool-call snapshot history exceeds the size limit and was discarded',
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return discard('tool-call snapshot history is invalid and was discarded');
  }

  if (
    !isRecord(value) ||
    value.version !== TOOL_CALL_SNAPSHOT_HISTORY_VERSION ||
    !Array.isArray(value.snapshots)
  ) {
    return discard(
      'tool-call snapshot history has an unsupported format and was discarded',
    );
  }

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
      entry.updatedAt > now - TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS,
  );
  if (retained.length !== entries.length) needsRewrite = true;

  return {
    found: true,
    result: {
      entries: retained,
      needsRewrite,
      ...(invalidCount > 0
        ? {
            warning: `tool-call snapshot history contained ${invalidCount} invalid entr${invalidCount === 1 ? 'y' : 'ies'}; invalid entries were skipped`,
          }
        : {}),
    },
  };
}

function serializeHistory(
  snapshots: readonly StoredToolCallSnapshot[],
): string {
  return JSON.stringify({
    version: TOOL_CALL_SNAPSHOT_HISTORY_VERSION,
    snapshots,
  });
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

  const serialized = serializeHistory(snapshots);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tempPath = `${path}.tmp`;
  try {
    await writeFile(tempPath, serialized, { encoding: 'utf8', mode: 0o600 });
    await chmod(tempPath, 0o600);
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
  input: { repoRoot: string; issueUrl: string },
  now = Date.now(),
): Promise<PruneToolCallSnapshotHistoryResult> {
  let removedCount = 0;
  let failedCount = 0;
  const cutoff = now - TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS;
  const paths = resolveEnsemblePaths({ repoRoot: input.repoRoot });
  const dir = paths.canonicalRepoSessionsDir(input.issueUrl);
  {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if (isEnoent(error)) return { removedCount, failedCount };
      failedCount += 1;
      return { removedCount, failedCount };
    }
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
