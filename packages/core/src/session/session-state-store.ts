import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

export const SESSION_STATE_STORE_VERSION = 1;
export const SESSION_STATUS_LINE_MAX_LENGTH = 80;

export interface SessionStatePathOptions {
  repoRoot: string;
  conductorAgentId: string;
}

export interface SessionStatusLine {
  statusLine: string;
  reportedAt: number;
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
): Promise<SessionStatusLine | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }

  return parseSessionStateStore(yaml.load(raw));
}

export async function saveSessionStatusLine(
  path: string,
  statusLine: string,
  reportedAt = Date.now(),
): Promise<void> {
  const document = parseSessionStateStore({
    version: SESSION_STATE_STORE_VERSION,
    statusLine,
    reportedAt,
  });

  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      tempPath,
      `${yaml.dump(
        {
          version: SESSION_STATE_STORE_VERSION,
          ...document,
        },
        { lineWidth: 120 },
      )}\n`,
      'utf8',
    );
    await rename(tempPath, path);
  } catch (error) {
    // A failed rename must not leave temporary state that looks like a store.
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

function parseSessionStateStore(value: unknown): SessionStatusLine {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid session state YAML: document');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== SESSION_STATE_STORE_VERSION) {
    throw new Error(
      `Unsupported session state YAML version: ${String(record.version)}`,
    );
  }
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

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
