import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({ failRename: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (faults.failRename) throw new Error('simulated rename failure');
      return actual.rename(...args);
    },
  };
});

import { createWorkspaceNote, pushWorkspaceMemo, readWorkspaceNote } from './workspace-notes-store.js';

let root = '';
afterEach(async () => {
  faults.failRename = false;
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it('keeps committed history readable after a failed atomic replacement', async () => {
  root = await mkdtemp(join(tmpdir(), 'ensemble-notes-failure-'));
  vi.stubEnv('HOME', root);
  const scope = { repoRoot: root, slugKey: 'test' };
  const note = await createWorkspaceNote({ ...scope, summary: 'History' });
  await pushWorkspaceMemo({ ...scope, noteId: note.id, body: 'committed' });
  faults.failRename = true;
  await expect(pushWorkspaceMemo({ ...scope, noteId: note.id, body: 'failed' }))
    .rejects.toThrow('simulated rename failure');
  faults.failRename = false;
  const result = await readWorkspaceNote({ ...scope, noteId: note.id, includeHistory: true });
  expect(result.memos.map((memo) => memo.body)).toEqual(['committed']);
  await pushWorkspaceMemo({ ...scope, noteId: note.id, body: 'retry' });
  expect((await readWorkspaceNote({ ...scope, noteId: note.id })).memos[0]?.body).toBe('retry');
});
