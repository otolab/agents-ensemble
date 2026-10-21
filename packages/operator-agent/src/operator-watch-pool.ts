import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  listSessionSidecars,
  loadOpenQuestionsStore,
  loadSessionStateStore,
  openQuestionsStorePath,
  OPEN_QUESTION_CONTROL_METHODS,
  OpenQuestionControlRemoteError,
  OpenQuestionControlTransportError,
  sendOpenQuestionControlRequest,
  sessionStateStorePath,
  type ConductorJsonValue,
  type ConductorTool,
  type SessionObservationSnapshot,
  type SessionSidecar,
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

interface OperatorWatchState {
  version: typeof WATCH_STATE_VERSION;
  watches: Record<string, WatchConfig>;
  cursors: Record<string, SessionCursor>;
  pendingReports: Array<{
    reportId: string;
    reportType: 'session_state' | 'open_question';
    conductorAgentId: string;
    issueUrl: string;
    text: string;
    debounceMs: number;
  }>;
}

export interface OperatorWatchPool {
  register(
    conductorAgentId: string,
    options?: { pollIntervalMs?: number; debounceMs?: number },
  ): Promise<WatchConfig>;
  unregister(conductorAgentId: string): Promise<boolean>;
  list(): WatchConfig[];
  pollOnce(conductorAgentId: string): Promise<number>;
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
  const pool: OperatorWatchPool = {
    async register(conductorAgentId, input = {}) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      const sidecar = (await listSessionSidecars(root)).find(
        (candidate) => candidate.conductorAgentId === id,
      );
      if (!sidecar) throw new Error(`No saved session found for ${id}.`);
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
    async pollOnce(conductorAgentId) {
      const id = requireNonEmptyString(conductorAgentId, 'conductorAgentId');
      const watch = state.watches[id];
      if (!watch || closed || polling.has(id)) return 0;
      polling.add(id);
      try {
        const sidecar = (await listSessionSidecars(root)).find(
          (candidate) => candidate.conductorAgentId === id,
        );
        if (!sidecar) return 0;
        const { snapshot: observation, source } = await readObservation(root, sidecar);
        const previous = state.cursors[id];
        const next = cursorFor(observation);
        const reports = collectReports(sidecar, observation, previous, source)
          .map((report) => ({
            ...report,
            reportId: randomUUID(),
            conductorAgentId: id,
            issueUrl: sidecar.issueUrl,
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
            issueUrl: sidecar.issueUrl,
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
  return pool;
}

export function createRegisterSessionWatchTool(
  pool: OperatorWatchPool,
): ConductorTool {
  return {
    name: 'register_session_watch',
    description:
      'Add a saved Issue session to the operator watch pool. Polling uses the live harness UDS when available and saved YAML/sidecar files while it is offline.',
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

async function readObservation(
  repoRoot: string,
  sidecar: SessionSidecar,
): Promise<{
  snapshot: SessionObservationSnapshot;
  source: 'uds' | 'sidecar';
}> {
  if (sidecar.harnessSocketPath) {
    try {
      return {
        snapshot: await sendOpenQuestionControlRequest<SessionObservationSnapshot>(
          sidecar.harnessSocketPath,
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
    openQuestionsStorePath({ repoRoot, conductorAgentId: sidecar.conductorAgentId }),
  );
  const sessionState = await loadSessionStateStore(
    sessionStateStorePath({ repoRoot, conductorAgentId: sidecar.conductorAgentId }),
  );
  return {
    snapshot: {
      sequence: questions?.sequence ?? sidecar.sequence,
      openQuestions: questions?.openQuestions ?? sidecar.openQuestions,
      ...(sessionState ? { sessionState } : {}),
    },
    source: 'sidecar',
  };
}

function collectReports(
  sidecar: SessionSidecar,
  observation: SessionObservationSnapshot,
  previous: SessionCursor | undefined,
  source: 'uds' | 'sidecar',
): Array<{ reportType: 'session_state' | 'open_question'; text: string }> {
  const reports: Array<{
    reportType: 'session_state' | 'open_question';
    text: string;
  }> = [];
  const issue = `${sidecar.issueUrl} (${sidecar.conductorAgentId})`;
  const observationSource =
    source === 'uds' ? '稼働中 UDS' : '保存済み sidecar / YAML';
  for (const question of observation.openQuestions) {
    if (
      question.status !== 'open' ||
      previous?.questionFingerprints[question.id] !== undefined
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
        !isRecord(rawCursor.questionFingerprints) ||
        !isRecord(rawCursor.statusFingerprints)
      ) {
        throw new Error(`Invalid operator-agent watch state: cursor ${id}.`);
      }
      cursors[id] = rawCursor as unknown as SessionCursor;
    }
    const pendingReports = value.pendingReports ?? [];
    if (!Array.isArray(pendingReports)) {
      throw new Error('Invalid operator-agent watch state: pendingReports.');
    }
    for (const report of pendingReports) {
      if (
        !isRecord(report) ||
        typeof report.reportId !== 'string' ||
        typeof report.conductorAgentId !== 'string' ||
        typeof report.issueUrl !== 'string' ||
        typeof report.text !== 'string' ||
        (report.reportType !== 'session_state' &&
          report.reportType !== 'open_question') ||
        typeof report.debounceMs !== 'number'
      ) {
        throw new Error('Invalid operator-agent watch state: pending report.');
      }
    }
    return {
      version: WATCH_STATE_VERSION,
      watches,
      cursors,
      pendingReports: pendingReports as OperatorWatchState['pendingReports'],
    };
  } catch (error) {
    if (isEnoent(error)) {
      return {
        version: WATCH_STATE_VERSION,
        watches: {},
        cursors: {},
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
