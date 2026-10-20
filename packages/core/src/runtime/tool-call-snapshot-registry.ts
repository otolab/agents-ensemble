/** ACP tool-call data accumulated from `tool_call` and `tool_call_update`. */
export interface ToolCallSnapshot extends Record<string, unknown> {
  toolCallId: string;
}

/** ACP tool-call IDs are unique only within a worker's ACP session. */
export interface ToolCallSnapshotScope {
  workerId: string;
  sessionId: string;
  /** Stable across conductor resumes; runtime worker IDs are regenerated. */
  workerName?: string;
}

export interface ScopedToolCallSnapshot extends ToolCallSnapshotScope {
  snapshot: ToolCallSnapshot;
}

export interface StoredToolCallSnapshot extends ToolCallSnapshotScope {
  workerName: string;
  updatedAt: number;
  snapshot: ToolCallSnapshot;
}

export interface EncodedToolCallSnapshot
  extends Omit<ToolCallSnapshotScope, 'workerName'> {
  workerName?: string;
  updatedAt: number;
  snapshot: ToolCallSnapshot;
}

export type ToolCallSnapshotApplyResult =
  | { status: 'applied'; evictedCount: number }
  | { status: 'ignored'; reason: 'missing-scope-or-id' | 'invalid-data' | 'too-large' };

export const TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const TOOL_CALL_SNAPSHOT_HISTORY_MAX_ENTRIES = 1_000;
export const TOOL_CALL_SNAPSHOT_HISTORY_MAX_BYTES = 8 * 1024 * 1024;

const HISTORY_VERSION = 1;

interface RegistryEntry {
  snapshot: ToolCallSnapshot;
  workerName?: string;
  updatedAt: number;
}

/**
 * Keeps bounded tool-call snapshots for one conductor session.
 *
 * Entries are scoped by worker and ACP session because ACP toolCallIds are not
 * unique across sessions. ACP updates are partial, so omitted and null fields
 * do not erase previously observed data. The same bounds apply to in-memory
 * data and the persisted history file.
 */
export class ToolCallSnapshotRegistry {
  private readonly snapshots = new Map<
    string,
    Map<string, Map<string, RegistryEntry>>
  >();

  apply(
    scope: ToolCallSnapshotScope,
    update: Record<string, unknown>,
    updatedAt = Date.now(),
  ): void {
    this.applyWithResult(scope, update, updatedAt);
  }

  applyWithResult(
    scope: ToolCallSnapshotScope,
    update: Record<string, unknown>,
    updatedAt = Date.now(),
  ): ToolCallSnapshotApplyResult {
    if (!scope.workerId.trim() || !scope.sessionId.trim()) {
      return { status: 'ignored', reason: 'missing-scope-or-id' };
    }

    const nested = asRecord(update.toolCall ?? update.tool_call);
    const toolCallId =
      readString(update, 'toolCallId', 'tool_call_id') ??
      (nested ? readString(nested, 'toolCallId', 'tool_call_id') : undefined);
    if (!toolCallId) {
      return { status: 'ignored', reason: 'missing-scope-or-id' };
    }
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
      return { status: 'ignored', reason: 'invalid-data' };
    }

    const incoming: Record<string, unknown> = {
      ...(nested ?? {}),
      ...Object.fromEntries(
        Object.entries(update).filter(
          ([key]) =>
            key !== 'sessionUpdate' &&
            key !== 'sessionId' &&
            key !== 'toolCall' &&
            key !== 'tool_call',
        ),
      ),
      toolCallId,
    };
    const previous = this.snapshots
      .get(scope.workerId)
      ?.get(scope.sessionId)
      ?.get(toolCallId);
    if (previous && previous.updatedAt > updatedAt) {
      return { status: 'applied', evictedCount: 0 };
    }

    const accumulated: Record<string, unknown> = {
      ...(previous?.snapshot ?? {}),
    };
    for (const [key, value] of Object.entries(incoming)) {
      if (value !== undefined && value !== null) {
        if (key === '__proto__') {
          Object.defineProperty(accumulated, key, {
            value,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        } else {
          accumulated[key] = value;
        }
      }
    }

    let clonedSnapshot: ToolCallSnapshot;
    try {
      clonedSnapshot = JSON.parse(
        JSON.stringify(accumulated),
      ) as ToolCallSnapshot;
    } catch {
      return { status: 'ignored', reason: 'invalid-data' };
    }

    const candidate: RegistryEntry = {
      snapshot: clonedSnapshot,
      ...(scope.workerName ? { workerName: scope.workerName } : {}),
      updatedAt,
    };
    this.pruneExpired(updatedAt);
    if (
      encodedHistorySize([
        {
          workerId: scope.workerId,
          sessionId: scope.sessionId,
          ...(candidate.workerName ? { workerName: candidate.workerName } : {}),
          updatedAt: candidate.updatedAt,
          snapshot: candidate.snapshot,
        },
      ]) > TOOL_CALL_SNAPSHOT_HISTORY_MAX_BYTES
    ) {
      return { status: 'ignored', reason: 'too-large' };
    }

    this.getOrCreateSession(scope.workerId, scope.sessionId).set(toolCallId, candidate);
    const evictedCount = this.enforceLimits();
    return { status: 'applied', evictedCount };
  }

  /** Returns a snapshot only for the exact worker and ACP session scope. */
  get(
    toolCallId: string,
    scope: ToolCallSnapshotScope,
    now = Date.now(),
  ): ToolCallSnapshot | undefined {
    this.pruneExpired(now);
    return this.snapshots
      .get(scope.workerId)
      ?.get(scope.sessionId)
      ?.get(toolCallId)?.snapshot;
  }

  /** Returns all matches separately, with their worker/session scopes intact. */
  findAll(toolCallId: string, now = Date.now()): ScopedToolCallSnapshot[] {
    this.pruneExpired(now);
    const matches: ScopedToolCallSnapshot[] = [];
    for (const [workerId, workerSnapshots] of this.snapshots) {
      for (const [sessionId, sessionSnapshots] of workerSnapshots) {
        const entry = sessionSnapshots.get(toolCallId);
        if (entry) {
          matches.push({
            workerId,
            sessionId,
            ...(entry.workerName ? { workerName: entry.workerName } : {}),
            snapshot: entry.snapshot,
          });
        }
      }
    }
    return matches;
  }

  /** Returns persistable entries; unnamed in-memory scopes cannot be rebound. */
  snapshot(now = Date.now()): StoredToolCallSnapshot[] {
    this.pruneExpired(now);
    const entries: StoredToolCallSnapshot[] = [];
    for (const [workerId, workerSnapshots] of this.snapshots) {
      for (const [sessionId, sessionSnapshots] of workerSnapshots) {
        for (const entry of sessionSnapshots.values()) {
          if (!entry.workerName) continue;
          entries.push({
            workerId,
            workerName: entry.workerName,
            sessionId,
            updatedAt: entry.updatedAt,
            snapshot: entry.snapshot,
          });
        }
      }
    }
    return entries;
  }

  /**
   * Restores entries under the current runtime worker IDs, using the stable
   * worker name recorded with each entry. Missing workers and expired entries
   * are skipped; their absence never affects session resume.
   */
  restore(
    entries: readonly StoredToolCallSnapshot[],
    workerIdsByName: ReadonlyMap<string, string>,
    now = Date.now(),
  ): { restoredCount: number; skippedCount: number } {
    let restoredCount = 0;
    let skippedCount = 0;
    for (const entry of [...entries].sort(
      (left, right) => left.updatedAt - right.updatedAt,
    )) {
      const workerId = workerIdsByName.get(entry.workerName);
      if (
        !workerId ||
        !Number.isFinite(entry.updatedAt) ||
        entry.updatedAt <= 0 ||
        entry.updatedAt <= now - TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS ||
        !isSnapshot(entry.snapshot) ||
        entry.snapshot.toolCallId.trim() === '' ||
        !entry.sessionId.trim()
      ) {
        skippedCount += 1;
        continue;
      }
      const result = this.applyWithResult(
        {
          workerId,
          workerName: entry.workerName,
          sessionId: entry.sessionId,
        },
        entry.snapshot,
        entry.updatedAt,
      );
      if (result.status === 'applied') {
        restoredCount += 1;
      } else {
        skippedCount += 1;
      }
    }
    return { restoredCount, skippedCount };
  }

  private getOrCreateSession(
    workerId: string,
    sessionId: string,
  ): Map<string, RegistryEntry> {
    let workerSnapshots = this.snapshots.get(workerId);
    if (!workerSnapshots) {
      workerSnapshots = new Map();
      this.snapshots.set(workerId, workerSnapshots);
    }
    let sessionSnapshots = workerSnapshots.get(sessionId);
    if (!sessionSnapshots) {
      sessionSnapshots = new Map();
      workerSnapshots.set(sessionId, sessionSnapshots);
    }
    return sessionSnapshots;
  }

  private pruneExpired(now: number): number {
    let removed = 0;
    for (const [workerId, workerSnapshots] of this.snapshots) {
      for (const [sessionId, sessionSnapshots] of workerSnapshots) {
        for (const [toolCallId, entry] of sessionSnapshots) {
          if (entry.updatedAt <= now - TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS) {
            sessionSnapshots.delete(toolCallId);
            removed += 1;
          }
        }
        if (sessionSnapshots.size === 0) workerSnapshots.delete(sessionId);
      }
      if (workerSnapshots.size === 0) this.snapshots.delete(workerId);
    }
    return removed;
  }

  private enforceLimits(): number {
    const entries = this.allEntries();
    entries.sort((left, right) => left.entry.updatedAt - right.entry.updatedAt);
    let evictedCount = 0;
    while (
      entries.length > TOOL_CALL_SNAPSHOT_HISTORY_MAX_ENTRIES ||
      encodedHistorySize(
        entries.map(({ workerId, sessionId, entry }) => ({
          workerId,
          sessionId,
          ...(entry.workerName ? { workerName: entry.workerName } : {}),
          updatedAt: entry.updatedAt,
          snapshot: entry.snapshot,
        })),
      ) > TOOL_CALL_SNAPSHOT_HISTORY_MAX_BYTES
    ) {
      const oldest = entries.shift();
      if (!oldest) break;
      this.snapshots
        .get(oldest.workerId)
        ?.get(oldest.sessionId)
        ?.delete(oldest.toolCallId);
      evictedCount += 1;
    }
    this.pruneEmptyScopes();
    return evictedCount;
  }

  private allEntries(): Array<{
    workerId: string;
    sessionId: string;
    toolCallId: string;
    entry: RegistryEntry;
  }> {
    const entries: Array<{
      workerId: string;
      sessionId: string;
      toolCallId: string;
      entry: RegistryEntry;
    }> = [];
    for (const [workerId, workerSnapshots] of this.snapshots) {
      for (const [sessionId, sessionSnapshots] of workerSnapshots) {
        for (const [toolCallId, entry] of sessionSnapshots) {
          entries.push({ workerId, sessionId, toolCallId, entry });
        }
      }
    }
    return entries;
  }

  private pruneEmptyScopes(): void {
    for (const [workerId, workerSnapshots] of this.snapshots) {
      for (const [sessionId, sessionSnapshots] of workerSnapshots) {
        if (sessionSnapshots.size === 0) workerSnapshots.delete(sessionId);
      }
      if (workerSnapshots.size === 0) this.snapshots.delete(workerId);
    }
  }
}

export function encodedHistorySize(
  snapshots: readonly EncodedToolCallSnapshot[],
): number {
  return Buffer.byteLength(
    JSON.stringify({ version: HISTORY_VERSION, snapshots }),
    'utf8',
  );
}

function isSnapshot(value: unknown): value is ToolCallSnapshot {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).toolCallId === 'string'
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
