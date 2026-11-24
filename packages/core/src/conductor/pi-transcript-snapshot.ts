import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { findValidatedPiSessionFile, PiTranscriptValidationError } from './pi-conductor-session-file.js';
import { piConductorSessionDir } from './pi-conductor-session-dir.js';
import { withPiTranscriptPointerLock } from './pi-transcript-lock.js';
import { piTranscriptGenerationFile, piTranscriptStoreDir } from './pi-transcript-pointer.js';
import { acquireSessionMigrationReadLock } from '../session/session-owner-lock.js';

function readRegularFile(path: string): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new PiTranscriptValidationError('Pi transcript is not a regular file.');
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new PiTranscriptValidationError('Pi transcript changed during snapshot.');
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Resolve and copy a validated snapshot while excluding pointer changes.
 * SDK appenders do not use this lock: two identical reads plus validation of
 * the copied bytes reject an observed concurrent change or incomplete entry.
 * This provides a point-in-time prefix, not a guarantee of latest data. */
export async function readPiTranscriptSnapshot(input: {
  conductorAgentId: string; cwd: string; repoRoot?: string; issueUrl?: string; resumeCwds?: readonly string[];
}): Promise<{ sessionFile: string; contents: Buffer } | undefined> {
  if (!input.issueUrl) return undefined;
  const releaseMigration = await acquireSessionMigrationReadLock();
  try {
    const sessionDir = piConductorSessionDir({ cwd: input.repoRoot ?? input.cwd, issueUrl: input.issueUrl });
    const identity = { sessionDir, conductorAgentId: input.conductorAgentId, cwds: [input.cwd, ...(input.resumeCwds ?? [])] };
    return await withPiTranscriptPointerLock(identity, (pointer) => {
      let sessionFile = pointer.read()?.sessionFile ?? findValidatedPiSessionFile(identity);
      if (!sessionFile) return undefined;
      const contents = readRegularFile(sessionFile);
      if (!contents.equals(readRegularFile(sessionFile))) throw new PiTranscriptValidationError('Pi transcript changed during snapshot.');
      const store = piTranscriptStoreDir(identity);
      mkdirSync(store, { recursive: true, mode: 0o700 });
      const staging = mkdtempSync(join(store, '.pi-read-'));
      try {
        const staged = join(staging, 'session.jsonl');
        writeFileSync(staged, contents, { mode: 0o600, flag: 'wx' });
        if (!findValidatedPiSessionFile({ ...identity, sessionDir: staging })) {
          throw new PiTranscriptValidationError('Pi transcript snapshot identity mismatch.');
        }
        const header = JSON.parse(contents.toString('utf8').split('\n')[0]!);
        if ((header.version ?? 1) === 1) {
          // Pi assigns random IDs when upgrading v1. Publish one result so every
          // reader and a later resume observe the same IDs; never open the source.
          SessionManager.open(staged, staging, input.cwd);
          if (!findValidatedPiSessionFile({ ...identity, sessionDir: staging })) {
            throw new PiTranscriptValidationError('Migrated Pi transcript identity mismatch.');
          }
          if (!contents.equals(readRegularFile(sessionFile))) throw new PiTranscriptValidationError('Pi transcript changed during migration.');
          const generation = randomUUID().replaceAll('-', '');
          const destination = piTranscriptGenerationFile(identity, generation);
          mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
          // Exclusive creation keeps an unexpected existing generation intact.
          const migratedContents = readFileSync(staged);
          writeFileSync(destination, migratedContents, { mode: 0o600, flag: 'wx' });
          pointer.publish(generation, undefined);
          sessionFile = destination;
          return { sessionFile, contents: migratedContents };
        }
        return { sessionFile, contents };
      } finally {
        // A successful pointer publication must not be reported as failed just
        // because cleanup of a private temporary snapshot failed.
        try { rmSync(staging, { recursive: true, force: true }); } catch { /* ignored orphan */ }
      }
    });
  } finally {
    releaseMigration();
  }
}
