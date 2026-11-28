import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { maintainOperatorWorkspace } from './operator-workspace-maintenance.js';
import { withOperatorWorkspaceLock } from './operator-workspace-lock.js';
import { workspaceMoveJournalPath } from './operator-workspace-tools.js';

describe('workspace maintenance', () => {
  it('retains the journal on failure and excludes cooperating operations until confirmed', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'workspace-maintenance-'));
    const previous = process.env.ENSEMBLE_USER_ROOT;
    process.env.ENSEMBLE_USER_ROOT = parent;
    const path = join(parent, 'operator-agents', 'test');
    await mkdir(path, { recursive: true });
    const root = await realpath(path);
    const journal = workspaceMoveJournalPath(root);
    await writeFile(journal, 'unreadable journal');
    try {
      await expect(maintainOperatorWorkspace('test', async () => { throw new Error('interrupted'); })).rejects.toThrow('interrupted');
      expect(await readFile(journal, 'utf8')).toBe('unreadable journal');
      let started!: () => void;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { started = resolve; });
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const maintenance = maintainOperatorWorkspace('test', async (status) => {
        expect(status.status).toBe('journal_unreadable');
        started();
        await barrier;
        return true;
      });
      await held;
      let acquired = false;
      const contender = withOperatorWorkspaceLock(root, async () => { acquired = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(acquired).toBe(false);
      release();
      await Promise.all([maintenance, contender]);
      expect(acquired).toBe(true);
      await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previous === undefined) delete process.env.ENSEMBLE_USER_ROOT;
      else process.env.ENSEMBLE_USER_ROOT = previous;
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('maintains the workspace selected by an explicit config path', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'workspace-maintenance-config-'));
    const previous = process.env.ENSEMBLE_USER_ROOT;
    process.env.ENSEMBLE_USER_ROOT = parent;
    const configPath = join(parent, 'alternate.yaml');
    await writeFile(configPath, 'version: 1\n');
    const scope = createHash('sha256')
      .update(await realpath(configPath))
      .digest('hex');
    const alternate = join(
      parent,
      'operator-agents',
      '.config-scopes',
      scope,
      'test',
    );
    const legacy = join(parent, 'operator-agents', 'test');
    await mkdir(alternate, { recursive: true });
    await mkdir(legacy, { recursive: true });
    const alternateJournal = workspaceMoveJournalPath(await realpath(alternate));
    const legacyJournal = workspaceMoveJournalPath(await realpath(legacy));
    await writeFile(alternateJournal, 'alternate journal');
    await writeFile(legacyJournal, 'legacy journal');
    try {
      await maintainOperatorWorkspace(
        'test',
        async (status) => status.status === 'journal_unreadable',
        { configPath },
      );
      await expect(readFile(alternateJournal)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(legacyJournal, 'utf8')).resolves.toBe(
        'legacy journal',
      );
    } finally {
      if (previous === undefined) delete process.env.ENSEMBLE_USER_ROOT;
      else process.env.ENSEMBLE_USER_ROOT = previous;
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('retains the journal if the maintenance process is killed', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'workspace-maintenance-kill-'));
    const path = join(parent, 'operator-agents', 'test');
    await mkdir(path, { recursive: true });
    const root = await realpath(path);
    const journal = workspaceMoveJournalPath(root);
    await writeFile(journal, 'unreadable journal');
    const moduleUrl = new URL('../../dist/workspace/operator-workspace-maintenance.js', import.meta.url).href;
    const script = `import { maintainOperatorWorkspace } from ${JSON.stringify(moduleUrl)}; await maintainOperatorWorkspace('test', async () => { console.log('locked'); await new Promise(() => {}); return true; });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ENSEMBLE_USER_ROOT: parent }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await once(child.stdout, 'data');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      expect(await readFile(journal, 'utf8')).toBe('unreadable journal');
      await withOperatorWorkspaceLock(root, async () => undefined);
    } finally {
      child.kill('SIGKILL');
      await rm(parent, { recursive: true, force: true });
    }
  });

});
