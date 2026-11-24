import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { acquireSessionOwnerLock } from './session-owner-lock.js';

it.skipIf(process.platform === 'win32')('excludes another process while stopped and releases ownership after death', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ensemble-owner-lock-'));
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout=0');
    try { db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked\\n'); }
    catch { process.stdout.write('busy\\n'); process.exit(2); }
    process.stdin.resume();
  `;
  let owner: ChildProcessWithoutNullStreams | undefined;
  try {
    // Create the same database with the production acquisition path.
    const release = await acquireSessionOwnerLock('same-session', root);
    const { createHash } = await import('node:crypto');
    const key = createHash('sha256').update('same-session').digest('hex');
    const path = join(root, 'session-locks', `${key}.sqlite`);
    release();
    const start = async () => {
      const child = spawn(process.execPath, ['-e', script, path], { stdio: 'pipe' });
      const lines = createInterface({ input: child.stdout });
      const [line] = await new Promise<[string]>((resolve) => lines.once('line', (value) => resolve([value])));
      lines.close();
      return { child, line };
    };
    const first = await start();
    owner = first.child;
    expect(first.line).toBe('locked');
    owner.kill('SIGSTOP');
    await expect(acquireSessionOwnerLock('same-session', root)).rejects.toThrow('another process');
    const other = await acquireSessionOwnerLock('different-session', root);
    other();
    owner.kill('SIGCONT');
    await expect(acquireSessionOwnerLock('same-session', root)).rejects.toThrow('another process');
    const exited = new Promise<void>((resolve) => owner!.once('exit', () => resolve()));
    owner.kill('SIGKILL');
    await exited;
    owner = undefined;
    const after = await acquireSessionOwnerLock('same-session', root);
    after();
  } finally {
    owner?.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
