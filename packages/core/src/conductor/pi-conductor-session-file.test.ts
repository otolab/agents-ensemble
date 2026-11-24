import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findValidatedPiSessionFile } from './pi-conductor-session-file.js';

describe('Pi transcript identity validation', () => {
  let dir: string;
  const id = 'session-1';
  const cwd = '/project';
  const header = (sessionId = id, sessionCwd = cwd) =>
    JSON.stringify({ type: 'session', id: sessionId, cwd: sessionCwd, version: 3 });
  const find = () => findValidatedPiSessionFile({ sessionDir: dir, conductorAgentId: id, cwds: [cwd] });

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pi-validation-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('finds a matching session using a saved cwd without changing it', async () => {
    const path = join(dir, 'first.jsonl');
    const bytes = `${header()}\n${JSON.stringify({ type: 'custom', id: 'entry', parentId: null })}`;
    await writeFile(path, bytes);
    expect(findValidatedPiSessionFile({ sessionDir: dir, conductorAgentId: id, cwds: ['/new', cwd] })).toBe(path);
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });

  it.each([
    ['corrupt header', 'session-1.jsonl', '{broken', /header/],
    ['corrupt body', 'session-1.jsonl', `${header()}\n{broken`, /contents/],
    ['wrong ID', 'session-1.jsonl', header('other'), /ID mismatch/],
    ['wrong cwd', 'session-1.jsonl', header(id, '/other'), /cwd mismatch/],
    ['future version', 'session-1.jsonl', JSON.stringify({ type: 'session', id, cwd, version: 4 }), /version/],
    ['missing parent', 'session-1.jsonl', `${header()}\n${JSON.stringify({ type: 'custom', id: 'a', parentId: 'missing' })}`, /contents/],
    ['duplicate entry ID', 'session-1.jsonl', `${header()}\n${JSON.stringify({ type: 'custom', id: 'a', parentId: null })}\n${JSON.stringify({ type: 'custom', id: 'a', parentId: 'a' })}`, /contents/],
    ['missing compaction target', 'session-1.jsonl', `${header()}\n${JSON.stringify({ type: 'compaction', id: 'a', parentId: null, firstKeptEntryId: 'missing' })}`, /contents/],
  ])('rejects %s without modifying the source', async (_label, name, bytes, message) => {
    const path = join(dir, name);
    await writeFile(path, bytes);
    expect(find).toThrow(message);
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });

  it('rejects duplicate matching IDs without modifying either source', async () => {
    const paths = [join(dir, 'first.jsonl'), join(dir, 'second.jsonl')];
    await Promise.all(paths.map((path) => writeFile(path, header())));
    expect(find).toThrow(/Multiple Pi transcripts/);
    for (const path of paths) expect(await readFile(path, 'utf8')).toBe(header());
  });

  it.each([1, 2, 3])('accepts a valid version %i transcript', async (version) => {
    const path = join(dir, 'first.jsonl');
    const sessionHeader = { type: 'session', id, cwd, version };
    const entry = version === 1
      ? { type: 'custom' }
      : { type: 'custom', id: 'a', parentId: null };
    const bytes = `${JSON.stringify(sessionHeader)}\n${JSON.stringify(entry)}\n`;
    await writeFile(path, bytes);
    expect(find()).toBe(path);
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });
});
