/** ACP tool-call data accumulated from `tool_call` and `tool_call_update`. */
export interface ToolCallSnapshot extends Record<string, unknown> {
  toolCallId: string;
}

/** ACP tool-call IDs are unique only within a worker's ACP session. */
export interface ToolCallSnapshotScope {
  workerId: string;
  sessionId: string;
}

export interface ScopedToolCallSnapshot extends ToolCallSnapshotScope {
  snapshot: ToolCallSnapshot;
}

/**
 * Keeps tool-call snapshots for one conductor session.
 *
 * Entries live for the lifetime of the owning conductor session and are
 * discarded with it. Snapshots are scoped by worker and ACP session because
 * ACP toolCallIds are not unique across sessions. ACP updates are partial, so
 * omitted and null fields do not erase previously observed data.
 */
export class ToolCallSnapshotRegistry {
  private readonly snapshots = new Map<
    string,
    Map<string, Map<string, ToolCallSnapshot>>
  >();

  apply(scope: ToolCallSnapshotScope, update: Record<string, unknown>): void {
    if (!scope.workerId || !scope.sessionId) {
      return;
    }

    const nested = asRecord(update.toolCall ?? update.tool_call);
    const toolCallId =
      readString(update, 'toolCallId', 'tool_call_id') ??
      (nested ? readString(nested, 'toolCallId', 'tool_call_id') : undefined);
    if (!toolCallId) {
      return;
    }

    let workerSnapshots = this.snapshots.get(scope.workerId);
    if (!workerSnapshots) {
      workerSnapshots = new Map();
      this.snapshots.set(scope.workerId, workerSnapshots);
    }
    let sessionSnapshots = workerSnapshots.get(scope.sessionId);
    if (!sessionSnapshots) {
      sessionSnapshots = new Map();
      workerSnapshots.set(scope.sessionId, sessionSnapshots);
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
    const previous = sessionSnapshots.get(toolCallId);
    const accumulated = { ...(previous ?? {}) };
    for (const [key, value] of Object.entries(incoming)) {
      if (value !== undefined && value !== null) {
        accumulated[key] = value;
      }
    }
    sessionSnapshots.set(toolCallId, accumulated as ToolCallSnapshot);
  }

  /** Returns a snapshot only for the exact worker and ACP session scope. */
  get(
    toolCallId: string,
    scope: ToolCallSnapshotScope,
  ): ToolCallSnapshot | undefined {
    return this.snapshots
      .get(scope.workerId)
      ?.get(scope.sessionId)
      ?.get(toolCallId);
  }

  /** Returns all matches separately, with their worker/session scopes intact. */
  findAll(toolCallId: string): ScopedToolCallSnapshot[] {
    const matches: ScopedToolCallSnapshot[] = [];
    for (const [workerId, workerSnapshots] of this.snapshots) {
      for (const [sessionId, sessionSnapshots] of workerSnapshots) {
        const snapshot = sessionSnapshots.get(toolCallId);
        if (snapshot) {
          matches.push({ workerId, sessionId, snapshot });
        }
      }
    }
    return matches;
  }
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
