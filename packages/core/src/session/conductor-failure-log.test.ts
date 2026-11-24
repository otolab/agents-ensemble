import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  first.setPath(path, root);
  const resumed = createConductorFailureLog(warn);
  resumed.setPath(path, root);
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
  log.setPath(join(path, 'log'), root);
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
  await mkdir(join(root, 'session'));
  const path = join(root, 'session', 'log');
  await symlink(target, path);
  const warn = vi.fn();
  const log = createConductorFailureLog(warn);
  log.setPath(path, root);
  log.emit({ type: 'conductor.compaction', event: { type: 'end', reason: 'overflow', outcome: 'failed' } });
  expect(warn).toHaveBeenCalledOnce();
  expect(await readFile(target, 'utf8')).toBe('unchanged');
  expect(() => conductorFailureLogPath({ repoRoot: root, issueUrl: 'https://github.com/o/r/issues/1', conductorAgentId: '../outside' })).toThrow();
});

it.skipIf(process.platform === 'win32')('rejects a symlink in the parent hierarchy without touching its target', async () => {
  root = await mkdtemp(join(tmpdir(), 'failure-log-'));
  const trusted = join(root, 'trusted');
  const target = join(root, 'target');
  const targetSession = join(target, 'session');
  await mkdir(trusted);
  await mkdir(targetSession, { recursive: true });
  const file = join(targetSession, 'conductor-failures.jsonl');
  await writeFile(file, 'existing\n');
  await chmod(targetSession, 0o755);
  await chmod(file, 0o644);
  await symlink(target, join(trusted, 'sessions'));
  const warn = vi.fn();
  const log = createConductorFailureLog(warn);
  log.setPath(join(trusted, 'sessions', 'session', 'conductor-failures.jsonl'), trusted);
  log.emit({ type: 'conductor.compaction', event: { type: 'end', reason: 'overflow', outcome: 'failed' } });
  expect(warn).toHaveBeenCalledOnce();
  expect(await readFile(file, 'utf8')).toBe('existing\n');
  expect((await stat(targetSession)).mode & 0o777).toBe(0o755);
  expect((await stat(file)).mode & 0o777).toBe(0o644);
});

it.skipIf(process.platform === 'win32')('permits a configured user root that is itself a symlink', async () => {
  root = await mkdtemp(join(tmpdir(), 'failure-log-'));
  const target = join(root, 'target');
  const trusted = join(root, 'user-root');
  await mkdir(target);
  await symlink(target, trusted);
  const warn = vi.fn();
  const log = createConductorFailureLog(warn);
  log.setPath(join(trusted, 'sessions', 'session', 'conductor-failures.jsonl'), trusted);
  log.emit({ type: 'conductor.compaction', event: { type: 'end', reason: 'overflow', outcome: 'failed' } });
  expect(warn).not.toHaveBeenCalled();
  expect(await readFile(join(target, 'sessions', 'session', 'conductor-failures.jsonl'), 'utf8')).toContain('compaction_failed');
});

it('ignores delayed Pi callbacks after the log is closed', async () => {
  root = await mkdtemp(join(tmpdir(), 'failure-log-close-'));
  const path = join(root, 'session', 'conductor-failures.jsonl');
  const log = createConductorFailureLog(vi.fn());
  log.setPath(path, root);
  const event = { type: 'conductor.compaction' as const, event: { type: 'end' as const, reason: 'overflow' as const, outcome: 'failed' as const } };
  log.emit(event);
  const before = await readFile(path, 'utf8');
  log.close();
  log.emit(event);
  expect(await readFile(path, 'utf8')).toBe(before);
});
