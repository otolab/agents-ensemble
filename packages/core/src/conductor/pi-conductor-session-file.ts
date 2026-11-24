import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { piConductorSessionDir } from './pi-conductor-session-dir.js';

export interface PiConductorSessionFile {
  sessionFile: string;
  sessionDir: string;
}

/** A safe diagnostic that never includes transcript contents. */
export class PiTranscriptValidationError extends Error {}

function cwdComparisonKey(cwd: string): string {
  const absolute = resolve(cwd);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/** Only the SDK's timestamped name provides evidence of another session. */
function namedSdkSessionId(name: string): string | undefined {
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\.jsonl$/.exec(name)?.[1];
}

/** Inspect a transcript before passing it to Pi, whose reader can rewrite files. */
export function findValidatedPiSessionFile(input: {
  sessionDir: string;
  conductorAgentId: string;
  cwds: readonly string[];
}): string | undefined {
  let names: string[];
  try {
    names = readdirSync(input.sessionDir).filter((name) => name.endsWith('.jsonl'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new PiTranscriptValidationError(`Cannot read Pi session directory: ${input.sessionDir}`, { cause: error });
  }
  const matches: { path: string; cwd: string }[] = [];
  for (const name of names) {
    const path = join(input.sessionDir, name);
    const namedId = namedSdkSessionId(name);
    const namedForSession = namedId !== undefined
      ? namedId === input.conductorAgentId
      : name === `${input.conductorAgentId}.jsonl`;
    const definitelyOther = namedId !== undefined && namedId !== input.conductorAgentId;
    let lines: string[];
    let header: unknown;
    try {
      lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim());
      header = JSON.parse(lines[0] ?? '');
    } catch (error) {
      if (definitelyOther) continue;
      throw new PiTranscriptValidationError(`Cannot inspect Pi transcript header: ${path}`, { cause: error });
    }
    if (!header || typeof header !== 'object' || Array.isArray(header) ||
        (header as Record<string, unknown>).type !== 'session' ||
        typeof (header as Record<string, unknown>).id !== 'string') {
      if (definitelyOther) continue;
      throw new PiTranscriptValidationError(`Invalid Pi transcript header: ${path}`);
    }
    const record = header as Record<string, unknown>;
    if (record.id !== input.conductorAgentId) {
      if (namedForSession) throw new PiTranscriptValidationError(`Pi transcript session ID mismatch: ${path}`);
      continue;
    }
    if (typeof record.cwd !== 'string' || !record.cwd.trim()) {
      throw new PiTranscriptValidationError(`Invalid Pi transcript cwd: ${path}`);
    }
    const version = record.version ?? 1;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 3) {
      throw new PiTranscriptValidationError(`Unsupported Pi transcript version: ${path}`);
    }
    try {
      const ids = new Set<string>();
      const references: string[] = [];
      for (const line of lines.slice(1)) {
        const entry: unknown = JSON.parse(line);
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
            typeof (entry as Record<string, unknown>).type !== 'string' ||
            (entry as Record<string, unknown>).type === 'session') {
          throw new Error('Invalid transcript entry');
        }
        const item = entry as Record<string, unknown>;
        if (version >= 2) {
          if (typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
              (item.parentId !== null && typeof item.parentId !== 'string') ||
              (typeof item.parentId === 'string' && !ids.has(item.parentId))) {
            throw new Error('Invalid transcript tree');
          }
          ids.add(item.id);
          if (item.type === 'compaction' && item.firstKeptEntryId !== undefined) {
            if (typeof item.firstKeptEntryId !== 'string') throw new Error('Invalid compaction reference');
            references.push(item.firstKeptEntryId);
          }
        }
      }
      if (references.some((id) => !ids.has(id))) throw new Error('Missing compaction reference');
    } catch (error) {
      throw new PiTranscriptValidationError(`Invalid Pi transcript contents: ${path}`, { cause: error });
    }
    matches.push({ path, cwd: record.cwd });
  }
  if (matches.length > 1) {
    throw new PiTranscriptValidationError(`Multiple Pi transcripts match session ID ${input.conductorAgentId}.`);
  }
  const match = matches[0];
  if (!match) return undefined;
  if (!input.cwds.some((cwd) => cwdComparisonKey(cwd) === cwdComparisonKey(match.cwd))) {
    throw new PiTranscriptValidationError(`Pi transcript cwd mismatch: ${match.path}`);
  }
  return match.path;
}

/** Find the Pi transcript in canonical Issue or workspace storage. */
export function findPiConductorSessionFile(input: {
  conductorAgentId: string;
  cwd: string;
  repoRoot?: string;
  issueUrl?: string;
  resumeCwds?: readonly string[];
}): PiConductorSessionFile | undefined {
  if (!input.issueUrl) return undefined;
  const sessionDir = piConductorSessionDir({ cwd: input.repoRoot ?? input.cwd, issueUrl: input.issueUrl });
  const sessionFile = findValidatedPiSessionFile({
    sessionDir,
    conductorAgentId: input.conductorAgentId,
    cwds: [input.cwd, ...(input.resumeCwds ?? [])],
  });
  return sessionFile ? { sessionFile, sessionDir } : undefined;
}
