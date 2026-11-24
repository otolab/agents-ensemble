import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { lock } from 'proper-lockfile';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import { acquireSessionMigrationLock } from '../session/session-owner-lock.js';
import { applyRenameJournal, assertNoRenameJournal, prepareRenameJournal, publishRenameJournal, rollbackRenameJournal } from './rename-journal.js';

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
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ slug: slugKey }, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
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
    const anchor = await readWorkspaceAnchor(input.cwd);
    if (anchor && anchor.slug !== input.explicitName) {
      throw new Error(`Workspace is already anchored to "${anchor.slug}".`);
    }
    if (!anchor) await writeWorkspaceAnchor(input.cwd, input.explicitName);
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
  const toDir = paths.workspaceSlugDir(input.toSlug);
  const releaseMigration = await acquireSessionMigrationLock(paths.userRoot);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(paths.workspacesRoot, { realpath: false });
    await assertNoRenameJournal(paths.userRoot);
    const anchor = await readWorkspaceAnchor(input.cwd);
    if (anchor && anchor.slug !== input.fromSlug) {
      throw new Error(`Workspace is anchored to "${anchor.slug}", not "${input.fromSlug}".`);
    }
    if (await pathExists(toDir)) {
      throw new Error(`workspace slug "${input.toSlug}" already exists; rename aborted.`);
    }
    const journal = await prepareRenameJournal({
      userRoot: paths.userRoot, cwd: input.cwd, from: input.fromSlug, to: input.toSlug,
    });
    await publishRenameJournal(paths.userRoot, journal);
    try {
      await applyRenameJournal(paths.userRoot, journal);
    } catch (error) {
      try {
        await rollbackRenameJournal(paths.userRoot);
      } catch (rollbackError) {
        throw new Error(
          `Workspace rename failed (${String(error)}); rollback failed (${String(rollbackError)}). ` +
          'Stop workspace operations and run ensemble workspace-rename-recover.',
        );
      }
      throw new Error(`Workspace rename failed; changes were rolled back: ${String(error)}`);
    }
  } finally {
    try {
      await release?.();
    } finally {
      releaseMigration();
    }
  }
}

/** Roll back a rename interrupted after its recovery journal was published. */
export async function recoverWorkspaceRename(input: {
  repoRoot: string;
  home?: string;
  userEnsembleRoot?: string;
}): Promise<void> {
  const paths = resolveEnsemblePaths(input);
  const releaseMigration = await acquireSessionMigrationLock(paths.userRoot);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(paths.workspacesRoot, { realpath: false });
    await rollbackRenameJournal(paths.userRoot);
  } finally {
    try { await release?.(); } finally { releaseMigration(); }
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}
