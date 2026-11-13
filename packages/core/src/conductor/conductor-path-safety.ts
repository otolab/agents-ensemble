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
