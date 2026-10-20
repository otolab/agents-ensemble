import {
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
  sessionStateStorePath,
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
      statusLine: '実装中：型チェック待ち',
      reportedAt: 1_739_000_000_000,
    });
    expect(await readFile(path, 'utf8')).toContain(
      `version: ${SESSION_STATE_STORE_VERSION}`,
    );
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
      statusLine: 'first',
      reportedAt: 1,
    });
    await expect(loadSessionStateStore(second)).resolves.toEqual({
      statusLine: 'second',
      reportedAt: 2,
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
      'version: 2\nstatusLine: unsupported\nreportedAt: 1\n',
      'utf8',
    );
    await expect(loadSessionStateStore(path)).rejects.toThrow(
      'Unsupported session state YAML version: 2',
    );
  });
});
