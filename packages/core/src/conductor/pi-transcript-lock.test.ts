import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { withPiTranscriptPointerLock, type LockedPiTranscriptPointer } from './pi-transcript-lock.js';

const id = 'lock-test';
const cwd = '/project';
const first = 'a'.repeat(32);
const second = 'b'.repeat(32);

it.skipIf(process.platform === 'win32')('excludes a separate process and recovers its interrupted transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-pointer-lock-'));
  const sessionDir = join(root, 'sessions');
  const input = { sessionDir, conductorAgentId: id, cwds: [cwd] };
  const key = createHash('sha256').update(id).digest('hex');
  const store = join(sessionDir, '.ensemble-transcripts', key);
  const dbPath = join(root, 'session-locks', `pi-transcript-${key}.sqlite`);
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    for (const generation of [first, second]) {
      const dir = join(store, generation);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'session.jsonl'), JSON.stringify({ type: 'session', version: 3, id, cwd }) + '\n');
    }
    await withPiTranscriptPointerLock(input, (pointer) => pointer.publish(first, undefined), root);
    // The child takes the very same SQLite lock and leaves an interrupted
    // pointer staging directory while holding it, then is killed by the test.
    const script = `
      const fs = require('node:fs');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
      fs.mkdirSync(process.argv[2]);
      fs.writeFileSync(process.argv[2] + '/current.json', JSON.stringify({version:1,generation:process.argv[3]}));
      process.stdout.write('locked\\n');
      process.stdin.resume();
    `;
    const staging = join(store, '.pointer-interrupted-process');
    child = spawn(process.execPath, ['-e', script, dbPath, staging, second], { stdio: 'pipe' });
    const lines = createInterface({ input: child.stdout });
    const line = await new Promise<string>((resolve, reject) => {
      lines.once('line', resolve);
      child!.once('error', reject);
      child!.once('exit', (code) => reject(new Error(`child exited before locking: ${code}`)));
    });
    lines.close();
    expect(line).toBe('locked');
    await expect(withPiTranscriptPointerLock(input, (pointer) => pointer.read(), root)).rejects.toThrow();
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
    child = undefined;
    await withPiTranscriptPointerLock(input, (pointer) => {
      expect(pointer.read()?.generation).toBe(first);
      pointer.publish(second, first);
    }, root);
    expect(await withPiTranscriptPointerLock(input, (pointer) => pointer.read()?.generation, root)).toBe(second);
    await expect(readFile(join(staging, 'current.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(store, first, 'session.jsonl'), 'utf8')).toContain(id);
  } finally {
    child?.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

it('cleans known interrupted staging while preserving unexpected data and generation files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-pointer-recover-'));
  const input = { sessionDir: join(root, 'sessions'), conductorAgentId: id, cwds: [cwd] };
  const key = createHash('sha256').update(id).digest('hex');
  const store = join(input.sessionDir, '.ensemble-transcripts', key);
  const work = join(store, first, '.pi-resume-interrupted');
  const unknown = join(store, '.pointer-unknown');
  const readStaging = join(store, '.pi-read-interrupted');
  try {
    await mkdir(work, { recursive: true });
    await mkdir(unknown);
    await mkdir(readStaging);
    await writeFile(join(work, 'session.jsonl'), 'unpublished');
    await writeFile(join(readStaging, 'session.jsonl'), 'snapshot');
    await writeFile(join(store, first, 'session.jsonl'), 'generation');
    await writeFile(join(unknown, 'unexpected'), 'keep');
    await withPiTranscriptPointerLock(input, () => undefined, root);
    await expect(readFile(join(work, 'session.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(readStaging, 'session.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(store, first, 'session.jsonl'), 'utf8')).toBe('generation');
    expect(await readFile(join(unknown, 'unexpected'), 'utf8')).toBe('keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('holds the lock across async work, releases on failure, and invalidates escaped handles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-pointer-lock-'));
  const input = { sessionDir: join(root, 'sessions'), conductorAgentId: id, cwds: [cwd] };
  let saved: LockedPiTranscriptPointer | undefined;
  try {
    await expect(withPiTranscriptPointerLock(input, async (pointer) => {
      saved = pointer;
      expect(pointer.read()).toBeUndefined();
      await expect(withPiTranscriptPointerLock(input, () => undefined, root)).rejects.toThrow();
      throw new Error('injected failure');
    }, root)).rejects.toThrow('injected failure');
    expect(() => saved!.read()).toThrow('no longer held');
    expect(await withPiTranscriptPointerLock(input, (pointer) => pointer.read(), root)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
