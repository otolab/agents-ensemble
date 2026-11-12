import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export interface PiAcpSessionMapPaths {
  upstreamPath: string;
  legacyPath: string;
}

export function resolvePiAcpSessionMapPaths(
  homeDir: string,
): PiAcpSessionMapPaths {
  return {
    upstreamPath: join(homeDir, '.pi', 'pi-acp', 'session-map.json'),
    legacyPath: join(homeDir, 'session-map.json'),
  };
}

/**
 * Copy the pre-upstream builtin map into pi-acp's HOME-based location. Keep
 * the source intact so older readers and interrupted upgrades remain safe.
 */
export function migrateLegacyPiAcpSessionMap(
  paths: PiAcpSessionMapPaths,
): boolean {
  if (!existsSync(paths.legacyPath) || existsSync(paths.upstreamPath)) {
    return false;
  }

  mkdirSync(dirname(paths.upstreamPath), {
    recursive: true,
    mode: 0o700,
  });
  try {
    copyFileSync(
      paths.legacyPath,
      paths.upstreamPath,
      constants.COPYFILE_EXCL,
    );
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'EEXIST' || error.code === 'ENOENT')
    ) {
      return false;
    }
    throw error;
  }
}
