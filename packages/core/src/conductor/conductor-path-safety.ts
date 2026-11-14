import type { Dirent } from 'node:fs';
import {
  lstat,
  readdir,
  readlink,
  realpath,
  stat,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';

/**
 * Resolve existing path components, including symlinks, while preserving any
 * missing suffix. A dangling symlink is resolved to its intended target too.
 */
export async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!isMissingFile(error)) throw error;

    try {
      const details = await lstat(absolute);
      if (details.isSymbolicLink()) {
        const linkTarget = await readlink(absolute);
        return canonicalPath(resolve(dirname(absolute), linkTarget));
      }
    } catch (linkError) {
      if (!isMissingFile(linkError)) throw linkError;
    }

    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(await canonicalPath(parent), basename(absolute));
  }
}

/**
 * Check path containment using the comparison rules of the containing volume.
 * This matters for missing suffixes: realpath cannot normalize their casing.
 */
export async function isPathWithin(parent: string, target: string): Promise<boolean> {
  const absoluteParent = resolve(parent);
  const absoluteTarget = resolve(target);
  if (isPathWithinCaseSensitive(absoluteParent, absoluteTarget)) return true;
  if (!isPathWithinCaseInsensitive(absoluteParent, absoluteTarget)) return false;

  const commonAncestor = await deepestExistingDirectory(
    commonPathPrefix(absoluteParent, absoluteTarget),
  );
  const isCaseInsensitive = await detectCaseInsensitiveLookup(commonAncestor);
  if (isCaseInsensitive === undefined) {
    throw new Error(
      'Could not determine whether the resource paths alias each other; refusing the write.',
    );
  }
  return isCaseInsensitive;
}

/**
 * Check whether the spelling, canonical target, or any symlink-resolution hop
 * lies within a protected root. This catches a user-layer symlink to a project
 * file even when that project file is itself a symlink elsewhere.
 */
export async function isPathWithinAnyRoot(
  targetPath: string,
  roots: readonly string[],
): Promise<boolean> {
  const targetAliases = await pathAliases(targetPath);
  for (const root of roots) {
    const rootAliases = await pathAliases(root);
    for (const parent of rootAliases) {
      for (const target of targetAliases) {
        if (await isPathWithin(parent, target)) return true;
      }
    }
  }
  return false;
}

/**
 * Project-owned paths that setup and Pi auth may encounter as write targets.
 * Include links anywhere under the project roots so external symlink targets
 * are protected while unrelated user links remain compatible.
 */
export async function getProjectWriteBoundaryPaths(
  cwd: string,
  projectPiDirs: readonly string[],
): Promise<string[]> {
  const projectEnsembleDir = join(resolve(cwd), '.ensemble');
  const projectPiRoots = [...new Set(projectPiDirs.map((path) => resolve(path)))];
  const projectRoots = [...new Set([projectEnsembleDir, ...projectPiRoots])];
  const symlinkPaths = new Set<string>();
  const visitedDirectories = new Set<string>();

  for (const root of projectRoots) {
    await collectProjectSymlinkPaths(root, symlinkPaths, visitedDirectories);
  }

  return [
    ...projectRoots,
    join(projectEnsembleDir, 'config.yaml'),
    ...projectPiRoots.flatMap((root) => [
      join(root, 'settings.json'),
      join(root, 'auth.json'),
    ]),
    ...symlinkPaths,
  ];
}

/**
 * Find links inside a project resource tree without following them. Each link
 * becomes a protected root, so a user path that points at the same external
 * file or directory is rejected while unrelated external user links remain
 * usable. An unreadable tree cannot be checked safely, so fail closed.
 */
async function collectProjectSymlinkPaths(
  root: string,
  symlinkPaths: Set<string>,
  visitedDirectories: Set<string>,
): Promise<void> {
  const pendingDirectories = [root];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop()!;
    let directoryDetails: Awaited<ReturnType<typeof lstat>>;
    try {
      directoryDetails = await lstat(directory);
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw new Error(
        `Could not inspect project write boundary at ${directory}; refusing the write.`,
        { cause: error },
      );
    }

    if (directoryDetails.isSymbolicLink()) {
      symlinkPaths.add(directory);
      continue;
    }
    if (!directoryDetails.isDirectory()) continue;

    const identity =
      directoryDetails.ino !== 0
        ? `${directoryDetails.dev}:${directoryDetails.ino}`
        : await realpath(directory);
    if (visitedDirectories.has(identity)) continue;
    visitedDirectories.add(identity);

    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(
        `Could not inspect project write boundary at ${directory}; refusing the write.`,
        { cause: error },
      );
    }

    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        symlinkPaths.add(entryPath);
      } else if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
      } else if (!entry.isFile()) {
        // Some filesystems do not report directory entry types. Inspect only
        // those ambiguous entries so symlinks are not silently missed.
        let details: Awaited<ReturnType<typeof lstat>>;
        try {
          details = await lstat(entryPath);
        } catch (error) {
          throw new Error(
            `Could not inspect project write boundary at ${entryPath}; refusing the write.`,
            { cause: error },
          );
        }
        if (details.isSymbolicLink()) symlinkPaths.add(entryPath);
        else if (details.isDirectory()) pendingDirectories.push(entryPath);
      }
    }
  }
}

async function pathAliases(path: string): Promise<string[]> {
  const aliases = new Set<string>();
  const absolutePath = resolve(path);
  await traceSymlinkPaths(absolutePath, aliases, 0);
  aliases.add(await canonicalPath(absolutePath));
  return [...aliases];
}

async function traceSymlinkPaths(
  path: string,
  aliases: Set<string>,
  depth: number,
): Promise<void> {
  const absolutePath = resolve(path);
  aliases.add(absolutePath);
  if (depth > 40) {
    throw new Error(`Too many symlinks while checking path ${absolutePath}.`);
  }

  const root = parse(absolutePath).root;
  const segments = absolutePath.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const entryPath = join(current, segments[index]!);

    let details: Awaited<ReturnType<typeof lstat>>;
    try {
      details = await lstat(entryPath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const missingPath = join(current, ...segments.slice(index));
      aliases.add(missingPath);
      aliases.add(await canonicalPath(missingPath));
      return;
    }

    if (!details.isSymbolicLink()) {
      current = entryPath;
      continue;
    }

    const targetPath = resolve(dirname(entryPath), await readlink(entryPath));
    const replacementPath = join(targetPath, ...segments.slice(index + 1));
    await traceSymlinkPaths(replacementPath, aliases, depth + 1);
    aliases.add(replacementPath);
    return;
  }
  aliases.add(current);
}

function isPathWithinCaseSensitive(parent: string, target: string): boolean {
  const pathFromParent = relative(parent, target);
  return (
    pathFromParent === '' ||
    (pathFromParent !== '..' &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

function isPathWithinCaseInsensitive(parent: string, target: string): boolean {
  const parentParts = splitPath(parent);
  const targetParts = splitPath(target);
  if (normalizeCaseInsensitive(parentParts.root) !== normalizeCaseInsensitive(targetParts.root)) {
    return false;
  }
  if (parentParts.segments.length > targetParts.segments.length) return false;
  return parentParts.segments.every(
    (part, index) =>
      normalizeCaseInsensitive(part) === normalizeCaseInsensitive(targetParts.segments[index]!),
  );
}

function splitPath(path: string): { root: string; segments: string[] } {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  return {
    root,
    segments: absolute.slice(root.length).split(sep).filter(Boolean),
  };
}

function normalizeCaseInsensitive(value: string): string {
  return value.normalize('NFD').toLowerCase();
}

function commonPathPrefix(left: string, right: string): string {
  const leftParts = splitPath(left);
  const rightParts = splitPath(right);
  if (normalizeCaseInsensitive(leftParts.root) !== normalizeCaseInsensitive(rightParts.root)) {
    return leftParts.root;
  }

  let common = leftParts.root;
  const segmentCount = Math.min(leftParts.segments.length, rightParts.segments.length);
  for (let index = 0; index < segmentCount; index += 1) {
    const leftSegment = leftParts.segments[index]!;
    if (leftSegment !== rightParts.segments[index]) break;
    common = join(common, leftSegment);
  }
  return common;
}

async function deepestExistingDirectory(path: string): Promise<string> {
  let current = resolve(path);
  while (true) {
    try {
      const details = await stat(current);
      if (details.isDirectory()) return await realpath(current);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }

    const parent = dirname(current);
    if (parent === current) return await realpath(current);
    current = parent;
  }
}

/**
 * Probe existing directory entries without creating files. On a
 * case-insensitive volume, changing an ASCII letter in a directory entry still
 * resolves to the same directory inode. Climbing within the same device also
 * handles an empty `.ensemble` directory.
 */
async function detectCaseInsensitiveLookup(directory: string): Promise<boolean | undefined> {
  let current = directory;
  while (true) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const alternateName = toggleAsciiCase(entry.name);
      if (!alternateName) continue;

      try {
        const [original, alternate] = await Promise.all([
          lstat(join(current, entry.name)),
          lstat(join(current, alternateName)),
        ]);
        return (
          original.isDirectory() &&
          alternate.isDirectory() &&
          original.dev === alternate.dev &&
          original.ino === alternate.ino
        );
      } catch (error) {
        if (isMissingFile(error)) return false;
        throw error;
      }
    }

    const parent = dirname(current);
    if (parent === current) return undefined;
    const [currentDetails, parentDetails] = await Promise.all([stat(current), stat(parent)]);
    if (currentDetails.dev !== parentDetails.dev) return undefined;
    current = parent;
  }
}

function toggleAsciiCase(value: string): string | undefined {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character >= 'a' && character <= 'z') {
      return `${value.slice(0, index)}${character.toUpperCase()}${value.slice(index + 1)}`;
    }
    if (character >= 'A' && character <= 'Z') {
      return `${value.slice(0, index)}${character.toLowerCase()}${value.slice(index + 1)}`;
    }
  }
  return undefined;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
