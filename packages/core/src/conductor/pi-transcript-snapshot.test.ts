import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it, vi } from 'vitest';
import { readPiTranscriptSnapshot } from './pi-transcript-snapshot.js';
import { PiTranscriptValidationError } from './pi-conductor-session-file.js';
import { acquireSessionMigrationLock } from '../session/session-owner-lock.js';

it('does not resolve a workspace while rename holds the migration lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-snapshot-rename-'));
  vi.stubEnv('ENSEMBLE_USER_ROOT', root);
  try {
    const release = await acquireSessionMigrationLock(root);
    try {
      await expect(readPiTranscriptSnapshot({
        conductorAgentId: 'session', cwd: root, issueUrl: 'workspace://active',
      })).rejects.toThrow('Cannot start a workspace session');
    } finally {
      release();
    }
    expect(await readPiTranscriptSnapshot({
      conductorAgentId: 'session', cwd: root, issueUrl: 'workspace://active',
    })).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('returns only valid snapshots while a separate writer appends entries in pieces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-snapshot-writer-'));
  vi.stubEnv('ENSEMBLE_USER_ROOT', root);
  const dir = join(root, 'workspaces', 'active', 'pi');
  const file = join(dir, 'active-id.jsonl');
  const input = { conductorAgentId: 'active-id', cwd: root, issueUrl: 'workspace://active' };
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: 'active-id', cwd: root }) + '\n');
  const code = `
    const fs = require('node:fs');
    let i = 0;
    process.stdout.write('ready\\n');
    setInterval(() => {
      const line = JSON.stringify({ type: 'custom', id: String(++i), parentId: null, customType: 'test', data: {} }) + '\\n';
      fs.appendFileSync(process.argv[1], line.slice(0, 12));
      setTimeout(() => fs.appendFileSync(process.argv[1], line.slice(12)), 1);
    }, 5);
  `;
  const child = spawn(process.execPath, ['-e', code, file], { stdio: 'pipe' });
  try {
    const lines = createInterface({ input: child.stdout });
    await new Promise<void>((resolve, reject) => {
      lines.once('line', () => resolve());
      child.once('error', reject);
      child.once('exit', (status) => reject(new Error(`writer exited: ${status}`)));
    });
    lines.close();
    let successful = 0;
    for (let i = 0; i < 30; i++) {
      let snapshot: Awaited<ReturnType<typeof readPiTranscriptSnapshot>>;
      try {
        snapshot = await readPiTranscriptSnapshot(input);
      } catch (error) {
        // A live partial append or an observed change is intentionally rejected.
        expect(error).toBeInstanceOf(PiTranscriptValidationError);
        await new Promise((resolve) => setTimeout(resolve, 2));
        continue;
      }
      expect(snapshot).toBeDefined();
      if (snapshot) {
        const entries = snapshot!.contents.toString().trim().split('\n').map((line) => JSON.parse(line));
        expect(entries[0].id).toBe('active-id');
        const ids = entries.slice(1).map((entry) => entry.id);
        expect(new Set(ids).size).toBe(ids.length);
        successful++;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(successful).toBeGreaterThan(0);
  } finally {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
