import {
  constants,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

export interface PiAcpSessionMapPaths {
  upstreamPath: string;
  /** Map path used by the earlier builtin wrapper before upstream pi-acp. */
  legacyPath: string;
  /** Previous shared worker map locations, retained for migration and reading. */
  compatibilityPaths: string[];
}

export function resolvePiAcpSessionMapPaths(
  homeDir: string,
  previousWorkerHome?: string,
): PiAcpSessionMapPaths {
  const upstreamPath = join(homeDir, '.pi', 'pi-acp', 'session-map.json');
  const legacyPath = join(homeDir, 'session-map.json');
  const compatibilityPaths = [legacyPath];
  if (previousWorkerHome) {
    compatibilityPaths.push(
      join(previousWorkerHome, '.pi', 'pi-acp', 'session-map.json'),
      join(previousWorkerHome, 'session-map.json'),
    );
  }
  return { upstreamPath, legacyPath, compatibilityPaths };
}

/** New files created by upstream Pi inherit this process umask on POSIX. */
export function setPrivatePiSessionStorageUmask(): void {
  if (process.platform !== 'win32') process.umask(0o077);
}

/**
 * Prepare builtin Pi's issue-scoped storage, migrate an older shared map, and
 * restrict existing map/transcript files before upstream code opens them.
 */
export function preparePiAcpSessionStorage(input: {
  workerStorageRoot: string;
  workerHome: string;
  sessionsDir: string;
  legacyWorkerHome?: string;
  mapPaths: PiAcpSessionMapPaths;
}): void {
  ensureDirectory(input.workerStorageRoot);
  ensureDirectory(input.workerHome);
  ensureDirectory(input.sessionsDir);
  ensureDirectory(dirname(input.mapPaths.upstreamPath));

  if (process.platform !== 'win32') {
    secureExistingTree(input.workerStorageRoot);
    if (
      input.legacyWorkerHome &&
      !isWithin(input.workerStorageRoot, input.legacyWorkerHome)
    ) {
      secureExistingTree(input.legacyWorkerHome);
    }
  }

  migrateLegacyPiAcpSessionMap(input.mapPaths);

  if (process.platform !== 'win32') {
    secureExistingTree(input.workerStorageRoot);
  }
}

/**
 * Copy the first available old map into upstream pi-acp's HOME-based location.
 * Sources remain intact so existing transcript paths and older readers work.
 */
export function migrateLegacyPiAcpSessionMap(
  paths: PiAcpSessionMapPaths,
): boolean {
  if (existsSync(paths.upstreamPath)) return false;

  const sourcePath = paths.compatibilityPaths.find(existsSync);
  if (!sourcePath) return false;

  mkdirSync(dirname(paths.upstreamPath), {
    recursive: true,
    mode: OWNER_ONLY_DIRECTORY_MODE,
  });
  try {
    copyFileSync(
      sourcePath,
      paths.upstreamPath,
      constants.COPYFILE_EXCL,
    );
    if (process.platform !== 'win32') {
      chmodSync(paths.upstreamPath, OWNER_ONLY_FILE_MODE);
    }
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

function ensureDirectory(path: string): void {
  mkdirSync(path, {
    recursive: true,
    mode: OWNER_ONLY_DIRECTORY_MODE,
  });
  if (process.platform === 'win32') return;

  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      '[acp] builtin Pi session storage must use regular directories without symbolic links.',
    );
  }
  chmodSync(path, OWNER_ONLY_DIRECTORY_MODE);
}

function secureExistingTree(path: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }

  if (stats.isSymbolicLink()) {
    throw new Error(
      '[acp] builtin Pi session storage contains a symbolic link; use regular files and directories.',
    );
  }
  if (stats.isDirectory()) {
    chmodSync(path, OWNER_ONLY_DIRECTORY_MODE);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      secureExistingTree(join(path, entry.name));
    }
    return;
  }
  if (stats.isFile()) {
    chmodSync(path, OWNER_ONLY_FILE_MODE);
    return;
  }
  throw new Error(
    '[acp] builtin Pi session storage contains an unsupported file type.',
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function isEnoent(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT',
  );
}
