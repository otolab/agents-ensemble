import { lock } from 'proper-lockfile';
import { lstat, realpath } from 'node:fs/promises';
import {
  getProjectWriteBoundaryPaths,
  isPathWithinAnyRoot,
} from './conductor-path-safety.js';

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
  cwd: string,
  projectPiDirs: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  // proper-lockfile@4.1.2 creates `${realpath(root)}.lock` as a directory.
  // Resolve that exact path before acquisition so project-owned symlink and
  // case aliases are rejected before mkdir/stale-lock cleanup can touch them.
  const canonicalAgentDir = await realpath(agentDir);
  const lockfilePath = `${canonicalAgentDir}.lock`;
  const protectedProjectRoots = await getProjectWriteBoundaryPaths(
    cwd,
    projectPiDirs,
  );
  if (await isPathWithinAnyRoot(lockfilePath, protectedProjectRoots)) {
    throw new Error(
      `Refusing to create Pi user-root lock at ${lockfilePath} because its path or a symlink alias enters a project-owned resource.`,
    );
  }
  try {
    if ((await lstat(lockfilePath)).isSymbolicLink()) {
      throw new Error(
        `Refusing to use Pi user-root lock at ${lockfilePath} because the lock path is a symlink.`,
      );
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const release = await lock(canonicalAgentDir, {
    realpath: false,
    retries: LOCK_RETRIES,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
