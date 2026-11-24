import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceNote,
  NOTE_MEMO_MAX_BYTES,
  listWorkspaceNotes,
  pushWorkspaceMemo,
  readWorkspaceNote,
  archiveWorkspaceMemo,
  archiveWorkspaceNote,
} from './workspace-notes-store.js';
import { createWorkspaceNotesTools } from './workspace-notes-tools.js';

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

  it('enforces the UTF-8 byte limit through the store and conductor tool', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-notes-'));
    temps.push(repoRoot);
    vi.stubEnv('HOME', repoRoot);
    vi.stubEnv('ENSEMBLE_USER_ROOT', join(repoRoot, 'user'));
    const scope = { repoRoot, slugKey: 'size' };
    const note = await createWorkspaceNote({ ...scope, summary: 'limit' });
    await pushWorkspaceMemo({ ...scope, noteId: note.id, body: 'é'.repeat(NOTE_MEMO_MAX_BYTES / 2) });
    const body = 'é'.repeat(NOTE_MEMO_MAX_BYTES / 2 + 1);
    await expect(pushWorkspaceMemo({ ...scope, noteId: note.id, body })).rejects.toThrow('exceeds');
    const tools = createWorkspaceNotesTools(scope);
    await expect(tools.push_memo!.execute({ noteId: note.id, body })).rejects.toThrow('exceeds');
  });

  it('caps note and history page sizes', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-notes-'));
    temps.push(repoRoot);
    vi.stubEnv('ENSEMBLE_USER_ROOT', join(repoRoot, 'user'));
    const scope = { repoRoot, slugKey: 'pages' };
    const notes = await Promise.all(Array.from({ length: 51 }, (_, i) => createWorkspaceNote({ ...scope, summary: `note ${i}` })));
    for (let i = 0; i < 101; i++) {
      await pushWorkspaceMemo({ ...scope, noteId: notes[0]!.id, body: `memo ${i}` });
    }
    expect((await listWorkspaceNotes({ ...scope, limit: 1000 })).items).toHaveLength(50);
    expect((await readWorkspaceNote({ ...scope, noteId: notes[0]!.id, includeHistory: true, historyLimit: 1000 })).memos).toHaveLength(100);
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

  it('rejects path-like and malformed note IDs before reading or updating another workspace', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-note-boundary-'));
    temps.push(repoRoot);
    vi.stubEnv('HOME', repoRoot);
    const other = await createWorkspaceNote({ repoRoot, slugKey: 'other', summary: 'private' });
    const original = await pushWorkspaceMemo({
      repoRoot, slugKey: 'other', noteId: other.id, body: 'original',
    });
    const scope = { repoRoot, slugKey: 'current' };
    await createWorkspaceNote({ ...scope, summary: 'current' });
    const tools = createWorkspaceNotesTools(scope);
    const badIds = [
      `../../other/notes/${other.id}`,
      `..\\..\\other\\notes\\${other.id}`,
      `/other/notes/${other.id}`,
      `${other.id}/..`,
      `${other.id}.json`,
      other.id.toUpperCase(),
      '', '.', '..', 'a'.repeat(500), '00000000-0000-0000-0000-000000000000',
    ];
    for (const noteId of badIds) {
      await expect(readWorkspaceNote({ ...scope, noteId })).rejects.toThrow('Invalid note ID');
      await expect(pushWorkspaceMemo({ ...scope, noteId, body: 'tampered' })).rejects.toThrow('Invalid note ID');
      await expect(archiveWorkspaceNote({ ...scope, noteId, archived: true })).rejects.toThrow('Invalid note ID');
      await expect(archiveWorkspaceMemo({ ...scope, noteId, memoId: original.id, archived: true })).rejects.toThrow('Invalid note ID');
      await expect(tools.read_note!.execute({ noteId })).rejects.toThrow('Invalid note ID');
      await expect(tools.push_memo!.execute({ noteId, body: 'tampered' })).rejects.toThrow('Invalid note ID');
      await expect(tools.archive_note!.execute({ noteId, archived: true })).rejects.toThrow('Invalid note ID');
      await expect(tools.archive_memo!.execute({ noteId, memoId: original.id, archived: true })).rejects.toThrow('Invalid note ID');
    }
    await expect(readWorkspaceNote({ ...scope, noteId: other.id })).rejects.toThrow('Note not found');
    await expect(pushWorkspaceMemo({ ...scope, noteId: other.id, body: 'tampered' })).rejects.toThrow('Note not found');
    await expect(archiveWorkspaceNote({ ...scope, noteId: other.id, archived: true })).rejects.toThrow('Note not found');
    await expect(archiveWorkspaceMemo({ ...scope, noteId: other.id, memoId: original.id, archived: true })).rejects.toThrow('Note not found');
    const preserved = await readWorkspaceNote({ repoRoot, slugKey: 'other', noteId: other.id });
    expect(preserved.note.archived).toBe(false);
    expect(preserved.memos).toMatchObject([{ id: original.id, body: 'original', archived: false }]);
  });
});
