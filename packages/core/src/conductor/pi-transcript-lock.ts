import { createHash } from 'node:crypto';
import { chmod, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveUserEnsembleRoot } from '../resolve-user-ensemble-root.js';
import { recoverPiTranscriptStaging } from './pi-transcript-recovery.js';
import { publishPiTranscriptPointer, readPiTranscriptPointer, type PiTranscriptPointerInput } from './pi-transcript-pointer.js';

export interface LockedPiTranscriptPointer {
  read(): ReturnType<typeof readPiTranscriptPointer>;
  publish(generation: string, expectedGeneration: string | undefined): void;
}

/**
 * Serialize cooperating pointer transactions for this conductor ID, including
 * asynchronous work between resolution and publication. This lock is separate
 * from session ownership so readers can cooperate with a running owner.
 * Callers must also hold the workspace migration read lock while resolving a
 * workspace path, and must coordinate live SDK writes/snapshots separately.
 * Lock contention fails immediately. SQLite releases the lock when a process
 * exits, including an unclean exit; non-cooperating writers are not excluded.
 */
export async function withPiTranscriptPointerLock<T>(
  input: PiTranscriptPointerInput,
  action: (pointer: LockedPiTranscriptPointer) => Promise<T> | T,
  userEnsembleRoot = resolveUserEnsembleRoot(),
): Promise<T> {
  if (!input.conductorAgentId.trim()) throw new Error('Pi transcript lock requires a conductor ID.');
  const directory = join(userEnsembleRoot, 'session-locks');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const key = createHash('sha256').update(input.conductorAgentId).digest('hex');
  const databasePath = join(await realpath(directory), `pi-transcript-${key}.sqlite`);
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(databasePath);
  let locked = false;
  let active = false;
  try {
    await chmod(databasePath, 0o600);
    database.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
    locked = true;
    active = true;
    recoverPiTranscriptStaging(input);
    const assertActive = () => {
      if (!active) throw new Error('Pi transcript pointer lock is no longer held.');
    };
    return await action({
      read() { assertActive(); return readPiTranscriptPointer(input); },
      publish(generation, expectedGeneration) {
        assertActive();
        publishPiTranscriptPointer({ ...input, generation, expectedGeneration });
      },
    });
  } finally {
    active = false;
    try {
      if (locked) database.exec('ROLLBACK');
    } finally {
      database.close();
    }
  }
}
