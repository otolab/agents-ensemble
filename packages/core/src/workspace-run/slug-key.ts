import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { resolveEnsemblePaths } from '../ensemble-paths.js';

export const SLUG_KEY_HASH_LENGTH = 16;
export const SLUG_KEY_MAX_LENGTH = 64;
const SLUG_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;

export interface WorkspaceAnchorFile {
  slug: string;
}

const WORKSPACE_ANCHOR_FILENAME = 'workspace.json';

export function workspaceAnchorRelativePath(): string {
  return join('.ensemble', WORKSPACE_ANCHOR_FILENAME);
}

export function workspaceAnchorPath(cwd: string): string {
  return join(resolve(cwd), workspaceAnchorRelativePath());
}

export function assertValidSlugKey(slugKey: string): void {
  if (typeof slugKey !== 'string' || !slugKey.trim()) {
    throw new Error('slug-key must be a non-empty string.');
  }
  if (slugKey.length > SLUG_KEY_MAX_LENGTH) {
    throw new Error(
      `slug-key exceeds ${SLUG_KEY_MAX_LENGTH} characters: ${slugKey}`,
    );
  }
  if (!SLUG_KEY_RE.test(slugKey)) {
    throw new Error(
      `Invalid slug-key "${slugKey}" (use letters, digits, _ and -; must start with alphanumeric).`,
    );
  }
}

export function normalizeWorkspaceCwd(cwd: string): string {
  return normalize(resolve(cwd));
}

/** Default slug-key from absolute cwd (ADR 0085: unnamed workspace). */
export function defaultSlugKeyFromCwd(cwd: string): string {
  const normalized = normalizeWorkspaceCwd(cwd);
  return createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, SLUG_KEY_HASH_LENGTH);
}

export function workspaceSyntheticIssueNumber(slugKey: string): number {
  const digest = createHash('sha256').update(slugKey).digest();
  const raw = digest.readUInt32BE(0);
  return (raw % 2_000_000_000) + 1;
}

export async function readWorkspaceAnchor(
  cwd: string,
): Promise<WorkspaceAnchorFile | undefined> {
  const path = workspaceAnchorPath(cwd);
  try {
    const raw = await readFile(path, 'utf8');
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object') {
      throw new Error('workspace anchor is not an object');
    }
    const slug = (value as WorkspaceAnchorFile).slug;
    if (typeof slug !== 'string' || !slug.trim()) {
      throw new Error('workspace anchor slug is missing');
    }
    assertValidSlugKey(slug);
    return { slug };
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

export async function writeWorkspaceAnchor(
  cwd: string,
  slugKey: string,
): Promise<void> {
  assertValidSlugKey(slugKey);
  const path = workspaceAnchorPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ slug: slugKey }, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'w',
  });
}

/**
 * Resolve slug-key for a new or continued run: anchor file wins, else hash of cwd.
 */
export async function resolveWorkspaceSlugKey(input: {
  cwd: string;
  explicitName?: string;
}): Promise<string> {
  if (input.explicitName !== undefined) {
    assertValidSlugKey(input.explicitName);
    return input.explicitName;
  }
  const anchor = await readWorkspaceAnchor(input.cwd);
  if (anchor) {
    return anchor.slug;
  }
  const slugKey = defaultSlugKeyFromCwd(input.cwd);
  await writeWorkspaceAnchor(input.cwd, slugKey);
  return slugKey;
}

export async function renameWorkspaceSlug(input: {
  repoRoot: string;
  cwd: string;
  fromSlug: string;
  toSlug: string;
  home?: string;
  userEnsembleRoot?: string;
}): Promise<void> {
  assertValidSlugKey(input.fromSlug);
  assertValidSlugKey(input.toSlug);
  if (input.fromSlug === input.toSlug) {
    throw new Error('slug-key rename requires different source and destination.');
  }
  const paths = resolveEnsemblePaths({
    repoRoot: input.repoRoot,
    ...(input.home !== undefined ? { home: input.home } : {}),
    ...(input.userEnsembleRoot !== undefined
      ? { userEnsembleRoot: input.userEnsembleRoot }
      : {}),
  });
  const fromDir = paths.workspaceSlugDir(input.fromSlug);
  const toDir = paths.workspaceSlugDir(input.toSlug);
  try {
    await rename(fromDir, toDir);
  } catch (error) {
    if (isEexist(error)) {
      throw new Error(
        `workspace slug "${input.toSlug}" already exists; rename aborted.`,
      );
    }
    throw error;
  }
  await writeWorkspaceAnchor(input.cwd, input.toSlug);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function isEexist(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'EEXIST'
  );
}