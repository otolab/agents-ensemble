import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  listSessionResumeStores,
  loadOpenQuestionsStore,
  loadSessionStateStore,
  openQuestionsStorePath,
  OPEN_QUESTION_CONTROL_METHODS,
  OpenQuestionControlRemoteError,
  OpenQuestionControlTransportError,
  sendOpenQuestionControlRequest,
  sessionStateStorePath,
  type OpenQuestionControlConductorMessage,
  type ConductorJsonValue,
  type ConductorTool,
  type SessionObservationSnapshot,
  type SessionResumeStore,
} from '@agents-ensemble/core/operator-runtime';
import type {
  OperatorDispatchEvent,
  OperatorDispatchQueue,
} from './operator-dispatch.js';

const WATCH_STATE_VERSION = 1;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 60_000;
const MAX_DEBOUNCE_MS = 10_000;
const DEFAULT_MESSAGE_DEBOUNCE_MS = 10_000;
const MAX_MESSAGE_DEBOUNCE_MS = 120_000;
const MESSAGE_POLL_INTERVAL_MS = 2_000;

interface WatchConfig {
  conductorAgentId: string;
  pollIntervalMs: number;
  debounceMs: number;
}

interface SessionCursor {
  sequence: number;
  questionFingerprints: Record<string, string>;
  statusFingerprints: Record<string, string>;
}

export interface ConductorMessageListenConfig {
  conductorAgentId: string;
  messageDebounceMs: number;
}

interface OperatorWatchState {
  version: typeof WATCH_STATE_VERSION;
  watches: Record<string, WatchConfig>;
  cursors: Record<string, SessionCursor>;
  messageListeners: Record<string, ConductorMessageListenConfig>;
  messageCursors: Record<string, number>;
  pendingReports: Array<{
    reportId: string;
    reportType: 'session_state' | 'open_question' | 'conductor_message';
    conductorAgentId: string;
    issueUrl: string;
    text: string;
    debounceMs: number;
    sendCount?: number;
  }>;
}

export interface OperatorWatchPool {
  register(
    conductorAgentId: string,
    options?: { pollIntervalMs?: number; debounceMs?: number },
  ): Promise<WatchConfig>;
  unregister(conductorAgentId: string): Promise<boolean>;
  list(): WatchConfig[];
  registerConductorMessageListen(
    conductorAgentId: string,
    options?: { messageDebounceMs?: number },
  ): Promise<ConductorMessageListenConfig>;
  unregisterConductorMessageListen(conductorAgentId: string): Promise<boolean>;
  listConductorMessageListens(): ConductorMessageListenConfig[];
  pollOnce(conductorAgentId: string): Promise<number>;
  pollConductorMessagesOnce(conductorAgentId: string): Promise<number>;
  acknowledge(events: readonly OperatorDispatchEvent[]): Promise<void>;
  close(): void;
}

export interface CreateOperatorWatchPoolOptions {
  repoRoot: string;
  dispatchQueue: OperatorDispatchQueue;
  onError?: (message: string) => void;
}

export function operatorWatchStatePath(repoRoot: string): string {
  return join(repoRoot, '.ensemble', 'operator-agent', 'watch-state.json');
}

export async function createOperatorWatchPool(
  options: CreateOperatorWatchPoolOptions,
): Promise<OperatorWatchPool> {
  const root = options.repoRoot;
  const path = operatorWatchStatePath(root);
  const state = await loadWatchState(path);
  const timers = new Map<string, NodeJS.Timeout>();
  const polling = new Set<string>();
  const messageTimers = new Map<string, NodeJS.Timeout>();
  const messagePolling = new Set<string>();
  let closed = false;
  let persistQueue = Promise.resolve();

  const persist = async () => {
    const next = persistQueue.then(() => saveWatchState(path, state));
    persistQueue = next.catch(() => {});
    await next;
  };
  const startTimer = (watch: WatchConfig) => {
    if (timers.has(watch.conductorAgentId)) return;
    const timer = setInterval(() => {
      void pool.pollOnce(watch.conductorAgentId).catch((error: unknown) => {
        options.onError?.(formatWatchPollError(watch.conductorAgentId, error));
      });
    }, watch.pollIntervalMs);
    timer.unref();
    timers.set(watch.conductorAgentId, timer);
  };
  const startMessageTimer = (listener: ConductorMessageListenConfig) => {
    if (messageTimers.has(listener.conductorAgentId)) return;
    const timer = setInterval(() => {
      void pool
        .pollConductorMessagesOnce(listener.conductorAgentId)
        .catch((error: unknown) => {
          options.onError?.(
            formatConductorMessagePollError(listener.conductorAgentId, error),
          );
        });
    }, MESSAGE_POLL_INTERVAL_MS);
    timer.unref();
    messageTimers.set(listener.conductorAgentId, timer);
  };
  const pool: OperatorWatchPool = {
    async register(conductorAgentId, input = {}) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      const resumeStore = (await listSessionResumeStores(root)).find(
        (candidate) => candidate.conductorAgentId === id,
      );
      if (!resumeStore) throw new Error(`No saved session found for ${id}.`);
      const watch = {
        conductorAgentId: id,
        pollIntervalMs: parseBoundedInteger(
          input.pollIntervalMs,
          DEFAULT_POLL_INTERVAL_MS,
          MIN_POLL_INTERVAL_MS,
          MAX_POLL_INTERVAL_MS,
          'pollIntervalMs',
        ),
        debounceMs: parseBoundedInteger(
          input.debounceMs,
          250,
          0,
          MAX_DEBOUNCE_MS,
          'debounceMs',
        ),
      };
      const previousWatch = state.watches[id];
      state.watches[id] = watch;
      try {
        await persist();
      } catch (error) {
        if (previousWatch) state.watches[id] = previousWatch;
        else delete state.watches[id];
        throw error;
      }
      const existingTimer = timers.get(id);
      if (existingTimer) clearInterval(existingTimer);
      timers.delete(id);
      startTimer(watch);
      return watch;
    },
    async unregister(conductorAgentId) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      const previousWatch = state.watches[id];
      if (!previousWatch) return false;
      delete state.watches[id];
      try {
        await persist();
      } catch (error) {
        state.watches[id] = previousWatch;
        throw error;
      }
      const timer = timers.get(id);
      if (timer) clearInterval(timer);
      timers.delete(id);
      return true;
    },
    list() {
      return Object.values(state.watches).map((watch) => ({ ...watch }));
    },
    async registerConductorMessageListen(conductorAgentId, input = {}) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      const resumeStore = (await listSessionResumeStores(root)).find(
        (candidate) => candidate.conductorAgentId === id,
      );
      if (!resumeStore) throw new Error(`No saved session found for ${id}.`);
      const listener = {
        conductorAgentId: id,
        messageDebounceMs: parseBoundedInteger(
          input.messageDebounceMs,
          DEFAULT_MESSAGE_DEBOUNCE_MS,
          0,
          MAX_MESSAGE_DEBOUNCE_MS,
          'messageDebounceMs',
        ),
      };
      const previous = state.messageListeners[id];
      state.messageListeners[id] = listener;
      try {
        await persist();
      } catch (error) {
        if (previous) state.messageListeners[id] = previous;
        else delete state.messageListeners[id];
        throw error;
      }
      const existingTimer = messageTimers.get(id);
      if (existingTimer) clearInterval(existingTimer);
      messageTimers.delete(id);
      startMessageTimer(listener);
      await pool.pollConductorMessagesOnce(id);
      return listener;
    },
    async unregisterConductorMessageListen(conductorAgentId) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      const previous = state.messageListeners[id];
      if (!previous) return false;
      delete state.messageListeners[id];
      const previousCursor = state.messageCursors[id];
      delete state.messageCursors[id];
      try {
        await persist();
      } catch (error) {
        state.messageListeners[id] = previous;
        if (previousCursor !== undefined) state.messageCursors[id] = previousCursor;
        throw error;
      }
      const timer = messageTimers.get(id);
      if (timer) clearInterval(timer);
      messageTimers.delete(id);
      return true;
    },
    listConductorMessageListens() {
      return Object.values(state.messageListeners).map((listener) => ({
        ...listener,
      }));
    },
    async pollOnce(conductorAgentId) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      const watch = state.watches[id];
      if (!watch || closed || polling.has(id)) return 0;
      polling.add(id);
      try {
        const resumeStore = (await listSessionResumeStores(root)).find(
          (candidate) => candidate.conductorAgentId === id,
        );
        if (!resumeStore) return 0;
        const { snapshot: observation, source } = await readObservation(root, resumeStore);
        const previous = state.cursors[id];
        const next = cursorFor(observation);
        const reports = collectReports(resumeStore, observation, previous, source)
          .map((report) => ({
            ...report,
            reportId: randomUUID(),
            conductorAgentId: id,
            issueUrl: resumeStore.issueUrl,
            debounceMs: watch.debounceMs,
          }));
        const cursorChanged = hash(previous ?? null) !== hash(next);
        if (reports.length > 0) state.pendingReports.push(...reports);
        state.cursors[id] = next;
        let persistFailed = false;
        let persistenceError: unknown;
        if (reports.length > 0 || cursorChanged) {
          try {
            await persist();
          } catch (error) {
            persistFailed = true;
            persistenceError = error;
          }
        }
        options.dispatchQueue.enqueueReports(
          reports.map((report) => ({
            type: 'report',
            reportId: report.reportId,
            reportType: report.reportType,
            conductorAgentId: id,
            issueUrl: resumeStore.issueUrl,
            text: report.text,
          })),
          watch.debounceMs,
        );
        if (persistFailed) throw persistenceError;
        return reports.length;
      } finally {
        polling.delete(id);
      }
    },
    async pollConductorMessagesOnce(conductorAgentId) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      const listener = state.messageListeners[id];
      if (!listener || closed || messagePolling.has(id)) return 0;
      messagePolling.add(id);
      try {
        const resumeStore = (await listSessionResumeStores(root)).find(
          (candidate) => candidate.conductorAgentId === id,
        );
        if (!resumeStore?.harnessSocketPath) return 0;
        const cursor = state.messageCursors[id];
        if (cursor === undefined) {
          const baseline = await readConductorMessages(
            resumeStore.harnessSocketPath,
            { limit: 1, order: 'desc' },
          );
          state.messageCursors[id] = baseline.messages[0]?.sendCount ?? 0;
          await persist();
          return 0;
        }
        const page = await readConductorMessages(resumeStore.harnessSocketPath, {
          limit: 100,
          order: 'asc',
          after: cursor,
        });
        const messages = page.messages
          .filter((message) => message.sendCount > cursor)
          .sort((left, right) => left.sendCount - right.sendCount);
        const nextCursor = messages.at(-1)?.sendCount ?? cursor;
        const reports = messages.map((message) => ({
          reportId: randomUUID(),
          reportType: 'conductor_message' as const,
          conductorAgentId: id,
          issueUrl: resumeStore.issueUrl,
          text: formatConductorMessageReport(resumeStore, message),
          debounceMs: listener.messageDebounceMs,
          sendCount: message.sendCount,
        }));
        state.messageCursors[id] = nextCursor;
        if (reports.length > 0) state.pendingReports.push(...reports);
        let persistFailed = false;
        let persistenceError: unknown;
        if (reports.length > 0 || nextCursor !== cursor) {
          try {
            await persist();
          } catch (error) {
            persistFailed = true;
            persistenceError = error;
          }
        }
        options.dispatchQueue.enqueueDebouncedReports(
          reports.map((report) => ({
            type: 'report',
            reportId: report.reportId,
            reportType: report.reportType,
            conductorAgentId: id,
            issueUrl: resumeStore.issueUrl,
            text: report.text,
            sendCount: report.sendCount,
          })),
          listener.messageDebounceMs,
        );
        if (persistFailed) throw persistenceError;
        return reports.length;
      } finally {
        messagePolling.delete(id);
      }
    },
    async acknowledge(events) {
      const acknowledged = new Set(
        events.flatMap((event) =>
          event.type === 'report' && event.reportId ? [event.reportId] : [],
        ),
      );
      if (acknowledged.size === 0) return;
      const remaining = state.pendingReports.filter(
        (report) => !acknowledged.has(report.reportId),
      );
      if (remaining.length === state.pendingReports.length) return;
      state.pendingReports = remaining;
      await persist();
    },
    close() {
      closed = true;
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
      for (const timer of messageTimers.values()) clearInterval(timer);
      messageTimers.clear();
    },
  };

  for (const report of state.pendingReports) {
    options.dispatchQueue.enqueueReports(
      [{
        type: 'report',
        reportId: report.reportId,
        reportType: report.reportType,
        conductorAgentId: report.conductorAgentId,
        issueUrl: report.issueUrl,
        text: report.text,
      }],
      0,
    );
  }
  for (const watch of pool.list()) startTimer(watch);
  for (const listener of pool.listConductorMessageListens()) {
    startMessageTimer(listener);
  }
  return pool;
}

export function createRegisterSessionWatchTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'register_session_watch',
    description:
      'Add a saved Issue session to the operator watch pool. Polling uses the live harness UDS when available and the saved SessionResumeStore/YAML when it is offline.',
    inputSchema: {
      type: 'object',
      properties: {
        conductorAgentId: { type: 'string' },
        pollIntervalMs: {
          type: 'integer',
          minimum: MIN_POLL_INTERVAL_MS,
          maximum: MAX_POLL_INTERVAL_MS,
          description: 'Per-session polling interval in milliseconds (default 2000).',
        },
        debounceMs: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_DEBOUNCE_MS,
          description: 'Wait after an observation so nearby reports can be batched (default 250).',
        },
      },
      required: ['conductorAgentId'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const watch = await pool.register(
        requireToolString(args.conductorAgentId, 'conductorAgentId'),
        {
          pollIntervalMs: optionalNumber(args.pollIntervalMs, 'pollIntervalMs'),
          debounceMs: optionalNumber(args.debounceMs, 'debounceMs'),
        },
      );
      return toolResult(watch as unknown as ConductorJsonValue);
    },
  };
}

export function createUnregisterSessionWatchTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'unregister_session_watch',
    description: 'Remove an Issue session from the operator watch pool.',
    inputSchema: {
      type: 'object',
      properties: { conductorAgentId: { type: 'string' } },
      required: ['conductorAgentId'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const conductorAgentId = requireToolString(
        args.conductorAgentId,
        'conductorAgentId',
      );
      const removed = await pool.unregister(conductorAgentId);
      return toolResult({ conductorAgentId, removed });
    },
  };
}

export function createRegisterConductorMessageListenTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'register_conductor_message_listen',
    description:
      'Listen for new successful conductor responses from a running Issue session. The first live poll establishes a baseline; subsequent messages are polled over UDS and debounced into one report. No offline fallback is used.',
    inputSchema: {
      type: 'object',
      properties: {
        conductorAgentId: { type: 'string' },
        messageDebounceMs: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_MESSAGE_DEBOUNCE_MS,
          description:
            'Quiet period in milliseconds before nearby conductor responses are reported (default 10000).',
        },
      },
      required: ['conductorAgentId'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const listener = await pool.registerConductorMessageListen(
        requireToolString(args.conductorAgentId, 'conductorAgentId'),
        {
          messageDebounceMs: optionalNumber(
            args.messageDebounceMs,
            'messageDebounceMs',
          ),
        },
      );
      return toolResult(listener as unknown as ConductorJsonValue);
    },
  };
}

export function createUnregisterConductorMessageListenTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'unregister_conductor_message_listen',
    description: 'Stop listening for conductor responses from an Issue session.',
    inputSchema: {
      type: 'object',
      properties: { conductorAgentId: { type: 'string' } },
      required: ['conductorAgentId'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const conductorAgentId = requireToolString(
        args.conductorAgentId,
        'conductorAgentId',
      );
      const removed = await pool.unregisterConductorMessageListen(
        conductorAgentId,
      );
      return toolResult({ conductorAgentId, removed });
    },
  };
}

async function readConductorMessages(
  socketPath: string,
  params: {
    limit: number;
    order: 'asc' | 'desc';
    after?: number;
  },
): Promise<{
  messages: OpenQuestionControlConductorMessage[];
  hasMore: boolean;
}> {
  return sendOpenQuestionControlRequest(socketPath, {
    method: OPEN_QUESTION_CONTROL_METHODS.conductorMessagesList,
    params,
  });
}

function formatConductorMessageReport(
  resumeStore: SessionResumeStore,
  message: OpenQuestionControlConductorMessage,
): string {
  return [
    `対象: ${resumeStore.issueUrl} (${resumeStore.conductorAgentId})`,
    `sendCount: ${message.sendCount}`,
    `at: ${new Date(message.at).toISOString()}`,
    ...(message.dispatchSource
      ? [`dispatchSource: ${message.dispatchSource}`]
      : []),
    '',
    '#### inbound',
    '',
    message.inbound,
    '',
    '#### response',
    '',
    message.text,
  ].join('\n');
}

async function readObservation(
  repoRoot: string,
  resumeStore: SessionResumeStore,
): Promise<{
  snapshot: SessionObservationSnapshot;
  source: 'uds' | 'resume_store';
}> {
  if (resumeStore.harnessSocketPath) {
    try {
      return {
        snapshot: await sendOpenQuestionControlRequest<SessionObservationSnapshot>(
          resumeStore.harnessSocketPath,
          { method: OPEN_QUESTION_CONTROL_METHODS.observe },
        ),
        source: 'uds',
      };
    } catch (error) {
      if (
        !(error instanceof OpenQuestionControlTransportError) &&
        !(
          error instanceof OpenQuestionControlRemoteError &&
          error.rpcCode === -32601
        )
      ) {
        throw error;
      }
      // A recorded socket path is only an index. When it is stale/unreachable,
      // or an older server does not implement snapshots, mark persisted data
      // as the observation source instead of presenting it as live.
    }
  }
  const questions = await loadOpenQuestionsStore(
    openQuestionsStorePath({ repoRoot, conductorAgentId: resumeStore.conductorAgentId }),
  );
  const sessionState = await loadSessionStateStore(
    sessionStateStorePath({ repoRoot, conductorAgentId: resumeStore.conductorAgentId }),
  );
  return {
    snapshot: {
      sequence: questions?.sequence ?? resumeStore.sequence,
      openQuestions: questions?.openQuestions ?? resumeStore.openQuestions,
      ...(sessionState ? { sessionState } : {}),
    },
    source: 'resume_store',
  };
}

function collectReports(
  resumeStore: SessionResumeStore,
  observation: SessionObservationSnapshot,
  previous: SessionCursor | undefined,
  source: 'uds' | 'resume_store',
): Array<{ reportType: 'session_state' | 'open_question'; text: string }> {
  const reports: Array<{
    reportType: 'session_state' | 'open_question';
    text: string;
  }> = [];
  const issue = `${resumeStore.issueUrl} (${resumeStore.conductorAgentId})`;
  const observationSource =
    source === 'uds' ? '稼働中 UDS' : '保存済み SessionResumeStore / YAML';
  for (const question of observation.openQuestions) {
    if (
      !previous ||
      question.status !== 'open' ||
      previous.questionFingerprints[question.id] !== undefined
    ) {
      continue;
    }
    reports.push({
      reportType: 'open_question',
      text: [
        `対象: ${issue} / 観測元: ${observationSource}`,
        `新規追加: ${question.id} / ${question.responseType}`,
        question.question,
        ...(question.context ? [`context: ${question.context}`] : []),
      ].join('\n'),
    });
  }

  const statusEntries = observation.sessionState
    ? [...observation.sessionState.history, observation.sessionState.current]
    : [];
  const changedStatuses = statusEntries.filter((status) => {
    const fingerprint = hash(status);
    return previous?.statusFingerprints[String(status.reportedAt)] !== fingerprint;
  });
  const firstPoll = !previous;
  const selectedStatuses = firstPoll ? changedStatuses.slice(-1) : changedStatuses;
  for (const status of selectedStatuses) {
    reports.push({
      reportType: 'session_state',
      text: [
        `対象: ${issue} / 観測元: ${observationSource}`,
        `状態 (${new Date(status.reportedAt).toISOString()}): ${status.statusLine}`,
      ].join('\n'),
    });
  }
  return reports;
}

function cursorFor(observation: SessionObservationSnapshot): SessionCursor {
  const questionFingerprints: Record<string, string> = {};
  for (const question of observation.openQuestions) {
    questionFingerprints[question.id] = hash(question);
  }
  const statusFingerprints: Record<string, string> = {};
  if (observation.sessionState) {
    for (const status of [
      ...observation.sessionState.history,
      observation.sessionState.current,
    ]) {
      statusFingerprints[String(status.reportedAt)] = hash(status);
    }
  }
  return {
    sequence: observation.sequence,
    questionFingerprints,
    statusFingerprints,
  };
}

async function loadWatchState(path: string): Promise<OperatorWatchState> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(value) || value.version !== WATCH_STATE_VERSION) {
      throw new Error('Invalid operator-agent watch state.');
    }
    const watches: Record<string, WatchConfig> = {};
    if (!isRecord(value.watches)) {
      throw new Error('Invalid operator-agent watch state: watches.');
    }
    for (const [id, rawWatch] of Object.entries(value.watches)) {
      if (
        !isRecord(rawWatch) ||
        rawWatch.conductorAgentId !== id ||
        typeof rawWatch.pollIntervalMs !== 'number' ||
        typeof rawWatch.debounceMs !== 'number'
      ) {
        throw new Error(`Invalid operator-agent watch state: watch ${id}.`);
      }
      watches[id] = {
        conductorAgentId: id,
        pollIntervalMs: parseBoundedInteger(
          rawWatch.pollIntervalMs,
          DEFAULT_POLL_INTERVAL_MS,
          MIN_POLL_INTERVAL_MS,
          MAX_POLL_INTERVAL_MS,
          'pollIntervalMs',
        ),
        debounceMs: parseBoundedInteger(
          rawWatch.debounceMs,
          250,
          0,
          MAX_DEBOUNCE_MS,
          'debounceMs',
        ),
      };
    }
    if (!isRecord(value.cursors)) {
      throw new Error('Invalid operator-agent watch state: cursors.');
    }
    const cursors: Record<string, SessionCursor> = {};
    for (const [id, rawCursor] of Object.entries(value.cursors)) {
      if (
        !isRecord(rawCursor) ||
        !Number.isSafeInteger(rawCursor.sequence) ||
        (rawCursor.sequence as number) < 0 ||
        !isStringRecord(rawCursor.questionFingerprints) ||
        !isStringRecord(rawCursor.statusFingerprints)
      ) {
        throw new Error(`Invalid operator-agent watch state: cursor ${id}.`);
      }
      cursors[id] = rawCursor as unknown as SessionCursor;
    }
    const rawListeners = value.messageListeners ?? {};
    if (!isRecord(rawListeners)) {
      throw new Error('Invalid operator-agent watch state: messageListeners.');
    }
    const messageListeners: Record<string, ConductorMessageListenConfig> = {};
    for (const [id, rawListener] of Object.entries(rawListeners)) {
      if (
        !isRecord(rawListener) ||
        rawListener.conductorAgentId !== id ||
        typeof rawListener.messageDebounceMs !== 'number'
      ) {
        throw new Error(
          `Invalid operator-agent watch state: message listener ${id}.`,
        );
      }
      messageListeners[id] = {
        conductorAgentId: id,
        messageDebounceMs: parseBoundedInteger(
          rawListener.messageDebounceMs,
          DEFAULT_MESSAGE_DEBOUNCE_MS,
          0,
          MAX_MESSAGE_DEBOUNCE_MS,
          'messageDebounceMs',
        ),
      };
    }
    const rawMessageCursors = value.messageCursors ?? {};
    if (!isRecord(rawMessageCursors)) {
      throw new Error('Invalid operator-agent watch state: messageCursors.');
    }
    const messageCursors: Record<string, number> = {};
    for (const [id, cursor] of Object.entries(rawMessageCursors)) {
      if (!Number.isSafeInteger(cursor) || (cursor as number) < 0) {
        throw new Error(
          `Invalid operator-agent watch state: message cursor ${id}.`,
        );
      }
      messageCursors[id] = cursor as number;
    }
    const pendingReports = value.pendingReports;
    if (!Array.isArray(pendingReports)) {
      throw new Error('Invalid operator-agent watch state: pendingReports.');
    }
    const reportIds = new Set<string>();
    for (const report of pendingReports) {
      if (
        !isRecord(report) ||
        typeof report.reportId !== 'string' ||
        report.reportId.trim().length === 0 ||
        typeof report.conductorAgentId !== 'string' ||
        typeof report.issueUrl !== 'string' ||
        typeof report.text !== 'string' ||
        (report.reportType !== 'session_state' &&
          report.reportType !== 'open_question' &&
          report.reportType !== 'conductor_message') ||
        typeof report.debounceMs !== 'number'
      ) {
        throw new Error('Invalid operator-agent watch state: pending report.');
      }
      if (
        report.reportType === 'conductor_message' &&
        (!Number.isSafeInteger(report.sendCount) ||
          (report.sendCount as number) < 0)
      ) {
        throw new Error(
          'Invalid operator-agent watch state: pending conductor message report.',
        );
      }
      if (reportIds.has(report.reportId)) {
        throw new Error(
          'Invalid operator-agent watch state: duplicate pending reportId.',
        );
      }
      reportIds.add(report.reportId);
      if (
        !Number.isInteger(report.debounceMs) ||
        report.debounceMs < 0 ||
        report.debounceMs >
          (report.reportType === 'conductor_message'
            ? MAX_MESSAGE_DEBOUNCE_MS
            : MAX_DEBOUNCE_MS)
      ) {
        throw new Error(
          'Invalid operator-agent watch state: pending report debounceMs.',
        );
      }
    }
    return {
      version: WATCH_STATE_VERSION,
      watches,
      cursors,
      messageListeners,
      messageCursors,
      pendingReports: pendingReports as OperatorWatchState['pendingReports'],
    };
  } catch (error) {
    if (isEnoent(error)) {
      return {
        version: WATCH_STATE_VERSION,
        watches: {},
        cursors: {},
        messageListeners: {},
        messageCursors: {},
        pendingReports: [],
      };
    }
    throw error;
  }
}

async function saveWatchState(
  path: string,
  state: OperatorWatchState,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function toolResult(value: ConductorJsonValue): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, ConductorJsonValue>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent:
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : { value },
  };
}

function parseBoundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function optionalNumber(
  value: ConductorJsonValue | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new Error(`${name} must be an integer.`);
  return value;
}

function requireToolString(
  value: ConductorJsonValue | undefined,
  name: string,
): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  return requireNonEmptyString(value, name);
}

function requireNonEmptyString(value: string, name: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${name} must not be empty.`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function formatWatchPollError(conductorAgentId: string, error: unknown): string {
  const errorType =
    error instanceof Error && error.name ? error.name : 'unknown error';
  return `Failed to poll watched session ${conductorAgentId} (${errorType}).`;
}

function formatConductorMessagePollError(
  conductorAgentId: string,
  error: unknown,
): string {
  const errorType =
    error instanceof Error && error.name ? error.name : 'unknown error';
  return `Failed to poll conductor messages for session ${conductorAgentId} (${errorType}).`;
}
