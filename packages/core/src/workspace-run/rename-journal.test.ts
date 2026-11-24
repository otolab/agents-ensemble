import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireSessionMigrationReadLock } from '../session/session-owner-lock.js';
import { loadSessionResumeStore } from '../session/session-resume-store.js';
import { applyRenameJournal, prepareRenameJournal, publishRenameJournal, renameJournalPath, rollbackRenameJournal } from './rename-journal.js';
import { readWorkspaceAnchor, writeWorkspaceAnchor } from './slug-key.js';

const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rename-journal-')); temps.push(root);
  const userRoot = join(root, 'user'); const cwd = join(root, 'cwd');
  const source = join(userRoot, 'workspaces', 'old'); const target = join(userRoot, 'workspaces', 'new');
  await mkdir(source, { recursive: true }); await mkdir(cwd); await writeWorkspaceAnchor(cwd, 'old');
  for (const id of ['a', 'b']) {
    await writeFile(join(source, `${id}.json`), JSON.stringify({ version: 1, conductorAgentId: id, issueUrl: 'workspace://old', repoRoot: root, profile: { workers: [] }, openQuestions: [], sequence: 0, workers: { w: { acpSessionId: `worker-${id}`, generations: [{ acpSessionId: 'older', nextSessionId: `worker-${id}`, repoRoot: root, issueUrl: 'workspace://older', replacedAt: 1, reason: 'explicit' }] } }, updatedAt: 1 }));
  }
  const input = { userRoot, cwd, from: 'old', to: 'new' };
  return { root, userRoot, cwd, source, target, input };
}

describe('workspace rename journal', () => {
  it('migrates every store and retains the old worker origin and history', async () => {
    const f = await fixture(); const journal = await prepareRenameJournal(f.input);
    await publishRenameJournal(f.userRoot, journal); await applyRenameJournal(f.userRoot, journal);
    for (const id of ['a', 'b']) {
      const store = await loadSessionResumeStore(join(f.target, `${id}.json`));
      expect(store).toMatchObject({ version: 2, issueUrl: 'workspace://new', workers: { w: { acpSessionId: `worker-${id}`, issueUrl: 'workspace://old', repoRoot: f.root, recreateRequired: true, generations: [{ issueUrl: 'workspace://older' }] } } });
    }
    expect((await readWorkspaceAnchor(f.cwd))?.slug).toBe('new');
  });

  it.each(['published', 'first store', 'all stores', 'directory', 'anchor'])('recovers after interruption at %s', async (stage) => {
    const f = await fixture(); const journal = await prepareRenameJournal(f.input);
    await publishRenameJournal(f.userRoot, journal);
    await expect(acquireSessionMigrationReadLock(f.userRoot)).rejects.toThrow('workspace-rename-recover');
    const n = ['published', 'first store', 'all stores', 'directory', 'anchor'].indexOf(stage);
    if (n >= 1) await writeFile(join(f.source, journal.stores[0]!.name), journal.stores[0]!.after);
    if (n >= 2) await writeFile(join(f.source, journal.stores[1]!.name), journal.stores[1]!.after);
    if (n >= 3) await rename(f.source, f.target);
    if (n >= 4) await writeFile(join(f.cwd, '.ensemble', 'workspace.json'), journal.anchorAfter);
    await rollbackRenameJournal(f.userRoot);
    for (const store of journal.stores) expect(await readFile(join(f.source, store.name), 'utf8')).toBe(store.before);
    expect((await readWorkspaceAnchor(f.cwd))?.slug).toBe('old');
    const release = await acquireSessionMigrationReadLock(f.userRoot); release();
  });

  it('refuses recovery without touching data modified after interruption', async () => {
    const f = await fixture(); const journal = await prepareRenameJournal(f.input);
    await publishRenameJournal(f.userRoot, journal);
    await writeFile(join(f.source, 'b.json'), 'external edit');
    await expect(rollbackRenameJournal(f.userRoot)).rejects.toThrow('automatic recovery refused');
    expect(await readFile(join(f.source, 'a.json'), 'utf8')).toBe(journal.stores.find((s) => s.name === 'a.json')!.before);
    expect(await readFile(join(f.source, 'b.json'), 'utf8')).toBe('external edit');
  });

  it.each([
    'before corrupt',
    'after corrupt',
    'before identity',
    'after identity',
    'anchor before',
    'anchor after',
    'inventory',
    'duplicate inventory',
  ])('rejects invalid journal %s without changing any data', async (kind) => {
    const f = await fixture(); const journal = await prepareRenameJournal(f.input);
    await publishRenameJournal(f.userRoot, journal);
    // Exercise the reviewer's reproduction: the current store is the after snapshot.
    await writeFile(join(f.source, 'a.json'), journal.stores[0]!.after);
    const path = renameJournalPath(f.userRoot);
    const envelope = JSON.parse(await readFile(path, 'utf8'));
    const saved = envelope.journal;
    switch (kind) {
      case 'before corrupt': saved.stores[0].before = 'not-json'; break;
      case 'after corrupt': saved.stores[0].after = 'not-json'; break;
      case 'before identity': {
        const before = JSON.parse(saved.stores[0].before); before.issueUrl = 'workspace://other';
        saved.stores[0].before = JSON.stringify(before); break;
      }
      case 'after identity': {
        const after = JSON.parse(saved.stores[0].after); after.conductorAgentId = 'other';
        saved.stores[0].after = `${JSON.stringify(after, null, 2)}\n`; break;
      }
      case 'anchor before': saved.anchorBefore = '{"slug":"other"}'; break;
      case 'anchor after': saved.anchorAfter = '{"slug":"other"}'; break;
      case 'inventory': saved.stores.pop(); break;
      case 'duplicate inventory': saved.stores.push(saved.stores[0]); break;
    }
    // A valid checksum does not replace schema, identity, or inventory validation.
    envelope.sha256 = createHash('sha256').update(JSON.stringify(saved)).digest('hex');
    const damaged = JSON.stringify(envelope);
    await writeFile(path, damaged);
    const beforeA = await readFile(join(f.source, 'a.json'), 'utf8');
    const beforeB = await readFile(join(f.source, 'b.json'), 'utf8');
    const anchor = await readFile(join(f.cwd, '.ensemble', 'workspace.json'), 'utf8');
    await expect(rollbackRenameJournal(f.userRoot)).rejects.toThrow();
    expect(await readFile(join(f.source, 'a.json'), 'utf8')).toBe(beforeA);
    expect(await readFile(join(f.source, 'b.json'), 'utf8')).toBe(beforeB);
    expect(await readFile(join(f.cwd, '.ensemble', 'workspace.json'), 'utf8')).toBe(anchor);
    expect(await readFile(path, 'utf8')).toBe(damaged);
  });

  it('rejects a modified backup with an unchanged checksum', async () => {
    const f = await fixture(); const journal = await prepareRenameJournal(f.input);
    await publishRenameJournal(f.userRoot, journal);
    await writeFile(join(f.source, 'a.json'), journal.stores[0]!.after);
    const path = renameJournalPath(f.userRoot);
    const envelope = JSON.parse(await readFile(path, 'utf8'));
    envelope.journal.stores[0].before = 'not-json';
    const damaged = JSON.stringify(envelope);
    await writeFile(path, damaged);
    await expect(rollbackRenameJournal(f.userRoot)).rejects.toThrow('integrity check failed');
    expect(await readFile(join(f.source, 'a.json'), 'utf8')).toBe(journal.stores[0]!.after);
    expect(await readFile(path, 'utf8')).toBe(damaged);
  });

  it('preserves an older journal without a checksum for manual inspection', async () => {
    const f = await fixture(); const journal = await prepareRenameJournal(f.input);
    await publishRenameJournal(f.userRoot, journal);
    const path = renameJournalPath(f.userRoot);
    const legacy = JSON.stringify(journal);
    await writeFile(path, legacy);
    await expect(rollbackRenameJournal(f.userRoot)).rejects.toThrow('integrity check failed');
    expect(await readFile(path, 'utf8')).toBe(legacy);
    for (const entry of journal.stores) expect(await readFile(join(f.source, entry.name), 'utf8')).toBe(entry.before);
  });

  it('retries recovery after some original snapshots have already been restored', async () => {
    const f = await fixture(); const journal = await prepareRenameJournal(f.input);
    await publishRenameJournal(f.userRoot, journal);
    await writeFile(join(f.source, 'b.json'), journal.stores[1]!.after);
    await rollbackRenameJournal(f.userRoot);
    for (const entry of journal.stores) expect(await readFile(join(f.source, entry.name), 'utf8')).toBe(entry.before);
  });

  it('recovers a workspace that had no anchor before the rename', async () => {
    const f = await fixture();
    const anchor = join(f.cwd, '.ensemble', 'workspace.json');
    await rm(anchor);
    const journal = await prepareRenameJournal(f.input);
    await publishRenameJournal(f.userRoot, journal);
    for (const entry of journal.stores) await writeFile(join(f.source, entry.name), entry.after);
    await rename(f.source, f.target);
    await writeFile(anchor, journal.anchorAfter);
    await rollbackRenameJournal(f.userRoot);
    await expect(readFile(anchor, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    for (const entry of journal.stores) expect(await readFile(join(f.source, entry.name), 'utf8')).toBe(entry.before);
  });

  it('refuses an unsupported field and pending handoff before publishing anything', async () => {
    const f = await fixture(); const file = join(f.source, 'a.json');
    const store = JSON.parse(await readFile(file, 'utf8'));
    store.futureIdentity = 'unknown'; await writeFile(file, JSON.stringify(store));
    await expect(prepareRenameJournal(f.input)).rejects.toThrow('Unknown session store field');
    delete store.futureIdentity; store.workers.w.handoffPending = true; await writeFile(file, JSON.stringify(store));
    await expect(prepareRenameJournal(f.input)).rejects.toThrow('pending worker handoff');
    const release = await acquireSessionMigrationReadLock(f.userRoot); release();
  });
});
