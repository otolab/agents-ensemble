import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openQuestionReport } from '../../test/support/watch-state-fixture.js';
import { emptyWatchState } from './operator-watch-state.js';
import { loadWatchState, saveWatchState, saveWatchStateSync, withWatchStateLock } from './watch-state-store.js';

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('watch state store', () => {
  it('round trips state through both save paths without losing pending timing', async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-store-'));
    const path = join(root, 'nested', 'state.json');
    const state = emptyWatchState();
    state.pendingReports.push(openQuestionReport({ reportId: 'id', conductorAgentId: 'one', issueUrl: 'https://github.com/example/repo/issues/1', text: 'question', debounceMs: 3, readyAt: 100, arrivalOrder: 101, firstQueuedAt: 90 }));
    expect(await loadWatchState(path)).toEqual(emptyWatchState());
    await saveWatchState(path, state);
    expect(await loadWatchState(path)).toEqual(state);
    state.pendingReports[0]!.readyAt = 200;
    saveWatchStateSync(path, state);
    expect(await loadWatchState(path)).toEqual(state);
    expect((await readFile(path, 'utf8')).endsWith('\n')).toBe(true);
  });

  it('normalizes legacy pending metadata and rejects duplicate IDs', async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-store-'));
    const path = join(root, 'state.json');
    const report = { reportId: 'id', reportType: 'open_question', conductorAgentId: 'one', issueUrl: 'https://github.com/example/repo/issues/1', text: 'question', debounceMs: 3 };
    await writeFile(path, JSON.stringify({ version: 1, watches: {}, cursors: {}, pendingReports: [report] }));
    expect((await loadWatchState(path)).pendingReports[0]).toMatchObject({ readyAt: 0, arrivalOrder: 0, firstQueuedAt: 0, priority: 'open_question' });
    await writeFile(path, JSON.stringify({ version: 1, watches: {}, cursors: {}, pendingReports: [report, report] }));
    await expect(loadWatchState(path)).rejects.toThrow(/pending report/);
  });

  it('commits the order counter, rolls it back on failure, and releases the lock', async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-store-'));
    const first = await withWatchStateLock(root, 'default', async (next) => next(8_000_000_000_000_000));
    await expect(withWatchStateLock(root, 'default', async (next) => {
      expect(next()).toBe(first + 1);
      throw new Error('abort');
    })).rejects.toThrow('abort');
    const afterFailure = await withWatchStateLock(root, 'default', async (next) => next());
    expect(afterFailure).toBe(first + 1);
  });
});
