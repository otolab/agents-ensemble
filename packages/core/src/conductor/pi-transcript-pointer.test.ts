import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publishPiTranscriptPointer, readPiTranscriptPointer } from './pi-transcript-pointer.js';

const id = 'session-id';
const cwd = '/project';
const first = 'a'.repeat(32);
const second = 'b'.repeat(32);
describe('Pi transcript pointer', () => {
  let dir: string;
  let store: string;
  let input: { sessionDir: string; conductorAgentId: string; cwds: string[] };
  const prepare = (generation: string, sessionId = id, sessionCwd = cwd) => {
    const target = join(store, generation);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'session.jsonl'), JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: sessionCwd }) + '\n');
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-pointer-'));
    store = join(dir, '.ensemble-transcripts', createHash('sha256').update(id).digest('hex'));
    input = { sessionDir: dir, conductorAgentId: id, cwds: [cwd] };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates and explicitly replaces a validated pointer', () => {
    prepare(first); prepare(second);
    expect(readPiTranscriptPointer(input)).toBeUndefined();
    publishPiTranscriptPointer({ ...input, generation: first, expectedGeneration: undefined });
    expect(readPiTranscriptPointer(input)).toEqual({ generation: first, sessionFile: join(store, first, 'session.jsonl') });
    publishPiTranscriptPointer({ ...input, generation: second, expectedGeneration: first });
    expect(readPiTranscriptPointer(input)?.generation).toBe(second);
    expect(readFileSync(join(store, first, 'session.jsonl'), 'utf8')).toContain(id);
  });

  it('refuses stale or unintended replacement without changing the pointer', () => {
    prepare(first); prepare(second);
    publishPiTranscriptPointer({ ...input, generation: first, expectedGeneration: undefined });
    for (const expectedGeneration of [undefined, second]) {
      expect(() => publishPiTranscriptPointer({ ...input, generation: second, expectedGeneration })).toThrow('changed');
    }
    expect(readPiTranscriptPointer(input)?.generation).toBe(first);
  });

  it('rejects malformed pointers, traversal, and missing or mismatched targets', () => {
    prepare(first);
    const pointer = join(store, 'current.json');
    for (const contents of ['{', '{}', JSON.stringify({ version: 1, generation: '../escape' }), JSON.stringify({ version: 1, generation: second })]) {
      writeFileSync(pointer, contents);
      expect(() => readPiTranscriptPointer(input)).toThrow();
      expect(() => publishPiTranscriptPointer({ ...input, generation: first, expectedGeneration: undefined })).toThrow();
      expect(readFileSync(pointer, 'utf8')).toBe(contents);
    }
    prepare(second, 'other');
    writeFileSync(pointer, JSON.stringify({ version: 1, generation: second }));
    expect(() => readPiTranscriptPointer(input)).toThrow();
    prepare(second, id, '/wrong');
    expect(() => readPiTranscriptPointer(input)).toThrow('cwd mismatch');
  });

  it('ignores interrupted staging before and after publication', () => {
    prepare(first); prepare(second);
    const orphan = join(store, '.pointer-interrupted');
    mkdirSync(orphan);
    writeFileSync(join(orphan, 'current.json'), JSON.stringify({ version: 1, generation: second }));
    expect(readPiTranscriptPointer(input)).toBeUndefined();
    publishPiTranscriptPointer({ ...input, generation: first, expectedGeneration: undefined });
    expect(readPiTranscriptPointer(input)?.generation).toBe(first);
    expect(readFileSync(join(orphan, 'current.json'), 'utf8')).toContain(second);
  });

  it('does not publish a missing or invalid target', () => {
    prepare(first);
    publishPiTranscriptPointer({ ...input, generation: first, expectedGeneration: undefined });
    expect(() => publishPiTranscriptPointer({ ...input, generation: second, expectedGeneration: first })).toThrow();
    expect(() => publishPiTranscriptPointer({ ...input, generation: '../escape', expectedGeneration: first })).toThrow();
    expect(readPiTranscriptPointer(input)?.generation).toBe(first);
  });
});
