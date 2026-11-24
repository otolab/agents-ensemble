import {
  mkdir,
  mkdtemp as createTempDir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import { SessionOwnership } from './session-ownership.js';
import {
  loadSessionStateStore,
  legacySessionStateStorePath,
  saveSessionStatusLine as saveWithLease,
  SESSION_STATE_STORE_MAX_BYTES,
  sessionStateStorePath,
  SESSION_STATUS_HISTORY_MAX_ENTRIES,
  SESSION_STATE_STORE_VERSION,
} from './session-state-store.js';

async function saveSessionStatusLine(path: string, status: string, reportedAt?: number) {
  const owner = await SessionOwnership.acquireProvider(`${dirname(path)}.json`);
  try {
    await owner.runWrite((lease) => saveWithLease(path, status, reportedAt, owner, lease));
  } finally {
    await owner.closeWritesAndDrain();
    owner.release();
  }
}

const ISSUE_URL = 'https://github.com/org/repo/issues/607';

describe('session state store', () => {
  let repoRoot = '';

  afterEach(async () => {
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    repoRoot = '';
  });

  async function createHome(prefix: string): Promise<string> {
    const directory = await createTempDir(join(tmpdir(), prefix));
    vi.stubEnv('HOME', directory);
    return directory;
  }

  it('atomically persists and reads back the latest statusLine for one agent', async () => {
    repoRoot = await createHome('ensemble-session-state-');
    const path = sessionStateStorePath({
      repoRoot,
      conductorAgentId: 'agent-1',
      issueUrl: ISSUE_URL,
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
      readdir(dirname(path)),
    ).resolves.toEqual(['session-state.yaml']);
    await expect(
      readFile(
        resolveEnsemblePaths({ repoRoot })
          .legacyHashSessionStatePath('agent-1'),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(
        legacySessionStateStorePath({
          repoRoot,
          conductorAgentId: 'agent-1',
        }),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps status state isolated by conductorAgentId', async () => {
    repoRoot = await createHome('ensemble-session-state-');
    const first = sessionStateStorePath({
      repoRoot,
      conductorAgentId: 'agent-first',
      issueUrl: ISSUE_URL,
    });
    const second = sessionStateStorePath({
      repoRoot,
      conductorAgentId: 'agent-second',
      issueUrl: ISSUE_URL,
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
    repoRoot = await createHome('ensemble-session-state-');
    const path = sessionStateStorePath({
      repoRoot,
      conductorAgentId: 'agent-1',
      issueUrl: ISSUE_URL,
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
    repoRoot = await createHome('ensemble-session-state-');
    const path = sessionStateStorePath({
      repoRoot,
      conductorAgentId: 'agent-legacy',
      issueUrl: ISSUE_URL,
    });
    await mkdir(dirname(path), { recursive: true });
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

  it('does not carry project-local status into a new Issue-scoped report', async () => {
    repoRoot = await createHome('ensemble-session-state-');
    const options = {
      repoRoot,
      conductorAgentId: 'agent-project-legacy',
    };
    const path = sessionStateStorePath({
      ...options,
      issueUrl: ISSUE_URL,
      location: 'canonical-slug',
    });
    const legacyPath = legacySessionStateStorePath(options);
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      [
        'version: 2',
        'current:',
        '  statusLine: "legacy report"',
        '  reportedAt: 10',
        'history:',
        '  - statusLine: "older report"',
        '    reportedAt: 5',
        '',
      ].join('\n'),
      'utf8',
    );

    await saveSessionStatusLine(path, 'new report', 20);

    await expect(loadSessionStateStore(path)).resolves.toEqual({
      current: { statusLine: 'new report', reportedAt: 20 },
      history: [],
    });
    await expect(loadSessionStateStore(legacyPath)).resolves.toMatchObject({
      current: { statusLine: 'legacy report', reportedAt: 10 },
    });
  });

  it('writes Issue-scoped session state without carrying forward a path-hash snapshot', async () => {
    repoRoot = await createHome('ensemble-session-state-slug-');
    const options = {
      repoRoot,
      conductorAgentId: 'agent-slug',
      issueUrl: ISSUE_URL,
    };
    const hashPath = resolveEnsemblePaths({ repoRoot })
      .legacyHashSessionStatePath(options.conductorAgentId);
    const slugPath = sessionStateStorePath({
      ...options,
      location: 'canonical-slug',
    });
    await mkdir(dirname(hashPath), { recursive: true });
    await writeFile(
      hashPath,
      'version: 1\nstatusLine: "hash report"\nreportedAt: 10\n',
      'utf8',
    );

    await saveSessionStatusLine(slugPath, 'slug report', 20);

    await expect(loadSessionStateStore(slugPath)).resolves.toEqual({
      current: { statusLine: 'slug report', reportedAt: 20 },
      history: [],
    });
    await expect(loadSessionStateStore(hashPath)).resolves.toMatchObject({
      current: { statusLine: 'hash report', reportedAt: 10 },
    });
  });

  it('keeps history within both the entry-count and serialized-size limits', async () => {
    repoRoot = await createHome('ensemble-session-state-');
    const path = sessionStateStorePath({
      repoRoot,
      conductorAgentId: 'agent-bounded',
      issueUrl: ISSUE_URL,
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
