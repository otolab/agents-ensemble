import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isEnoent, isRecord } from '../internal/operator-utils.js';
import { OperatorLockTimeoutError, withOperatorWorkspaceLock } from '../workspace/operator-workspace-lock.js';
import { WATCH_STATE_VERSION, type OperatorWatchState } from './operator-watch-state.js';
import type { ConductorMessageListenConfig, SessionCursor, WatchConfig } from './types.js';
import {
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  MAX_DEBOUNCE_MS,
  DEFAULT_MESSAGE_DEBOUNCE_MS,
  MAX_MESSAGE_DEBOUNCE_MS,
  parseBoundedInteger,
} from './operator-watch-validation.js';

const WATCH_STATE_LOCK_RETRIES = 40;
const WATCH_STATE_LOCK_RETRY_DELAY_MS = 25;

export async function loadWatchState(path: string): Promise<OperatorWatchState> {
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
      let questionSnapshots: SessionCursor['questionSnapshots'];
      if (rawCursor.questionSnapshots !== undefined) {
        if (!isRecord(rawCursor.questionSnapshots)) {
          throw new Error(
            `Invalid operator-agent watch state: question snapshots ${id}.`,
          );
        }
        questionSnapshots = {};
        for (const [questionId, rawQuestion] of Object.entries(
          rawCursor.questionSnapshots,
        )) {
          if (
            !isRecord(rawQuestion) ||
            typeof rawQuestion.question !== 'string' ||
            (rawQuestion.status !== 'open' &&
              rawQuestion.status !== 'answered') ||
            typeof rawQuestion.askedAt !== 'number' ||
            !Number.isFinite(rawQuestion.askedAt)
          ) {
            throw new Error(
              `Invalid operator-agent watch state: question snapshot ${id}/${questionId}.`,
            );
          }
          questionSnapshots[questionId] = {
            question: rawQuestion.question,
            status: rawQuestion.status,
            askedAt: rawQuestion.askedAt,
          };
        }
      }
      let questionCountObservation: SessionCursor['questionCountObservation'];
      if (rawCursor.questionCountObservation !== undefined) {
        if (!isRecord(rawCursor.questionCountObservation)) {
          throw new Error(
            `Invalid operator-agent watch state: question count observation ${id}.`,
          );
        }
        // Older observations counted answered questions too. Drop those
        // values so a restart establishes a correct unanswered-count baseline.
        if (
          rawCursor.questionCountObservation.metric ===
          'unanswered_open_questions'
        ) {
          const parseCountSample = (
            sample: unknown,
          ): NonNullable<
            SessionCursor['questionCountObservation']
          >['current'] => {
            if (
              !isRecord(sample) ||
              !Number.isSafeInteger(sample.count) ||
              (sample.count as number) < 0 ||
              !Number.isSafeInteger(sample.checkedAt) ||
              (sample.checkedAt as number) < 0 ||
              (sample.source !== 'uds' && sample.source !== 'resume_store')
            ) {
              throw new Error(
                `Invalid operator-agent watch state: question count sample ${id}.`,
              );
            }
            return {
              count: sample.count as number,
              checkedAt: sample.checkedAt as number,
              source: sample.source,
            };
          };
          questionCountObservation = {
            metric: 'unanswered_open_questions',
            current: parseCountSample(
              rawCursor.questionCountObservation.current,
            ),
            ...(rawCursor.questionCountObservation.previous === undefined
              ? {}
              : {
                  previous: parseCountSample(
                    rawCursor.questionCountObservation.previous,
                  ),
                }),
          };
        }
      }
      cursors[id] = {
        sequence: rawCursor.sequence as number,
        questionFingerprints: rawCursor.questionFingerprints,
        ...(questionSnapshots ? { questionSnapshots } : {}),
        statusFingerprints: rawCursor.statusFingerprints,
        ...(questionCountObservation
          ? { questionCountObservation }
          : {}),
      };
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
    const rawIdleCandidateFingerprints =
      value.idleCandidateFingerprints ?? {};
    if (!isRecord(rawIdleCandidateFingerprints)) {
      throw new Error(
        'Invalid operator-agent watch state: idleCandidateFingerprints.',
      );
    }
    const idleCandidateFingerprints: OperatorWatchState['idleCandidateFingerprints'] =
      {};
    for (const [id, rawFingerprints] of Object.entries(
      rawIdleCandidateFingerprints,
    )) {
      if (!isRecord(rawFingerprints)) {
        throw new Error(
          `Invalid operator-agent watch state: idle candidate fingerprints ${id}.`,
        );
      }
      const fingerprints: OperatorWatchState['idleCandidateFingerprints'][string] =
        {};
      for (const [kind, fingerprint] of Object.entries(rawFingerprints)) {
        if (
          (kind !== 'idle_phase' && kind !== 'stale_running') ||
          typeof fingerprint !== 'string' ||
          fingerprint.trim().length === 0
        ) {
          throw new Error(
            `Invalid operator-agent watch state: idle candidate fingerprint ${id}/${kind}.`,
          );
        }
        fingerprints[kind] = fingerprint;
      }
      idleCandidateFingerprints[id] = fingerprints;
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
          report.reportType !== 'conductor_message' &&
          report.reportType !== 'idle_candidate') ||
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
      if (
        report.oversizedSendCounts !== undefined &&
        (report.reportType !== 'conductor_message' ||
          !Array.isArray(report.oversizedSendCounts) ||
          report.oversizedSendCounts.length === 0 ||
          report.oversizedSendCounts.some(
            (sendCount) =>
              !Number.isSafeInteger(sendCount) ||
              (sendCount as number) < 0,
          ))
      ) {
        throw new Error(
          'Invalid operator-agent watch state: oversized conductor message report.',
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
      if (
        report.readyAt !== undefined &&
        (typeof report.readyAt !== 'number' ||
          !Number.isSafeInteger(report.readyAt) ||
          report.readyAt < 0)
      ) {
        throw new Error(
          'Invalid operator-agent watch state: pending report readyAt.',
        );
      }
      for (const field of [
        'arrivalOrder',
        'firstQueuedAt',
        'eligibleAt',
        'batchReadyAt',
        'retryReadyAt',
      ] as const) {
        const timestamp = report[field];
        if (
          timestamp !== undefined &&
          (typeof timestamp !== 'number' ||
            !Number.isSafeInteger(timestamp) ||
            timestamp < 0)
        ) {
          throw new Error(
            `Invalid operator-agent watch state: pending report ${field}.`,
          );
        }
      }
      if (
        report.priority !== undefined &&
          report.priority !== 'normal' &&
          report.priority !== 'open_question' &&
          report.priority !== 'idle'
      ) {
        throw new Error(
          'Invalid operator-agent watch state: pending report priority.',
        );
      }
      if (
        (report.frozenBatchId !== undefined &&
          (typeof report.frozenBatchId !== 'string' ||
            report.frozenBatchId.trim().length === 0)) ||
        (report.frozenPayload !== undefined &&
          typeof report.frozenPayload !== 'string')
      ) {
        throw new Error(
          'Invalid operator-agent watch state: pending report frozen batch.',
        );
      }
    }
    const normalizedPendingReports = pendingReports.map((report, index) => {
      const record = report as Record<string, unknown>;
      const readyAt =
        typeof record.readyAt === 'number' ? record.readyAt : 0;
      return {
        ...record,
        // Legacy v1 state had no persisted deadline and was replayed
        // immediately on startup.
        readyAt,
        // Old records have no queue-order metadata. Preserve their file order;
        // subsequent reports use the profile-wide locked sequence.
        arrivalOrder:
          typeof record.arrivalOrder === 'number'
            ? record.arrivalOrder
            : index,
        // Old queuedAt values are intentionally ignored. readyAt is the only
        // durable deadline they carried; new records retain firstQueuedAt.
        firstQueuedAt:
          typeof record.firstQueuedAt === 'number'
            ? record.firstQueuedAt
            : readyAt,
        priority:
          record.priority === 'idle' ||
          record.reportType === 'idle_candidate'
            ? 'idle'
            : record.priority === 'open_question' ||
                record.reportType === 'open_question'
              ? 'open_question'
            : 'normal',
      };
    }) as OperatorWatchState['pendingReports'];
    return {
      version: WATCH_STATE_VERSION,
      watches,
      cursors,
      messageListeners,
      messageCursors,
      idleCandidateFingerprints,
      pendingReports: normalizedPendingReports,
    };
  } catch (error) {
    if (isEnoent(error)) {
      return {
        version: WATCH_STATE_VERSION,
        watches: {},
        cursors: {},
        messageListeners: {},
        messageCursors: {},
        idleCandidateFingerprints: {},
        pendingReports: [],
      };
    }
    throw error;
  }
}

export function saveWatchStateSync(path: string, state: OperatorWatchState): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export async function saveWatchState(
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

export async function withWatchStateLock<T>(
  root: string,
  profile: string,
  operation: (nextArrivalOrder: (minimumExisting?: number) => number) => Promise<T>,
): Promise<T> {
  const workspace = join(root, 'operator-agents', profile);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const canonicalWorkspace = await realpath(workspace);
  return withOperatorWorkspaceLock(canonicalWorkspace, () =>
    withWatchStateLockInsideWorkspace(root, profile, operation),
  );
}

async function withWatchStateLockInsideWorkspace<T>(
  root: string,
  profile: string,
  operation: (nextArrivalOrder: (minimumExisting?: number) => number) => Promise<T>,
): Promise<T> {
  const directory = join(root, 'operator-agents', profile, 'watch');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const canonicalDirectory = await realpath(directory);
  const database = new DatabaseSync(
    join(canonicalDirectory, 'watch-state-lock.sqlite'),
  );
  let transactionStarted = false;
  let operationSucceeded = false;
  let operationError: unknown;
  try {
    await chmod(
      join(canonicalDirectory, 'watch-state-lock.sqlite'),
      0o600,
    );
    database.exec('PRAGMA busy_timeout = 0');
    let lastLockError: unknown;
    for (let attempt = 0; attempt < WATCH_STATE_LOCK_RETRIES; attempt += 1) {
      try {
        database.exec('BEGIN IMMEDIATE');
        transactionStarted = true;
        break;
      } catch (error) {
        if (!isSqliteLockContention(error)) throw error;
        lastLockError = error;
        if (attempt + 1 < WATCH_STATE_LOCK_RETRIES) {
          await new Promise((resolve) =>
            setTimeout(resolve, WATCH_STATE_LOCK_RETRY_DELAY_MS),
          );
        }
      }
    }
    if (!transactionStarted) {
      throw new OperatorLockTimeoutError(
        `Could not acquire operator watch state profile lock after ${WATCH_STATE_LOCK_RETRIES} attempts.`,
        { cause: lastLockError },
      );
    }
    database.exec(
      'CREATE TABLE IF NOT EXISTS operator_watch_order (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)',
    );
    database
      .prepare(
        'INSERT INTO operator_watch_order (id, value) VALUES (1, ?) ON CONFLICT(id) DO NOTHING',
      )
      .run(Date.now() * 1_000);
    const nextArrivalOrder = (minimumExisting = 0) => {
      const row = database
        .prepare('SELECT value FROM operator_watch_order WHERE id = 1')
        .get() as { value: number } | undefined;
      if (!row || !Number.isSafeInteger(row.value)) {
        throw new Error('Operator watch order counter is missing or invalid.');
      }
      const next = Math.max(
        row.value + 1,
        minimumExisting + 1,
        Date.now() * 1_000,
      );
      if (!Number.isSafeInteger(next)) {
        throw new Error('Operator watch order counter exceeded safe integer range.');
      }
      database
        .prepare('UPDATE operator_watch_order SET value = ? WHERE id = 1')
        .run(next);
      return next;
    };
    const result = await operation(nextArrivalOrder);
    operationSucceeded = true;
    return result;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let releaseError: unknown;
    try {
      if (transactionStarted) {
        database.exec(operationSucceeded ? 'COMMIT' : 'ROLLBACK');
      }
    } catch (error) {
      releaseError = error;
    }
    try {
      database.close();
    } catch (error) {
      releaseError =
        releaseError === undefined
          ? error
          : new AggregateError([releaseError, error]);
    }
    if (releaseError !== undefined) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, releaseError],
          'Operator watch state update failed and its profile lock could not be released.',
        );
      }
      throw releaseError;
    }
  }
}

function isSqliteLockContention(error: unknown): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('errcode' in error) ||
    typeof error.errcode !== 'number'
  ) {
    return false;
  }
  const primaryCode = error.errcode & 0xff;
  return primaryCode === 5 || primaryCode === 6;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}
