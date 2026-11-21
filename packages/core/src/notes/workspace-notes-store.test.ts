import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkspaceNote,
  listWorkspaceNotes,
  pushWorkspaceMemo,
  readWorkspaceNote,
} from './workspace-notes-store.js';

describe('workspace notes store', () => {
  const temps: string[] = [];

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('requires summary and appends memos', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-notes-'));
    temps.push(repoRoot);
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
});