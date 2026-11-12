import { Agent, type Run } from '@cursor/sdk';

export interface CursorConductorRunSnapshot {
  metadata: {
    agentId: string;
    id: string;
    status: string;
    requestId?: string;
    createdAt?: number;
    result?: string;
  };
  conversation?: unknown;
  conversationStatus: 'available' | 'unavailable';
}

export interface CursorConductorRunSnapshots {
  status: 'available' | 'partial' | 'unavailable';
  runs: CursorConductorRunSnapshot[];
  warnings: string[];
}

/**
 * Read every Cursor run exposed by the local SDK for a conductor session.
 *
 * Unlike the paged provider-history API, this export path has no run-count
 * limit. A failed page or run is reported while preserving snapshots already
 * read.
 */
export async function readCursorConductorRunSnapshots(input: {
  conductorAgentId: string;
  cwd: string;
}): Promise<CursorConductorRunSnapshots> {
  const runs: CursorConductorRunSnapshot[] = [];
  const warnings: string[] = [];
  const seenCursors = new Set<string>();
  const seenRunIds = new Set<string>();
  let cursor: string | undefined;
  let listingComplete = false;
  let partial = false;

  try {
    do {
      const page = await Agent.listRuns(input.conductorAgentId, {
        runtime: 'local',
        cwd: input.cwd,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });

      for (const listedRun of page.items) {
        if (seenRunIds.has(listedRun.id)) continue;
        seenRunIds.add(listedRun.id);
        const listedMetadata = cursorRunMetadata(listedRun);
        try {
          const run = await Agent.getRun(listedRun.id, {
            runtime: 'local',
            cwd: input.cwd,
          });
          if (run.agentId !== input.conductorAgentId) {
            partial = true;
            warnings.push(
              `Cursor run ${listedRun.id} belongs to a different agent; its body was omitted.`,
            );
            runs.push({
              metadata: listedMetadata,
              conversationStatus: 'unavailable',
            });
            continue;
          }

          try {
            const conversation = toJsonValue(await run.conversation());
            runs.push({
              metadata: cursorRunMetadata(run),
              conversation,
              conversationStatus: 'available',
            });
          } catch {
            partial = true;
            warnings.push(
              `Cursor run ${listedRun.id} metadata was read, but its conversation snapshot was unavailable.`,
            );
            runs.push({
              metadata: cursorRunMetadata(run),
              conversationStatus: 'unavailable',
            });
          }
        } catch {
          partial = true;
          warnings.push(
            `Cursor run ${listedRun.id} was listed, but its saved data could not be read.`,
          );
          runs.push({
            metadata: listedMetadata,
            conversationStatus: 'unavailable',
          });
        }
      }

      const nextCursor = page.nextCursor || undefined;
      if (nextCursor && seenCursors.has(nextCursor)) {
        partial = true;
        warnings.push(
          'Cursor run listing returned a repeated pagination cursor; remaining pages were not read.',
        );
        break;
      }
      if (nextCursor) seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    listingComplete = true;
  } catch {
    partial = true;
    warnings.push(
      'Cursor local run listing stopped before all pages could be read.',
    );
  }

  return {
    status:
      runs.length === 0 && !listingComplete
        ? 'unavailable'
        : partial || !listingComplete
          ? 'partial'
          : 'available',
    runs,
    warnings,
  };
}

function cursorRunMetadata(run: Run): CursorConductorRunSnapshot['metadata'] {
  return {
    agentId: run.agentId,
    id: run.id,
    status: run.status,
    ...(run.requestId ? { requestId: run.requestId } : {}),
    ...(typeof run.createdAt === 'number' && Number.isFinite(run.createdAt)
      ? { createdAt: run.createdAt }
      : {}),
    ...(typeof run.result === 'string' ? { result: run.result } : {}),
  };
}

function toJsonValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Cursor conversation is not JSON serializable.');
  }
  return JSON.parse(serialized) as unknown;
}
