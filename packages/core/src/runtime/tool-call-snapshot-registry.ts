/** ACP tool-call data accumulated from `tool_call` and `tool_call_update`. */
export interface ToolCallSnapshot extends Record<string, unknown> {
  toolCallId: string;
}

/**
 * Keeps tool-call snapshots for one conductor session.
 *
 * Entries live for the lifetime of the owning conductor session and are
 * discarded with it. ACP updates are partial, so omitted and null fields do
 * not erase previously observed data.
 */
export class ToolCallSnapshotRegistry {
  private readonly snapshots = new Map<string, ToolCallSnapshot>();

  apply(update: Record<string, unknown>): void {
    const nested = asRecord(update.toolCall ?? update.tool_call);
    const toolCallId =
      readString(update, 'toolCallId', 'tool_call_id') ??
      (nested ? readString(nested, 'toolCallId', 'tool_call_id') : undefined);
    if (!toolCallId) {
      return;
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
    const previous = this.snapshots.get(toolCallId);
    const accumulated = { ...(previous ?? {}) };
    for (const [key, value] of Object.entries(incoming)) {
      if (value !== undefined && value !== null) {
        accumulated[key] = value;
      }
    }
    this.snapshots.set(toolCallId, accumulated as ToolCallSnapshot);
  }

  get(toolCallId: string): ToolCallSnapshot | undefined {
    return this.snapshots.get(toolCallId);
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
