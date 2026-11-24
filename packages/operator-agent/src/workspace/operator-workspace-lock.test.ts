import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withOperatorWorkspaceLock } from './operator-workspace-lock.js';

describe('operator workspace lock', () => {
  it('serializes separate callers in the same process', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'workspace-lock-'));
    const root = join(parent, 'profile');
    await mkdir(root);
    try {
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => { entered = resolve; });
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const first = withOperatorWorkspaceLock(root, async () => { entered(); await barrier; });
      await held;
      let secondEntered = false;
      const second = withOperatorWorkspaceLock(root, async () => { secondEntered = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(secondEntered).toBe(false);
      release();
      await Promise.all([first, second]);
      expect(secondEntered).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
  it('waits for another process and acquires after it is killed', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'workspace-lock-process-'));
    const root = join(parent, 'profile');
    await mkdir(root);
    const id = createHash('sha256').update(root).digest('hex');
    const dbPath = join(parent, `.ensemble-workspace-lock-${id}.sqlite`);
    const child = spawn(process.execPath, ['-e', `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked'); setInterval(() => {}, 1000);`, dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await once(child.stdout, 'data');
      let acquired = false;
      const pending = withOperatorWorkspaceLock(root, async () => { acquired = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(acquired).toBe(false);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      await pending;
      expect(acquired).toBe(true);
    } finally {
      child.kill('SIGKILL');
      await rm(parent, { recursive: true, force: true });
    }
  });

});
