import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The protected operation has not started and can safely be retried. */
export class OperatorLockTimeoutError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OperatorLockTimeoutError';
  }
}

/** Serialize cooperating operations for a canonical workspace across processes. */
export async function withOperatorWorkspaceLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const id = createHash('sha256').update(root).digest('hex');
  const database = new DatabaseSync(join(dirname(root), `.ensemble-workspace-lock-${id}.sqlite`));
  let locked = false;
  try {
    database.exec('PRAGMA busy_timeout = 0');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        database.exec('BEGIN IMMEDIATE');
        locked = true;
        break;
      } catch (error) {
        if (!(error instanceof Error) || !/database is locked|database is busy/iu.test(error.message)) throw error;
        if (attempt < 39) await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!locked) throw new OperatorLockTimeoutError('Could not acquire operator workspace lock.');
    return await operation();
  } finally {
    try {
      if (locked) database.exec('ROLLBACK');
    } finally {
      database.close();
    }
  }
}
