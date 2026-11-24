import { constants, chmodSync, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SessionLogEvent } from '../conductor/session/session-logger.js';
import { sessionStateStorePath } from './session-state-store.js';

/** The log contains fixed metadata only; provider messages are never persisted. */
export function conductorFailureLogPath(options: { repoRoot: string; issueUrl: string; conductorAgentId: string }): string {
  if (!/^[A-Za-z0-9_.-]+$/u.test(options.conductorAgentId) || options.conductorAgentId === '.' || options.conductorAgentId === '..') throw new Error('Invalid conductor agent ID for failure log.');
  return join(dirname(sessionStateStorePath(options)), 'conductor-failures.jsonl');
}

function safeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10000 ? value : null;
}

function recordFor(event: SessionLogEvent): object | undefined {
  if (event.type === 'conductor.compaction' && event.event.type === 'end' && event.event.outcome === 'failed') {
    const reason = event.event.reason;
    return { type: 'compaction_failed', reason: reason === 'manual' || reason === 'threshold' || reason === 'overflow' ? reason : 'unknown' };
  }
  if (event.type !== 'conductor.retry') return undefined;
  const retry = event.event;
  if (retry.type === 'auto_retry_start' || retry.type === 'summarization_retry_scheduled') {
    return { type: 'retry_scheduled', source: retry.type === 'auto_retry_start' ? 'provider' : 'summarization', attempt: safeCount(retry.attempt), maxAttempts: safeCount(retry.maxAttempts) };
  }
  if (retry.type === 'auto_retry_end' && !retry.success) {
    return { type: 'retry_failed', source: 'provider', attempt: safeCount(retry.attempt) };
  }
  return undefined;
}

export function createConductorFailureLog(warn: () => void) {
  let path: string | undefined;
  let trustedRoot: string | undefined;
  let failed = false;
  const pending: object[] = [];
  const write = (record: object) => {
    if (!path || !trustedRoot || failed) return;
    try {
      const dir = dirname(path);
      const suffix = relative(trustedRoot, dir);
      if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('unsafe path');
      // The configured user root is trusted (and may itself be a symlink).
      // Reject links below it before creating or touching the next component.
      mkdirSync(trustedRoot, { recursive: true, mode: 0o700 });
      let current = trustedRoot;
      for (const component of suffix.split(sep)) {
        current = join(current, component);
        try {
          mkdirSync(current, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const entry = lstatSync(current);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('unsafe directory');
      }
      const directory = lstatSync(dir);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('unsafe directory');
      // Match the session-state store's owner-only directory and file modes on POSIX.
      if (process.platform === 'win32') {
        chmodSync(dir, 0o700);
      } else {
        const dirFd = openSync(dir, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try { fchmodSync(dirFd, 0o700); } finally { closeSync(dirFd); }
      }
      try {
        if (lstatSync(path).isSymbolicLink()) throw new Error('unsafe file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const file = fstatSync(fd);
        if (!file.isFile() || file.nlink !== 1) throw new Error('unsafe file');
        fchmodSync(fd, 0o600);
        const line = `${JSON.stringify(record)}\n`;
        if (writeSync(fd, line) !== Buffer.byteLength(line)) throw new Error('incomplete write');
      } finally { closeSync(fd); }
    } catch {
      failed = true;
      warn();
    }
  };
  return {
    emit(event: SessionLogEvent) {
      const data = recordFor(event);
      if (!data || failed) return;
      const record = { version: 1, at: new Date().toISOString(), ...data };
      if (path) write(record);
      else if (pending.length < 100) pending.push(record);
      else { failed = true; warn(); }
    },
    close() {
      failed = true;
      path = undefined;
      pending.length = 0;
    },
    abandon() {
      if (pending.length && !failed) { failed = true; warn(); }
      pending.length = 0;
    },
    setPath(nextPath: string, root: string) {
      path = resolve(nextPath);
      trustedRoot = resolve(root);
      for (const record of pending.splice(0)) write(record);
    },
  };
}
