import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { conductorFailureLogPath, createConductorFailureLog } from './conductor-failure-log.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('buffers startup failures, appends on resume, and excludes free text', async () => {
  root = await mkdtemp(join(tmpdir(), 'failure-log-'));
  const path = join(root, 'session', 'conductor-failures.jsonl');
  const warn = vi.fn();
  const first = createConductorFailureLog(warn);
  first.emit({ type: 'conductor.compaction', event: { type: 'end', reason: 'secret' as 'overflow', outcome: 'failed', errorMessage: 'secret-token' } });
  first.setPath(path);
  const resumed = createConductorFailureLog(warn);
  resumed.setPath(path);
  resumed.emit({ type: 'conductor.retry', event: { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: 'secret-token' } });
  resumed.emit({ type: 'conductor.retry', event: { type: 'auto_retry_end', success: false, attempt: 2, finalError: 'secret-token' } });
  const raw = await readFile(path, 'utf8');
  expect(raw).not.toContain('secret');
  const lines = raw.trim().split('\n').map((line) => JSON.parse(line));
  expect(lines).toMatchObject([
    { version: 1, type: 'compaction_failed', reason: 'unknown' },
    { version: 1, type: 'retry_scheduled', source: 'provider', attempt: 1, maxAttempts: 3 },
    { version: 1, type: 'retry_failed', source: 'provider', attempt: 2 },
  ]);
  expect(warn).not.toHaveBeenCalled();
  if (process.platform !== 'win32') {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  }
});

it('warns once without exposing the error when writing fails', async () => {
  root = await mkdtemp(join(tmpdir(), 'failure-log-'));
  const path = join(root, 'occupied');
  await writeFile(path, 'existing');
  const warn = vi.fn();
  const log = createConductorFailureLog(warn);
  log.setPath(join(path, 'log'));
  const event = { type: 'conductor.compaction' as const, event: { type: 'end' as const, reason: 'overflow' as const, outcome: 'failed' as const } };
  log.emit(event);
  log.emit(event);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(await readFile(path, 'utf8')).toBe('existing');
});

it('rejects symlink log files and unsafe IDs', async () => {
  root = await mkdtemp(join(tmpdir(), 'failure-log-'));
  const target = join(root, 'target');
  await writeFile(target, 'unchanged');
  const path = join(root, 'log');
  await symlink(target, path);
  const warn = vi.fn();
  const log = createConductorFailureLog(warn);
  log.setPath(path);
  log.emit({ type: 'conductor.compaction', event: { type: 'end', reason: 'overflow', outcome: 'failed' } });
  expect(warn).toHaveBeenCalledOnce();
  expect(await readFile(target, 'utf8')).toBe('unchanged');
  expect(() => conductorFailureLogPath({ repoRoot: root, issueUrl: 'https://github.com/o/r/issues/1', conductorAgentId: '../outside' })).toThrow();
});
