import { Agent, type Run } from '@cursor/sdk';
import {
  SessionManager,
  type SessionMessageEntry,
} from '@earendil-works/pi-coding-agent';
import type { ConductorBackend } from '../config/types.js';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import { PI_CONDUCTOR_MESSAGE_HISTORY_ENTRY_TYPE } from './pi-conductor-agent.js';

export const CONDUCTOR_PROVIDER_HISTORY_LIMIT = 100;

export interface ConductorProviderHistoryMessage {
  backend: ConductorBackend;
  providerId: string;
  requestId?: string;
  at?: number;
  text: string;
  inbound: string;
  sendCount?: number;
  dispatchSource?: string;
}

export interface ConductorProviderHistoryQuery {
  limit: number;
  order: 'asc' | 'desc';
  cursor?: string;
}

export interface ConductorProviderHistoryResult {
  messages: ConductorProviderHistoryMessage[];
  hasMore: boolean;
}

/** Free-text fields in each returned provider-history message. */
export type ConductorProviderHistoryTextField = 'inbound' | 'text';

/**
 * Caller-provided transformation for provider-history free text.
 * It does not guarantee that secrets are detected or removed.
 */
export type ConductorProviderHistorySanitizer = (
  value: string,
  field: ConductorProviderHistoryTextField,
) => string | Promise<string>;

/** Read the latest eligible user/final-response pairs from a provider session. */
export async function listConductorProviderHistory(input: {
  backend: ConductorBackend;
  conductorAgentId: string;
  cwd: string;
  /** Repository root for Pi's user-level transcript path; defaults to cwd. */
  repoRoot?: string;
  cursorBootstrapRunId?: string;
  query: ConductorProviderHistoryQuery;
  /** Optional post-page text transformation; omitted to preserve raw values. */
  sanitizer?: ConductorProviderHistorySanitizer;
}): Promise<ConductorProviderHistoryResult> {
  let history: ConductorProviderHistoryMessage[];
  try {
    history =
      input.backend === 'cursor'
        ? await readCursorConductorHistory(input)
        : readPiConductorHistory(input);
  } catch {
    throw new Error(
      `Provider history is unavailable for conductor session ${input.conductorAgentId} (${input.backend}).`,
    );
  }
  const ordered =
    input.query.order === 'desc' ? [...history].reverse() : history;
  let matching = ordered;
  if (input.query.cursor !== undefined) {
    const cursorIndex = ordered.findIndex(
      (message) => message.providerId === input.query.cursor,
    );
    if (cursorIndex < 0) {
      throw new Error(
        `The provider history cursor is unavailable for conductor session ${input.conductorAgentId} (${input.backend}).`,
      );
    }
    matching = ordered.slice(cursorIndex + 1);
  }
  const messages = matching.slice(0, input.query.limit);
  return {
    messages:
      input.sanitizer === undefined
        ? messages
        : await sanitizeProviderHistoryMessages(
            messages,
            input.sanitizer,
            input.conductorAgentId,
            input.backend,
          ),
    hasMore: matching.length > input.query.limit,
  };
}

async function sanitizeProviderHistoryMessages(
  messages: ConductorProviderHistoryMessage[],
  sanitizer: ConductorProviderHistorySanitizer,
  conductorAgentId: string,
  backend: ConductorBackend,
): Promise<ConductorProviderHistoryMessage[]> {
  const sanitized: ConductorProviderHistoryMessage[] = [];
  try {
    if (typeof sanitizer !== 'function') {
      throw new Error('The provider history sanitizer is not a function.');
    }
    for (const message of messages) {
      const inbound = await sanitizer(message.inbound, 'inbound');
      if (typeof inbound !== 'string') {
        throw new Error(
          'The provider history sanitizer returned a non-string value.',
        );
      }
      const text = await sanitizer(message.text, 'text');
      if (typeof text !== 'string') {
        throw new Error(
          'The provider history sanitizer returned a non-string value.',
        );
      }
      sanitized.push({ ...message, inbound, text });
    }
  } catch {
    throw new Error(
      `Provider history sanitizer failed for conductor session ${conductorAgentId} (${backend}).`,
    );
  }
  return sanitized;
}

function readPiConductorHistory(input: {
  conductorAgentId: string;
  cwd: string;
  repoRoot?: string;
}): ConductorProviderHistoryMessage[] {
  const cwd = input.cwd;
  const paths = resolveEnsemblePaths({ repoRoot: input.repoRoot ?? cwd });
  let sessionFile: string | undefined;
  let sessionDir: string | undefined;
  for (const candidateDir of new Set([
    paths.piSessionsDir,
    paths.legacyPiSessionsDirForCwd(cwd),
  ])) {
    sessionFile = SessionManager.findById(
      cwd,
      input.conductorAgentId,
      candidateDir,
    );
    if (sessionFile) {
      sessionDir = candidateDir;
      break;
    }
  }
  if (!sessionFile || !sessionDir) {
    throw new Error('The Pi provider session is missing or unreadable.');
  }

  let session: SessionManager;
  try {
    session = SessionManager.open(sessionFile, sessionDir, cwd);
  } catch {
    throw new Error('The Pi provider session could not be read.');
  }
  const branch = session.getBranch();
  const entriesById = new Map(branch.map((entry) => [entry.id, entry]));
  const history: ConductorProviderHistoryMessage[] = [];
  const seenProviderIds = new Set<string>();

  for (const entry of branch) {
    if (
      entry.type !== 'custom' ||
      entry.customType !== PI_CONDUCTOR_MESSAGE_HISTORY_ENTRY_TYPE
    ) {
      continue;
    }
    const metadata = parsePiHistoryMetadata(entry.data);
    if (seenProviderIds.has(metadata.responseEntryId)) {
      throw new Error('The Pi provider session contains duplicate history metadata.');
    }
    seenProviderIds.add(metadata.responseEntryId);

    const inboundEntry = entriesById.get(metadata.inboundEntryId);
    const responseEntry = entriesById.get(metadata.responseEntryId);
    if (
      !isSessionMessageEntry(inboundEntry) ||
      inboundEntry.message.role !== 'user' ||
      !isSessionMessageEntry(responseEntry) ||
      responseEntry.message.role !== 'assistant'
    ) {
      throw new Error('The Pi provider session history references a missing message.');
    }

    const inbound = piMessageText(inboundEntry);
    const text = piMessageText(responseEntry).trim();
    if (!inbound.trim() || !text) {
      throw new Error('The Pi provider session history references an empty message.');
    }
    history.push({
      backend: 'pi',
      providerId: metadata.responseEntryId,
      at: metadata.completedAt,
      text,
      inbound,
      sendCount: metadata.sendCount,
      ...(metadata.dispatchSource
        ? { dispatchSource: metadata.dispatchSource }
        : {}),
    });
  }

  return history.slice(-CONDUCTOR_PROVIDER_HISTORY_LIMIT);
}

async function readCursorConductorHistory(input: {
  conductorAgentId: string;
  cwd: string;
  cursorBootstrapRunId?: string;
}): Promise<ConductorProviderHistoryMessage[]> {
  const candidates: Run[] = [];
  let cursor: string | undefined;
  let firstRunId: string | undefined;

  do {
    const page = await Agent.listRuns(input.conductorAgentId, {
      runtime: 'local',
      cwd: input.cwd,
      limit: CONDUCTOR_PROVIDER_HISTORY_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    if (firstRunId === undefined) {
      const firstRun = page.items[0];
      if (!firstRun) {
        throw new Error('The Cursor provider session has no saved runs.');
      }
      firstRunId = firstRun.id;
    }
    for (const run of page.items) {
      const bootstrapRunId = input.cursorBootstrapRunId ?? firstRunId;
      if (
        run.id === bootstrapRunId ||
        run.status !== 'finished' ||
        !run.result?.trim()
      ) {
        continue;
      }
      candidates.push(run);
      if (candidates.length > CONDUCTOR_PROVIDER_HISTORY_LIMIT) {
        candidates.shift();
      }
    }
    cursor = page.nextCursor;
  } while (cursor);

  const messages: ConductorProviderHistoryMessage[] = [];
  const resolvedRuns = await Promise.all(
    candidates.map(async (listedRun) => {
      const run = await Agent.getRun(listedRun.id, {
        runtime: 'local',
        cwd: input.cwd,
      });
      if (run.agentId !== input.conductorAgentId) {
        throw new Error('The Cursor SDK returned a run for a different agent.');
      }
      if (run.status !== 'finished' || !run.result?.trim()) {
        return undefined;
      }
      const conversation = await run.conversation();
      const inbound = conversation
        .filter((turn) => turn.type === 'agentConversationTurn')
        .map((turn) => turn.turn.userMessage?.text)
        .find((text) => typeof text === 'string' && text.trim());
      if (!inbound) {
        throw new Error('The Cursor provider run has no readable user prompt.');
      }
      return {
        backend: 'cursor' as const,
        providerId: run.id,
        ...(run.requestId ? { requestId: run.requestId } : {}),
        ...(typeof run.createdAt === 'number' &&
        Number.isFinite(run.createdAt)
          ? { at: run.createdAt }
          : {}),
        text: run.result.trim(),
        inbound,
      };
    }),
  );
  for (const message of resolvedRuns) {
    if (message) messages.push(message);
  }
  return messages;
}

interface PiHistoryMetadata {
  inboundEntryId: string;
  responseEntryId: string;
  completedAt: number;
  sendCount: number;
  dispatchSource?: string;
}

function parsePiHistoryMetadata(value: unknown): PiHistoryMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The Pi provider session contains invalid history metadata.');
  }
  const metadata = value as Record<string, unknown>;
  if (
    typeof metadata.inboundEntryId !== 'string' ||
    !metadata.inboundEntryId ||
    typeof metadata.responseEntryId !== 'string' ||
    !metadata.responseEntryId ||
    typeof metadata.completedAt !== 'number' ||
    !Number.isFinite(metadata.completedAt) ||
    !Number.isSafeInteger(metadata.sendCount) ||
    (metadata.sendCount as number) < 1 ||
    (metadata.dispatchSource !== undefined &&
      typeof metadata.dispatchSource !== 'string')
  ) {
    throw new Error('The Pi provider session contains invalid history metadata.');
  }
  return {
    inboundEntryId: metadata.inboundEntryId,
    responseEntryId: metadata.responseEntryId,
    completedAt: metadata.completedAt,
    sendCount: metadata.sendCount as number,
    ...(typeof metadata.dispatchSource === 'string'
      ? { dispatchSource: metadata.dispatchSource }
      : {}),
  };
}

function isSessionMessageEntry(
  entry: unknown,
): entry is SessionMessageEntry {
  return (
    Boolean(entry) &&
    typeof entry === 'object' &&
    (entry as SessionMessageEntry).type === 'message'
  );
}

function piMessageText(entry: SessionMessageEntry): string {
  const message = entry.message;
  if (message.role !== 'user' && message.role !== 'assistant') return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('');
}
