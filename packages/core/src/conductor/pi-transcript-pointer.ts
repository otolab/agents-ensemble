import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findValidatedPiSessionFile, PiTranscriptValidationError } from './pi-conductor-session-file.js';

export interface PiTranscriptPointerInput {
  sessionDir: string;
  conductorAgentId: string;
  cwds: readonly string[];
}

function paths(input: PiTranscriptPointerInput) {
  const key = createHash('sha256').update(input.conductorAgentId).digest('hex');
  const dir = join(input.sessionDir, '.ensemble-transcripts', key);
  return { dir, pointer: join(dir, 'current.json') };
}

export function piTranscriptStoreDir(input: PiTranscriptPointerInput): string {
  return paths(input).dir;
}

/** Allocate a generation path; publication validates its completed transcript. */
export function piTranscriptGenerationFile(input: PiTranscriptPointerInput, generation: string): string {
  if (!/^[a-f0-9]{32}$/.test(generation)) {
    throw new PiTranscriptValidationError('Invalid Pi transcript pointer generation.');
  }
  return join(paths(input).dir, generation, 'session.jsonl');
}

function target(input: PiTranscriptPointerInput, generation: unknown): string {
  // A single path component prevents a pointer from escaping its session store.
  if (typeof generation !== 'string' || !/^[a-f0-9]{32}$/.test(generation)) {
    throw new PiTranscriptValidationError('Invalid Pi transcript pointer generation.');
  }
  const dir = join(paths(input).dir, generation);
  const file = piTranscriptGenerationFile(input, generation);
  const found = findValidatedPiSessionFile({
    sessionDir: dir, conductorAgentId: input.conductorAgentId, cwds: input.cwds,
  });
  if (found !== file) throw new PiTranscriptValidationError('Pi transcript pointer target is missing or invalid.');
  return file;
}

/** Return the committed generation, validating both pointer and transcript. */
export function readPiTranscriptPointer(input: PiTranscriptPointerInput): { generation: string; sessionFile: string } | undefined {
  let contents: string;
  try {
    contents = readFileSync(paths(input).pointer, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new PiTranscriptValidationError('Cannot read Pi transcript pointer.', { cause: error });
  }
  let value: unknown;
  try { value = JSON.parse(contents); } catch (error) {
    throw new PiTranscriptValidationError('Invalid Pi transcript pointer.', { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'generation,version' ||
      (value as Record<string, unknown>).version !== 1) {
    throw new PiTranscriptValidationError('Invalid Pi transcript pointer.');
  }
  const generation = (value as Record<string, unknown>).generation;
  const sessionFile = target(input, generation);
  return { generation: generation as string, sessionFile };
}

/**
 * Publish a fully prepared target. Initial creation is exclusive; replacement
 * requires the caller's expected generation. The caller MUST hold a shared
 * interprocess lock across resolution, target preparation and publication:
 * the expected-value check and rename are not a compare-and-swap operation.
 * A same-filesystem rename makes replacement atomic to readers; interrupted
 * staging may leave a .pointer-* directory, which readers ignore. This does
 * not provide fsync/power-loss durability, locking, or staging cleanup after a
 * process crash. Targets must remain available while readers may use them.
 */
export function publishPiTranscriptPointer(input: PiTranscriptPointerInput & {
  generation: string;
  expectedGeneration: string | undefined;
}): void {
  target(input, input.generation);
  const { dir, pointer } = paths(input);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const current = readPiTranscriptPointer(input);
  if (current?.generation !== input.expectedGeneration) {
    throw new PiTranscriptValidationError('Pi transcript pointer changed before publication.');
  }
  const staging = mkdtempSync(join(dir, '.pointer-'));
  const stagedPointer = join(staging, 'current.json');
  try {
    writeFileSync(stagedPointer, JSON.stringify({ version: 1, generation: input.generation }) + '\n', { mode: 0o600, flag: 'wx' });
    if (input.expectedGeneration === undefined) {
      // link is atomic and cannot replace a pointer created by another caller.
      linkSync(stagedPointer, pointer);
    } else {
      renameSync(stagedPointer, pointer);
    }
  } finally {
    // Publication may already have succeeded; cleanup must not report failure.
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* recovered as an ignored orphan */ }
  }
}
