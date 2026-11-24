import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lock } from 'proper-lockfile';
import { acquireSessionMigrationReadLock } from '../session/session-owner-lock.js';
const failures = vi.hoisted(() => ({ anchor: false, rollback: false, store: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (failures.anchor && to.endsWith('workspace.json')) throw new Error('anchor failure');
      if (failures.rollback && basename(from) === 'new' && basename(to) === 'old') throw new Error('rollback failure');
      if (failures.store && to.endsWith('/b.json')) throw new Error('store failure');
      return actual.rename(from, to);
    },
  };
});
import {
  defaultSlugKeyFromCwd,
  readWorkspaceAnchor,
  recoverWorkspaceRename,
  resolveWorkspaceSlugKey,
  renameWorkspaceSlug,
  writeWorkspaceAnchor,
  workspaceSessionUrl,
} from './index.js';
import { parseWorkspaceSessionUrl } from './session-url.js';

describe('workspace slug-key', () => {
  const temps: string[] = [];

  afterEach(async () => {
    failures.anchor = false;
    failures.rollback = false;
    failures.store = false;
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'ensemble-rename-'));
    temps.push(root);
    const workspaces = join(root, 'user', 'workspaces');
    const cwd = join(root, 'cwd');
    await mkdir(join(workspaces, 'old'), { recursive: true });
    await mkdir(cwd);
    await writeFile(join(workspaces, 'old', 'data'), 'original');
    await writeWorkspaceAnchor(cwd, 'old');
    return { root, workspaces, cwd, input: { repoRoot: root, cwd, userEnsembleRoot: join(root, 'user'), fromSlug: 'old', toSlug: 'new' } };
  }

  it('moves the workspace and synchronizes the anchor', async () => {
    const { input, cwd, workspaces } = await fixture();
    await renameWorkspaceSlug(input);
    expect(await readFile(join(workspaces, 'new', 'data'), 'utf8')).toBe('original');
    expect((await readWorkspaceAnchor(cwd))?.slug).toBe('new');
  });

  it('refuses an invalid session store before changing the workspace', async () => {
    const { input, cwd, workspaces } = await fixture();
    const saved = join(workspaces, 'old', 'session.json');
    await writeFile(saved, '{"issueUrl":"workspace://old"}');
    await expect(renameWorkspaceSlug(input)).rejects.toThrow('Invalid session resume store');
    expect(await readFile(saved, 'utf8')).toBe('{"issueUrl":"workspace://old"}');
    expect((await readWorkspaceAnchor(cwd))?.slug).toBe('old');
  });

  it('restores earlier stores when a later store update fails', async () => {
    const { input, cwd, workspaces } = await fixture();
    const dir = join(workspaces, 'old');
    const store = (id: string) => JSON.stringify({
      version: 1, conductorAgentId: id, issueUrl: 'workspace://old', repoRoot: input.repoRoot,
      profile: { workers: [] }, openQuestions: [], sequence: 0, workers: {}, updatedAt: 1,
    });
    await writeFile(join(dir, 'a.json'), store('a'));
    await writeFile(join(dir, 'b.json'), store('b'));
    failures.store = true;
    await expect(renameWorkspaceSlug(input)).rejects.toThrow('rolled back');
    expect(await readFile(join(dir, 'a.json'), 'utf8')).toBe(store('a'));
    expect(await readFile(join(dir, 'b.json'), 'utf8')).toBe(store('b'));
    expect((await readWorkspaceAnchor(cwd))?.slug).toBe('old');
  });

  it.each([false, true])('rejects an existing destination (nonempty: %s)', async (nonempty) => {
    const { input, cwd, workspaces } = await fixture();
    await mkdir(join(workspaces, 'new'));
    if (nonempty) await writeFile(join(workspaces, 'new', 'data'), 'existing');
    await expect(renameWorkspaceSlug(input)).rejects.toThrow('already exists');
    expect(await readFile(join(workspaces, 'old', 'data'), 'utf8')).toBe('original');
    expect((await readWorkspaceAnchor(cwd))?.slug).toBe('old');
    if (nonempty) expect(await readFile(join(workspaces, 'new', 'data'), 'utf8')).toBe('existing');
  });

  it('rolls back the move when anchor update fails', async () => {
    const { input, cwd, workspaces } = await fixture();
    failures.anchor = true;
    await expect(renameWorkspaceSlug(input)).rejects.toThrow('rolled back');
    expect(await readFile(join(workspaces, 'old', 'data'), 'utf8')).toBe('original');
    expect((await readWorkspaceAnchor(cwd))?.slug).toBe('old');
  });

  it('reports paths and recovery advice when rollback also fails', async () => {
    const { input, cwd, workspaces } = await fixture();
    failures.anchor = true;
    failures.rollback = true;
    await expect(renameWorkspaceSlug(input)).rejects.toThrow(/rollback failed.*Stop workspace operations/su);
    expect(await readFile(join(workspaces, 'new', 'data'), 'utf8')).toBe('original');
    expect((await readWorkspaceAnchor(cwd))?.slug).toBe('old');
    await expect(acquireSessionMigrationReadLock(input.userEnsembleRoot)).rejects.toThrow('workspace-rename-recover');
    failures.anchor = false;
    failures.rollback = false;
    await recoverWorkspaceRename(input);
    expect(await readFile(join(workspaces, 'old', 'data'), 'utf8')).toBe('original');
  });

  it('refuses another cooperative rename while the lock is held', async () => {
    const { input, workspaces } = await fixture();
    const release = await lock(workspaces, { realpath: false });
    try {
      await expect(renameWorkspaceSlug(input)).rejects.toThrow();
      expect(await readFile(join(workspaces, 'old', 'data'), 'utf8')).toBe('original');
    } finally {
      await release();
    }
  });

  it('rejects rename while a session is resolving its workspace', async () => {
    const { input, cwd, workspaces } = await fixture();
    const release = await acquireSessionMigrationReadLock(input.userEnsembleRoot);
    try {
      await expect(renameWorkspaceSlug(input)).rejects.toThrow('Stop active sessions');
      expect(await readFile(join(workspaces, 'old', 'data'), 'utf8')).toBe('original');
      expect((await readWorkspaceAnchor(cwd))?.slug).toBe('old');
    } finally {
      release();
    }
  });

  it('derives stable hash slug from cwd', () => {
    const cwd = '/tmp/example-project';
    const a = defaultSlugKeyFromCwd(cwd);
    const b = defaultSlugKeyFromCwd(cwd + '/');
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it('writes and reads workspace anchor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ensemble-ws-'));
    temps.push(root);
    const slug = await resolveWorkspaceSlugKey({ cwd: root });
    const anchor = await readWorkspaceAnchor(root);
    expect(anchor?.slug).toBe(slug);
    const url = workspaceSessionUrl(slug);
    expect(parseWorkspaceSessionUrl(url)?.slugKey).toBe(slug);
  });

  it('persists explicit names and rejects replacing another anchor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ensemble-ws-'));
    temps.push(root);
    expect(await resolveWorkspaceSlugKey({ cwd: root, explicitName: 'named' })).toBe('named');
    expect(await resolveWorkspaceSlugKey({ cwd: root })).toBe('named');
    await expect(resolveWorkspaceSlugKey({ cwd: root, explicitName: 'other' })).rejects.toThrow('already anchored');
    expect((await readWorkspaceAnchor(root))?.slug).toBe('named');
  });
});
