import {
  readWorkerSessionHistory,
  type ConductorJsonValue,
  type ConductorTool,
  type WorkerSessionHistoryResult,
} from '@agents-ensemble/core/operator-runtime';
import type { OperatorSessionStoreRoot } from './open-question-control-tools.js';

type WorkerSessionStoreLocation = string | OperatorSessionStoreRoot;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const WORKER_MESSAGES_CURSOR_VERSION = 1;

interface WorkerMessagesCursor {
  version: typeof WORKER_MESSAGES_CURSOR_VERSION;
  issueUrl: string;
  conductorAgentId: string;
  worker: string;
  order: 'asc' | 'desc';
  preset: string | null;
  reader: string | null;
  position: number;
  providerId: string;
}

export const LIST_WORKER_MESSAGES_TOOL = 'list_worker_messages';

/** Read one worker transcript using the exact saved Issue run identity. */
export function createListWorkerMessagesTool(
  location: WorkerSessionStoreLocation,
): ConductorTool {
  return {
    name: LIST_WORKER_MESSAGES_TOOL,
    description:
      'Read saved ACP worker transcript messages for one exact Issue URL and conductorAgentId. Reports unsupported readers, missing saved worker sessions, and unavailable transcripts explicitly. Worker prompt failures are not persisted, so do not infer a failure from a missing worker record or transcript. Pass the opaque nextCursor unmodified with the same target and order; on paginationStatus invalid_cursor, restart from the first page.',
    inputSchema: {
      type: 'object',
      properties: {
        issueUrl: {
          type: 'string',
          description: 'Exact GitHub Issue URL from list_operator_sessions.',
        },
        conductorAgentId: {
          type: 'string',
          description: 'Exact run id from list_operator_sessions.',
        },
        worker: {
          type: 'string',
          description: 'Saved worker name from the selected session.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Maximum messages to return (default ${DEFAULT_LIMIT}).`,
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Transcript order; defaults to newest first.',
        },
        cursor: {
          type: 'string',
          description:
            'Opaque nextCursor from this tool, bound to the same Issue, run, worker, order, and history reader.',
        },
        includeSourceFiles: {
          type: 'boolean',
          description: 'Include absolute local transcript paths when true.',
        },
      },
      required: ['issueUrl', 'conductorAgentId', 'worker'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const issueUrl = requireString(args.issueUrl, 'issueUrl');
      const conductorAgentId = requireString(
        args.conductorAgentId,
        'conductorAgentId',
      );
      const worker = requireString(args.worker, 'worker');
      const limit = resolveLimit(args.limit);
      const order = resolveOrder(args.order);
      const cursor =
        args.cursor === undefined
          ? undefined
          : requireString(args.cursor, 'cursor');
      const includeSourceFiles = resolveIncludeSourceFiles(
        args.includeSourceFiles,
      );

      let history: WorkerSessionHistoryResult;
      try {
        history = await readWorkerSessionHistory({
          ...(typeof location === 'string'
            ? { repoRoot: location }
            : { userEnsembleRoot: location.userEnsembleRoot }),
          issueUrl,
          conductorAgentId,
          workerName: worker,
          ...(includeSourceFiles ? { includeSourceFiles: true } : {}),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (
          !reason.startsWith('No saved session found for ') &&
          !reason.startsWith('No saved worker session found for ')
        ) {
          throw error;
        }
        const result = {
          issueUrl,
          conductorAgentId,
          worker,
          sessionFound: !reason.startsWith('No saved session found for '),
          workerSessionRecorded: false,
          status: 'unavailable' as const,
          reason,
          messages: [],
          total: 0,
          returned: 0,
          hasMore: false,
        };
        return toToolResult(result);
      }

      const ordered =
        order === 'desc' ? [...history.messages].reverse() : history.messages;
      let cursorIndex = -1;
      if (cursor) {
        const decoded = decodeWorkerMessagesCursor(cursor);
        if (!decoded) {
          return invalidCursorResult(
            history,
            issueUrl,
            conductorAgentId,
            worker,
            'Cursor is malformed or uses an unsupported version. Request the first page without a cursor.',
          );
        }
        if (
          decoded.issueUrl !== issueUrl ||
          decoded.conductorAgentId !== conductorAgentId ||
          decoded.worker !== worker ||
          decoded.order !== order ||
          decoded.preset !== history.preset ||
          decoded.reader !== (history.reader ?? null)
        ) {
          return invalidCursorResult(
            history,
            issueUrl,
            conductorAgentId,
            worker,
            'Cursor belongs to a different Issue, run, worker, order, or history reader. Request the first page for this selection.',
          );
        }
        cursorIndex = decoded.position;
        if (
          !Number.isSafeInteger(cursorIndex) ||
          cursorIndex < 0 ||
          ordered[cursorIndex]?.providerId !== decoded.providerId
        ) {
          return invalidCursorResult(
            history,
            issueUrl,
            conductorAgentId,
            worker,
            'Cursor boundary no longer matches this saved transcript. Request the first page again.',
          );
        }
      }
      const remaining = ordered.slice(cursorIndex + 1);
      const messages = remaining.slice(0, limit);
      const hasMore = remaining.length > messages.length;
      const result = {
        ...history,
        issueUrl,
        sessionFound: true,
        workerSessionRecorded: true,
        total: history.messages.length,
        returned: messages.length,
        ...(hasMore
          ? {
              nextCursor: encodeWorkerMessagesCursor({
                version: WORKER_MESSAGES_CURSOR_VERSION,
                issueUrl,
                conductorAgentId,
                worker,
                order,
                preset: history.preset,
                reader: history.reader ?? null,
                position: cursorIndex + messages.length,
                providerId: messages.at(-1)!.providerId,
              }),
            }
          : {}),
        hasMore,
        messages,
      };
      return toToolResult(result);
    },
  };
}

function invalidCursorResult(
  history: WorkerSessionHistoryResult,
  issueUrl: string,
  conductorAgentId: string,
  worker: string,
  paginationReason: string,
): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, ConductorJsonValue>;
} {
  return toToolResult({
    ...history,
    issueUrl,
    sessionFound: true,
    workerSessionRecorded: true,
    total: history.messages.length,
    returned: 0,
    hasMore: false,
    messages: [],
    paginationStatus: 'invalid_cursor',
    paginationReason,
    conductorAgentId,
    worker,
  });
}

function encodeWorkerMessagesCursor(cursor: WorkerMessagesCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeWorkerMessagesCursor(
  value: string,
): WorkerMessagesCursor | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const cursor = parsed as Record<string, unknown>;
    if (
      cursor.version !== WORKER_MESSAGES_CURSOR_VERSION ||
      typeof cursor.issueUrl !== 'string' ||
      typeof cursor.conductorAgentId !== 'string' ||
      typeof cursor.worker !== 'string' ||
      (cursor.order !== 'asc' && cursor.order !== 'desc') ||
      (cursor.preset !== null && typeof cursor.preset !== 'string') ||
      (cursor.reader !== null && typeof cursor.reader !== 'string') ||
      typeof cursor.position !== 'number' ||
      !Number.isSafeInteger(cursor.position) ||
      typeof cursor.providerId !== 'string'
    ) {
      return undefined;
    }
    return {
      version: WORKER_MESSAGES_CURSOR_VERSION,
      issueUrl: cursor.issueUrl,
      conductorAgentId: cursor.conductorAgentId,
      worker: cursor.worker,
      order: cursor.order,
      preset: cursor.preset,
      reader: cursor.reader,
      position: cursor.position,
      providerId: cursor.providerId,
    };
  } catch {
    return undefined;
  }
}

function toToolResult(value: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, ConductorJsonValue>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, ConductorJsonValue>,
  };
}

function requireString(
  value: ConductorJsonValue | undefined,
  name: string,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function resolveLimit(value: ConductorJsonValue | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_LIMIT
  ) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  return value;
}

function resolveOrder(
  value: ConductorJsonValue | undefined,
): 'asc' | 'desc' {
  if (value === undefined) return 'desc';
  if (value === 'asc' || value === 'desc') return value;
  throw new Error('order must be asc or desc.');
}

function resolveIncludeSourceFiles(
  value: ConductorJsonValue | undefined,
): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new Error('includeSourceFiles must be a boolean.');
  }
  return value;
}
