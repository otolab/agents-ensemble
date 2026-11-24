import { createHash } from 'node:crypto';
import { chmod, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { resolveUserEnsembleRoot } from '../resolve-user-ensemble-root.js';
import { assertNoRenameJournal } from '../workspace-run/rename-journal.js';

/** Keep a workspace's identity stable while resolving and starting a session. */
export async function acquireSessionMigrationReadLock(
  userEnsembleRoot = resolveUserEnsembleRoot(),
): Promise<() => void> {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = join(userEnsembleRoot, 'session-locks');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const databasePath = join(await realpath(directory), 'migration.sqlite');
  const database = new DatabaseSync(databasePath);
  try {
    await chmod(databasePath, 0o600);
    database.exec('PRAGMA busy_timeout = 0');
    database.exec('BEGIN');
    database.prepare('SELECT count(*) AS count FROM sqlite_master').get();
    await assertNoRenameJournal(userEnsembleRoot);
  } catch (error) {
    database.close();
    throw new Error(`Cannot start a workspace session: ${String(error)}`, { cause: error });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      database.exec('ROLLBACK');
    } finally {
      database.close();
    }
  };
}

/** Block cooperating session owners while workspace state is migrated. */
export async function acquireSessionMigrationLock(
  userEnsembleRoot = resolveUserEnsembleRoot(),
): Promise<() => void> {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = join(userEnsembleRoot, 'session-locks');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const databasePath = join(await realpath(directory), 'migration.sqlite');
  const database = new DatabaseSync(databasePath);
  try {
    await chmod(databasePath, 0o600);
    database.exec('PRAGMA busy_timeout = 0');
    database.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    database.close();
    throw new Error(
      'Cannot migrate while an ensemble session is owned. Stop active sessions and retry.',
      { cause: error },
    );
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      database.exec('ROLLBACK');
    } finally {
      database.close();
    }
  };
}

/**
 * A conductor ID identifies the session across clones, storage migrations,
 * and workspace renames. Hold the SQLite write transaction for the whole
 * lifetime of the owner, including startup rollback and final cleanup.
 */
export async function acquireSessionOwnerLock(
  conductorAgentId: string,
  userEnsembleRoot = resolveUserEnsembleRoot(),
): Promise<() => void> {
  if (!conductorAgentId.trim()) throw new Error('Session owner requires a conductor ID.');
  const { DatabaseSync } = await import('node:sqlite');
  const directory = join(userEnsembleRoot, 'session-locks');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const canonicalDirectory = await realpath(directory);
  const migrationPath = join(canonicalDirectory, 'migration.sqlite');
  const migrationDatabase = new DatabaseSync(migrationPath);
  try {
    await chmod(migrationPath, 0o600);
    migrationDatabase.exec('PRAGMA busy_timeout = 0');
    migrationDatabase.exec('BEGIN');
    migrationDatabase.prepare('SELECT count(*) AS count FROM sqlite_master').get();
    await assertNoRenameJournal(userEnsembleRoot);
  } catch (error) {
    migrationDatabase.close();
    throw new Error(`Cannot acquire session ownership while migration is running or recovery is pending: ${String(error)}`, { cause: error });
  }
  const key = createHash('sha256').update(conductorAgentId).digest('hex');
  const databasePath = join(canonicalDirectory, `${key}.sqlite`);
  let database: DatabaseSyncType;
  try {
    database = new DatabaseSync(databasePath);
  } catch (error) {
    migrationDatabase.exec('ROLLBACK');
    migrationDatabase.close();
    throw error;
  }
  try {
    await chmod(databasePath, 0o600);
    database.exec('PRAGMA busy_timeout = 0');
    database.exec('BEGIN IMMEDIATE');
  } catch (error) {
    database.close();
    migrationDatabase.exec('ROLLBACK');
    migrationDatabase.close();
    throw new Error(
      `Cannot acquire session ownership for "${conductorAgentId}"; another process may own it. Verify the other process has stopped and retry.`,
      { cause: error },
    );
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      database.exec('ROLLBACK');
    } finally {
      try {
        database.close();
      } finally {
        try {
          migrationDatabase.exec('ROLLBACK');
        } finally {
          migrationDatabase.close();
        }
      }
    }
  };
}
