import { lock } from 'proper-lockfile';

const LOCK_RETRIES = {
  retries: 20,
  factor: 1.3,
  minTimeout: 25,
  maxTimeout: 250,
  randomize: true,
};

/**
 * Serialize user-root operations across ensemble processes.
 *
 * SettingsManager locks settings.json only while writing. Operations that read
 * the root before writing need a separate root lock to avoid stale snapshots.
 */
export async function withPiUserRootLock<T>(
  agentDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await lock(agentDir, {
    realpath: true,
    retries: LOCK_RETRIES,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}
