import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadSessionStateStore,
  saveSessionStatusLine,
  SESSION_STATE_STORE_MAX_BYTES,
  sessionStateStorePath,
  SESSION_STATUS_HISTORY_MAX_ENTRIES,
  SESSION_STATE_STORE_VERSION,
} from './session-state-store.js';

describe('session state store', () => {
  let repoRoot = '';

  afterEach(async () => {
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    repoRoot = '';
  });

  it('atomically persists and reads back the latest statusLine for one agent', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-session-state-'));
    const path = sessionStateStorePath({
      repoRoot,
      conductorAgentId: 'agent-1',
    });

    await saveSessionStatusLine(path, '  実装中：型チェック待ち  ', 1_739_000_000_000);

    await expect(loadSessionStateStore(path)).resolves.toEqual({
      current: {
        statusLine: '実装中：型チェック待ち',
        reportedAt: 1_739_000_000_000,
      },
      history: [],
    });
    expect(await readFile(path, 'utf8')).toContain(
      `version: ${SESSION_STATE_STORE_VERSION}`,
    );
    expect(await readFile(path, 'utf8')).toContain('current:');
    await expect(
      readdir(join(repoRoot, '.ensemble', 'sessions', 'agent-1')),
    ).resolves.toEqual(['session-state.yaml']);
  });

  it('keeps status state isolated by conductorAgentId', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-session-state-'));
    const first = sessionStateStorePath({
      repoRoot,
      conductorAgentId: 'agent-first',
    });
    const second = sessionStateStorePath({
      repoRoot,
      conductorAgentId: 'agent-second',
    });
    await Promise.all([
      saveSessionStatusLine(first, 'first', 1),
      saveSessionStatusLine(second, 'second', 2),
    ]);

    await expect(loadSessionStateStore(first)).resolves.toEqual({
      current: { statusLine: 'first', reportedAt: 1 },
      history: [],
    });
    await expect(loadSessionStateStore(second)).resolves.toEqual({
      current: { statusLine: 'second', reportedAt: 2 },
      history: [],
    });
  });

  it('returns undefined when no state was written and rejects malformed YAML', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-session-state-'));
    const path = sessionStateStorePath({
      repoRoot,
      conductorAgentId: 'agent-1',
    });

    await expect(loadSessionStateStore(path)).resolves.toBeUndefined();
    await saveSessionStatusLine(path, 'saved', 1);
    await writeFile(
      path,
      'version: 3\nstatusLine: unsupported\nreportedAt: 1\n',
      'utf8',
    );
    await expect(loadSessionStateStore(path)).rejects.toThrow(
      'Unsupported session state YAML version: 3',
    );
  });

  it('reads legacy current-only files and retains the prior report on migration', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-session-state-'));
    const path = sessionStateStorePath({
      repoRoot,
      conductorAgentId: 'agent-legacy',
    });
    await mkdir(join(repoRoot, '.ensemble', 'sessions', 'agent-legacy'), {
      recursive: true,
    });
    await writeFile(
      path,
      'version: 1\nstatusLine: "legacy report"\nreportedAt: 10\n',
      'utf8',
    );

    await expect(loadSessionStateStore(path)).resolves.toEqual({
      current: { statusLine: 'legacy report', reportedAt: 10 },
      history: [],
    });
    await saveSessionStatusLine(path, 'new report', 20);
    await expect(loadSessionStateStore(path)).resolves.toEqual({
      current: { statusLine: 'new report', reportedAt: 20 },
      history: [{ statusLine: 'legacy report', reportedAt: 10 }],
    });
  });

  it('keeps history within both the entry-count and serialized-size limits', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-session-state-'));
    const path = sessionStateStorePath({
      repoRoot,
      conductorAgentId: 'agent-bounded',
    });

    for (let index = 0; index < 65; index += 1) {
      await saveSessionStatusLine(path, `report-${index}`, index);
    }
    let state = await loadSessionStateStore(path);
    expect(state?.history).toHaveLength(SESSION_STATUS_HISTORY_MAX_ENTRIES);
    expect(state?.history[0]?.statusLine).toBe('report-14');
    expect(state?.history.at(-1)?.statusLine).toBe('report-63');

    for (let index = 0; index < 100; index += 1) {
      const statusLine = `${String(index).padStart(2, '0')}${'🧪'.repeat(78)}`;
      await saveSessionStatusLine(path, statusLine, 100 + index);
    }
    state = await loadSessionStateStore(path);
    expect(state?.history.length).toBeLessThanOrEqual(
      SESSION_STATUS_HISTORY_MAX_ENTRIES,
    );
    expect(Buffer.byteLength(await readFile(path, 'utf8'), 'utf8')).toBeLessThanOrEqual(
      SESSION_STATE_STORE_MAX_BYTES,
    );
    expect(state?.current.statusLine.startsWith('99')).toBe(true);
  });
});
