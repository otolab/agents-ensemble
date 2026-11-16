import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_ID = 'cursor-acp-worker-fixture-session';
const ROOT_BLOB_ID = makeBlobId('root');
const SCRUBBED_STORE_FIXTURE_DIRECTORY = fileURLToPath(
  new URL('./cursor-acp-worker-session-store/', import.meta.url),
);

export const CURSOR_ACP_FIXTURE_SESSION_ID = SESSION_ID;
export const CURSOR_ACP_FIXTURE_CWD = '/tmp/cursor-acp-worker-fixture';

export interface CursorAcpStoreFixtureIdentity {
  sessionId: string;
  cwd: string;
}

export async function hasCursorAcpSqliteSupport(): Promise<boolean> {
  try {
    await import('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

export async function readCursorAcpStoreFixtureIdentity(): Promise<
  CursorAcpStoreFixtureIdentity
> {
  const metadata = JSON.parse(
    await readFile(
      join(SCRUBBED_STORE_FIXTURE_DIRECTORY, 'meta.json'),
      'utf8',
    ),
  ) as { cwd?: unknown };
  if (typeof metadata.cwd !== 'string' || !metadata.cwd.startsWith('/')) {
    throw new Error('Scrubbed Cursor fixture has no absolute cwd.');
  }

  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(
    join(SCRUBBED_STORE_FIXTURE_DIRECTORY, 'store.db'),
    { readOnly: true },
  );
  try {
    const row = database
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('0');
    const value = row?.value;
    if (typeof value !== 'string') {
      throw new Error('Scrubbed Cursor fixture has no store metadata.');
    }
    const serialized = value.trimStart().startsWith('{')
      ? value
      : /^[0-9a-f]+$/iu.test(value) && value.length % 2 === 0
        ? Buffer.from(value, 'hex').toString('utf8')
        : undefined;
    if (serialized === undefined) {
      throw new Error('Scrubbed Cursor fixture store metadata is invalid.');
    }
    const storeMetadata = JSON.parse(serialized) as { agentId?: unknown };
    if (
      typeof storeMetadata.agentId !== 'string' ||
      !storeMetadata.agentId.trim() ||
      /[/\\\0]/u.test(storeMetadata.agentId)
    ) {
      throw new Error('Scrubbed Cursor fixture has no valid session ID.');
    }
    return { sessionId: storeMetadata.agentId, cwd: metadata.cwd };
  } finally {
    database.close();
  }
}

export async function copyCursorAcpStoreFixture(
  sessionDirectory: string,
): Promise<void> {
  await mkdir(sessionDirectory, { recursive: true });
  await Promise.all(
    (['meta.json', 'store.db'] as const).map((name) =>
      copyFile(
        join(SCRUBBED_STORE_FIXTURE_DIRECTORY, name),
        join(sessionDirectory, name),
      ),
    ),
  );
}

export async function writeCursorAcpSessionMetadataFixture(
  sessionDirectory: string,
  options: { cwd?: string } = {},
): Promise<void> {
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    join(sessionDirectory, 'meta.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      cwd: options.cwd ?? CURSOR_ACP_FIXTURE_CWD,
    })}\n`,
    'utf8',
  );
}

export async function writeCursorAcpWorkerSessionFixture(
  sessionDirectory: string,
  options: {
    cwd?: string;
    storeSessionId?: string;
    transcriptShape?:
      | 'empty-messages'
      | 'missing-root-blob'
      | 'missing-root-turns'
      | 'missing-turn-blob'
      | 'unrecognized-turn';
  } = {},
): Promise<void> {
  const cwd = options.cwd ?? CURSOR_ACP_FIXTURE_CWD;
  await mkdir(sessionDirectory, { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const storePath = join(sessionDirectory, 'store.db');
  const database = new DatabaseSync(storePath);
  try {
    database.exec(`
      CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    `);

    const blobs = createFixtureBlobs(options.transcriptShape);
    const insertBlob = database.prepare(
      'INSERT INTO blobs (id, data) VALUES (?, ?)',
    );
    for (const [blobId, data] of blobs) {
      insertBlob.run(`agentKv:blob:${blobId}`, data);
    }

    const metadata = {
      agentId: options.storeSessionId ?? SESSION_ID,
      latestRootBlobId: ROOT_BLOB_ID,
    };
    database
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run('0', Buffer.from(JSON.stringify(metadata), 'utf8').toString('hex'));
  } finally {
    database.close();
  }

  await writeCursorAcpSessionMetadataFixture(sessionDirectory, { cwd });
}

function createFixtureBlobs(
  transcriptShape:
    | 'empty-messages'
    | 'missing-root-blob'
    | 'missing-root-turns'
    | 'missing-turn-blob'
    | 'unrecognized-turn'
    | undefined,
): Array<[string, Uint8Array]> {
  const blobs: Array<[string, Uint8Array]> = [];
  const addBlob = (name: string, data: Uint8Array): Uint8Array => {
    const id = makeBlobId(name);
    blobs.push([id, data]);
    return Buffer.from(id, 'hex');
  };

  const userMessage = protobufConcat(
    protobufString(
      1,
      transcriptShape === 'empty-messages'
        ? ' '
        : 'Cursor ACP fixture user message.',
    ),
    protobufString(2, 'cursor-user-message-fixture'),
    protobufVarint(25, Date.parse('2026-11-11T10:00:01.000Z')),
  );
  const userMessageRef = addBlob('user-message', userMessage);

  const toolStep = protobufConcat(
    protobufMessage(2, protobufString(1, 'TOOL_SECRET')),
  );
  const toolStepRef = addBlob('tool-step', toolStep);

  const thinkingStep = protobufConcat(
    protobufMessage(3, protobufString(1, 'THINKING_SECRET')),
  );
  const thinkingStepRef = addBlob('thinking-step', thinkingStep);

  const assistantMessage = protobufConcat(
    protobufString(
      1,
      transcriptShape === 'empty-messages'
        ? ' '
        : 'Cursor ACP fixture assistant reply.',
    ),
    protobufVarint(2, Date.parse('2026-11-11T10:00:02.000Z')),
  );
  const assistantStep = protobufMessage(1, assistantMessage);
  const assistantStepRef = addBlob('assistant-step', assistantStep);

  const agentTurn = protobufConcat(
    protobufMessage(1, userMessageRef),
    protobufMessage(2, toolStepRef),
    protobufMessage(2, thinkingStepRef),
    protobufMessage(2, assistantStepRef),
  );
  const turn =
    transcriptShape === 'unrecognized-turn'
      ? protobufString(90, 'future turn field')
      : protobufConcat(
          protobufMessage(1, agentTurn),
          protobufString(90, 'future turn field'),
        );
  const turnBlobId = makeBlobId('turn');
  const turnRef = Buffer.from(turnBlobId, 'hex');
  if (transcriptShape !== 'missing-turn-blob') {
    blobs.push([turnBlobId, turn]);
  }

  const root =
    transcriptShape === 'missing-root-turns'
      ? protobufString(90, 'future root field')
      : protobufConcat(
          protobufMessage(8, turnRef),
          protobufString(90, 'future root field'),
        );
  if (transcriptShape !== 'missing-root-blob') {
    blobs.push([ROOT_BLOB_ID, root]);
  }
  return blobs;
}

function makeBlobId(name: string): string {
  return createHash('sha256').update(`cursor-acp-fixture:${name}`).digest('hex');
}

function protobufString(fieldNumber: number, text: string): Uint8Array {
  return protobufMessage(fieldNumber, Buffer.from(text, 'utf8'));
}

function protobufMessage(
  fieldNumber: number,
  payload: Uint8Array,
): Uint8Array {
  return protobufConcat(
    encodeVarint(BigInt((fieldNumber << 3) | 2)),
    encodeVarint(BigInt(payload.byteLength)),
    payload,
  );
}

function protobufVarint(fieldNumber: number, value: number): Uint8Array {
  return protobufConcat(
    encodeVarint(BigInt(fieldNumber << 3)),
    encodeVarint(BigInt(value)),
  );
}

function encodeVarint(input: bigint): Uint8Array {
  let value = input;
  const bytes: number[] = [];
  while (value > 0x7fn) {
    bytes.push(Number(value & 0x7fn) | 0x80);
    value >>= 7n;
  }
  bytes.push(Number(value));
  return Uint8Array.from(bytes);
}

function protobufConcat(...parts: Uint8Array[]): Uint8Array {
  return Buffer.concat(parts);
}
