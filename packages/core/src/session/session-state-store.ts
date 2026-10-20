import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

export const SESSION_STATE_STORE_VERSION = 2;
export const SESSION_STATUS_LINE_MAX_LENGTH = 80;
export const SESSION_STATUS_HISTORY_MAX_ENTRIES = 50;
export const SESSION_STATE_STORE_MAX_BYTES = 16 * 1024;

export interface SessionStatePathOptions {
  repoRoot: string;
  conductorAgentId: string;
}

export interface SessionStatusLine {
  statusLine: string;
  reportedAt: number;
}

export interface SessionStateStore {
  current: SessionStatusLine;
  /** Previous reports, oldest first; the current report is not duplicated. */
  history: SessionStatusLine[];
}

export function sessionStateStorePath(
  options: SessionStatePathOptions,
): string {
  return join(
    options.repoRoot,
    '.ensemble',
    'sessions',
    options.conductorAgentId,
    'session-state.yaml',
  );
}

export async function loadSessionStateStore(
  path: string,
): Promise<SessionStateStore | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  if (Buffer.byteLength(raw, 'utf8') > SESSION_STATE_STORE_MAX_BYTES) {
    throw new Error('Invalid session state YAML: document exceeds size limit');
  }

  return parseSessionStateStore(yaml.load(raw));
}

export async function saveSessionStatusLine(
  path: string,
  statusLine: string,
  reportedAt = Date.now(),
): Promise<void> {
  const current = parseSessionStatusLine({ statusLine, reportedAt });
  const existing = await loadSessionStateStore(path);
  const next = {
    current,
    history: boundHistory(
      [
        ...(existing?.history ?? []),
        ...(existing ? [existing.current] : []),
      ],
      current,
    ),
  };

  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, serializeSessionStateStore(next), 'utf8');
    await rename(tempPath, path);
  } catch (error) {
    // A failed rename must not leave temporary state that looks like a store.
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

function parseSessionStateStore(value: unknown): SessionStateStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid session state YAML: document');
  }
  const record = value as Record<string, unknown>;

  // Read the original single-current format so existing sessions keep their
  // statusLine when the next report upgrades the file to version 2.
  if (record.version === 1) {
    return {
      current: parseSessionStatusLine(record),
      history: [],
    };
  }
  if (record.version !== SESSION_STATE_STORE_VERSION) {
    throw new Error(
      `Unsupported session state YAML version: ${String(record.version)}`,
    );
  }

  const current = parseSessionStatusLine(record.current);
  if (!Array.isArray(record.history)) {
    throw new Error('Invalid session state YAML: history');
  }
  if (record.history.length > SESSION_STATUS_HISTORY_MAX_ENTRIES) {
    throw new Error('Invalid session state YAML: history exceeds count limit');
  }
  const history = record.history.map(parseSessionStatusLine);
  const parsed = { current, history };
  if (Buffer.byteLength(serializeSessionStateStore(parsed), 'utf8') >
    SESSION_STATE_STORE_MAX_BYTES
  ) {
    throw new Error('Invalid session state YAML: document exceeds size limit');
  }
  return parsed;
}

function parseSessionStatusLine(value: unknown): SessionStatusLine {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid session state YAML: current');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.statusLine !== 'string') {
    throw new Error('Invalid session state YAML: statusLine');
  }
  const statusLine = record.statusLine.trim();
  if (!statusLine) {
    throw new Error('Invalid session state YAML: statusLine must not be empty');
  }
  if (/[\r\n]/u.test(statusLine)) {
    throw new Error('Invalid session state YAML: statusLine must be one line');
  }
  if (Array.from(statusLine).length > SESSION_STATUS_LINE_MAX_LENGTH) {
    throw new Error(
      `Invalid session state YAML: statusLine must be at most ${SESSION_STATUS_LINE_MAX_LENGTH} characters`,
    );
  }
  if (
    typeof record.reportedAt !== 'number' ||
    !Number.isFinite(record.reportedAt)
  ) {
    throw new Error('Invalid session state YAML: reportedAt');
  }

  return {
    statusLine,
    reportedAt: record.reportedAt,
  };
}

function boundHistory(
  history: SessionStatusLine[],
  current: SessionStatusLine,
): SessionStatusLine[] {
  const bounded = history.slice(-SESSION_STATUS_HISTORY_MAX_ENTRIES);
  while (
    bounded.length > 0 &&
    Buffer.byteLength(
      serializeSessionStateStore({ current, history: bounded }),
      'utf8',
    ) > SESSION_STATE_STORE_MAX_BYTES
  ) {
    bounded.shift();
  }
  if (
    Buffer.byteLength(
      serializeSessionStateStore({ current, history: bounded }),
      'utf8',
    ) > SESSION_STATE_STORE_MAX_BYTES
  ) {
    throw new Error('Invalid session state YAML: document exceeds size limit');
  }
  return bounded;
}

function serializeSessionStateStore(state: SessionStateStore): string {
  return `${yaml.dump(
    {
      version: SESSION_STATE_STORE_VERSION,
      current: state.current,
      history: state.history,
    },
    { lineWidth: 120 },
  )}\n`;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
