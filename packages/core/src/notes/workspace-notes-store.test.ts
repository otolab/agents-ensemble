import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceNote,
  listWorkspaceNotes,
  pushWorkspaceMemo,
  readWorkspaceNote,
  archiveWorkspaceMemo,
  archiveWorkspaceNote,
} from './workspace-notes-store.js';

describe('workspace notes store', () => {
  const temps: string[] = [];

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    vi.unstubAllEnvs();
  });

  it('requires summary and appends memos', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-notes-'));
    temps.push(repoRoot);
    vi.stubEnv('HOME', repoRoot);
    const slug = `test-${randomUUID().slice(0, 8)}`;
    const note = await createWorkspaceNote({
      repoRoot,
      slugKey: slug,
      summary: 'Investigation log',
    });
    await pushWorkspaceMemo({
      repoRoot,
      slugKey: slug,
      noteId: note.id,
      body: 'First finding',
    });
    await pushWorkspaceMemo({
      repoRoot,
      slugKey: slug,
      noteId: note.id,
      body: 'Second finding',
    });
    const page = await listWorkspaceNotes({ repoRoot, slugKey: slug });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.latestMemoPreview).toBe('Second finding');
    const read = await readWorkspaceNote({
      repoRoot,
      slugKey: slug,
      noteId: note.id,
    });
    expect(read.memos).toHaveLength(1);
    expect(read.memos[0]!.body).toBe('Second finding');
  });

  it('preserves concurrent updates and pages archived history without leaking it', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-notes-'));
    temps.push(repoRoot);
    vi.stubEnv('HOME', repoRoot);
    const slugKey = `test-${randomUUID()}`;
    const note = await createWorkspaceNote({ repoRoot, slugKey, summary: 'History' });
    const memos = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      pushWorkspaceMemo({ repoRoot, slugKey, noteId: note.id, body: `memo ${i}` }),
    ));
    await archiveWorkspaceMemo({ repoRoot, slugKey, noteId: note.id, memoId: memos[0]!.id, archived: true });
    const current = await readWorkspaceNote({ repoRoot, slugKey, noteId: note.id });
    expect(current.memos).toHaveLength(1);
    expect(current.note).not.toHaveProperty('memos');
    const first = await readWorkspaceNote({ repoRoot, slugKey, noteId: note.id, includeHistory: true, includeArchived: true, historyLimit: 5 });
    const rest = await readWorkspaceNote({ repoRoot, slugKey, noteId: note.id, includeHistory: true, includeArchived: true, historyOffset: 5, historyLimit: 20 });
    expect([...first.memos, ...rest.memos]).toHaveLength(12);
    expect([...first.memos, ...rest.memos].find((memo) => memo.id === memos[0]!.id)?.archived).toBe(true);
    await archiveWorkspaceNote({ repoRoot, slugKey, noteId: note.id, archived: true });
    expect((await listWorkspaceNotes({ repoRoot, slugKey })).total).toBe(0);
    expect((await readWorkspaceNote({ repoRoot, slugKey, noteId: note.id })).note.archived).toBe(true);
  });
});
