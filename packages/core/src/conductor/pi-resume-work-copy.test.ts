import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPiResumeWorkCopy } from './pi-resume-work-copy.js';

describe('Pi resume work copy', () => {
  let dir: string;
  let sourceFile: string;
  let destinationFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pi-resume-work-'));
    sourceFile = join(dir, 'original.jsonl');
    destinationFile = join(dir, 'committed', 'session.jsonl');
    await writeFile(sourceFile, 'original\n');
  });

  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('publishes the modified copy without modifying the source', async () => {
    const work = await createPiResumeWorkCopy({ sourceFile, destinationFile });
    expect(await readFile(work.workFile, 'utf8')).toBe('original\n');
    if (process.platform !== 'win32') expect((await stat(work.workFile)).mode & 0o777).toBe(0o600);
    await writeFile(work.workFile, 'initialized\n');
    await expect(work.commit()).resolves.toEqual({ path: destinationFile, cleanupPending: false });
    expect(await readFile(destinationFile, 'utf8')).toBe('initialized\n');
    expect(await readFile(sourceFile, 'utf8')).toBe('original\n');
    expect(await readdir(join(dir, 'committed'))).toEqual(['session.jsonl']);
    await expect(work.commit()).rejects.toThrow('committed');
    await expect(work.discard()).rejects.toThrow('committed');
  });

  it('discards a failed initialization and leaves the source unchanged', async () => {
    const work = await createPiResumeWorkCopy({ sourceFile, destinationFile });
    await writeFile(work.workFile, 'partial initialization');
    await work.discard();
    expect(await readFile(sourceFile, 'utf8')).toBe('original\n');
    await expect(readFile(destinationFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(dir, 'committed'))).toEqual([]);
    await expect(work.commit()).rejects.toThrow('discarded');
  });

  it('does not replace an existing destination and permits cleanup after failure', async () => {
    const work = await createPiResumeWorkCopy({ sourceFile, destinationFile });
    await writeFile(destinationFile, 'existing\n');
    await expect(work.commit()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(destinationFile, 'utf8')).toBe('existing\n');
    expect(await readFile(sourceFile, 'utf8')).toBe('original\n');
    await work.discard();
    expect(await readdir(join(dir, 'committed'))).toEqual(['session.jsonl']);
  });

  it('allows only one of two concurrent publishers to create the destination', async () => {
    const first = await createPiResumeWorkCopy({ sourceFile, destinationFile });
    const second = await createPiResumeWorkCopy({ sourceFile, destinationFile });
    await writeFile(first.workFile, 'first\n');
    await writeFile(second.workFile, 'second\n');
    const results = await Promise.allSettled([first.commit(), second.commit()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const content = await readFile(destinationFile, 'utf8');
    expect(['first\n', 'second\n']).toContain(content);
    await (results[0]?.status === 'rejected' ? first : second).discard();
    expect(await readFile(sourceFile, 'utf8')).toBe('original\n');
  });

  it('cleans the staging directory when the source cannot be copied', async () => {
    await expect(createPiResumeWorkCopy({ sourceFile: join(dir, 'missing'), destinationFile }))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(dir, 'committed'))).toEqual([]);
  });

  it('allows discard after a publication failure and preserves the source', async () => {
    const work = await createPiResumeWorkCopy({ sourceFile, destinationFile });
    await unlink(work.workFile);
    await expect(work.commit()).rejects.toMatchObject({ code: 'ENOENT' });
    await work.discard();
    expect(await readFile(sourceFile, 'utf8')).toBe('original\n');
    expect(await readdir(join(dir, 'committed'))).toEqual([]);
  });
});
