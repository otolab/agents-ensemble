import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveEnsemblePaths } from '../ensemble-paths.js';

export const NOTE_MEMO_LIST_PREVIEW_CHARS = 300;

export interface WorkspaceMemoRecord {
  id: string;
  body: string;
  archived: boolean;
  createdAt: number;
}

export interface WorkspaceNoteRecord {
  id: string;
  summary: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  memos: WorkspaceMemoRecord[];
}

function notesDir(repoRoot: string, slugKey: string): string {
  return resolveEnsemblePaths({ repoRoot }).workspaceNotesDir(slugKey);
}

function notePath(repoRoot: string, slugKey: string, noteId: string): string {
  return join(notesDir(repoRoot, slugKey), `${noteId}.json`);
}

async function loadNoteFile(
  path: string,
): Promise<WorkspaceNoteRecord | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as WorkspaceNoteRecord;
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

async function saveNoteFile(
  path: string,
  note: WorkspaceNoteRecord,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(note, null, 2)}\n`, 'utf8');
}

export async function createWorkspaceNote(input: {
  repoRoot: string;
  slugKey: string;
  summary: string;
}): Promise<WorkspaceNoteRecord> {
  const summary = input.summary.trim();
  if (!summary) {
    throw new Error('Note summary is required.');
  }
  const now = Date.now();
  const note: WorkspaceNoteRecord = {
    id: randomUUID(),
    summary,
    archived: false,
    createdAt: now,
    updatedAt: now,
    memos: [],
  };
  await saveNoteFile(
    notePath(input.repoRoot, input.slugKey, note.id),
    note,
  );
  return note;
}

export async function pushWorkspaceMemo(input: {
  repoRoot: string;
  slugKey: string;
  noteId: string;
  body: string;
}): Promise<WorkspaceMemoRecord> {
  const body = input.body.trim();
  if (!body) {
    throw new Error('Memo body must be non-empty.');
  }
  const path = notePath(input.repoRoot, input.slugKey, input.noteId);
  const note = await loadNoteFile(path);
  if (!note) {
    throw new Error(`Note not found: ${input.noteId}`);
  }
  const memo: WorkspaceMemoRecord = {
    id: randomUUID(),
    body,
    archived: false,
    createdAt: Date.now(),
  };
  note.memos.push(memo);
  note.updatedAt = memo.createdAt;
  await saveNoteFile(path, note);
  return memo;
}

export async function readWorkspaceNote(input: {
  repoRoot: string;
  slugKey: string;
  noteId: string;
  includeHistory?: boolean;
  historyOffset?: number;
  historyLimit?: number;
}): Promise<{
  note: WorkspaceNoteRecord;
  memos: WorkspaceMemoRecord[];
}> {
  const path = notePath(input.repoRoot, input.slugKey, input.noteId);
  const note = await loadNoteFile(path);
  if (!note) {
    throw new Error(`Note not found: ${input.noteId}`);
  }
  const activeMemos = note.memos.filter((memo) => !memo.archived);
  if (input.includeHistory) {
    const offset = Math.max(0, input.historyOffset ?? 0);
    const limit = Math.min(100, Math.max(1, input.historyLimit ?? 20));
    return {
      note,
      memos: activeMemos.slice(offset, offset + limit),
    };
  }
  const latest = activeMemos.at(-1);
  return { note, memos: latest ? [latest] : [] };
}

export async function listWorkspaceNotes(input: {
  repoRoot: string;
  slugKey: string;
  includeArchived?: boolean;
  offset?: number;
  limit?: number;
}): Promise<{
  total: number;
  items: Array<{
    id: string;
    summary: string;
    archived: boolean;
    updatedAt: number;
    latestMemoPreview: string;
  }>;
}> {
  const dir = notesDir(input.repoRoot, input.slugKey);
  let files: string[];
  try {
    const entries = await readdir(dir);
    files = entries.filter((name) => name.endsWith('.json'));
  } catch (error) {
    if (isEnoent(error)) {
      return { total: 0, items: [] };
    }
    throw error;
  }
  const notes: WorkspaceNoteRecord[] = [];
  for (const file of files) {
    const note = await loadNoteFile(join(dir, file));
    if (!note) continue;
    if (!input.includeArchived && note.archived) continue;
    notes.push(note);
  }
  notes.sort((left, right) => right.updatedAt - left.updatedAt);
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.min(50, Math.max(1, input.limit ?? 20));
  const slice = notes.slice(offset, offset + limit);
  return {
    total: notes.length,
    items: slice.map((note) => {
      const latest = note.memos.filter((m) => !m.archived).at(-1);
      const preview = latest
        ? latest.body.slice(0, NOTE_MEMO_LIST_PREVIEW_CHARS)
        : '';
      return {
        id: note.id,
        summary: note.summary,
        archived: note.archived,
        updatedAt: note.updatedAt,
        latestMemoPreview: preview,
      };
    }),
  };
}

export async function archiveWorkspaceNote(input: {
  repoRoot: string;
  slugKey: string;
  noteId: string;
  archived: boolean;
}): Promise<void> {
  const path = notePath(input.repoRoot, input.slugKey, input.noteId);
  const note = await loadNoteFile(path);
  if (!note) throw new Error(`Note not found: ${input.noteId}`);
  note.archived = input.archived;
  note.updatedAt = Date.now();
  await saveNoteFile(path, note);
}

export async function archiveWorkspaceMemo(input: {
  repoRoot: string;
  slugKey: string;
  noteId: string;
  memoId: string;
  archived: boolean;
}): Promise<void> {
  const path = notePath(input.repoRoot, input.slugKey, input.noteId);
  const note = await loadNoteFile(path);
  if (!note) throw new Error(`Note not found: ${input.noteId}`);
  const memo = note.memos.find((entry) => entry.id === input.memoId);
  if (!memo) throw new Error(`Memo not found: ${input.memoId}`);
  memo.archived = input.archived;
  note.updatedAt = Date.now();
  await saveNoteFile(path, note);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}