import { createHash } from 'node:crypto';
import { access, mkdtemp as createTempDir, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEnsemblePaths } from '../ensemble-paths.js';
import type { StoredToolCallSnapshot } from '../runtime/tool-call-snapshot-registry.js';
import {
  TOOL_CALL_SNAPSHOT_HISTORY_MAX_BYTES,
  TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS,
} from '../runtime/tool-call-snapshot-registry.js';
import {
  loadToolCallSnapshotHistory,
  pruneExpiredToolCallSnapshotHistoryFiles,
  saveToolCallSnapshotHistory,
  toolCallSnapshotHistoryPath,
} from './tool-call-snapshot-history.js';

const ENTRY: StoredToolCallSnapshot = {
  workerId: 'old-worker-id',
  workerName: 'implementer',
  sessionId: 'acp-session-1',
  updatedAt: Date.now(),
  snapshot: {
    toolCallId: 'call-1',
    kind: 'edit',
    locations: [{ path: '/repo/src/file.ts', line: 12 }],
  },
};
const ISSUE_URL = 'https://github.com/org/repo/issues/1';

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('tool-call snapshot history', () => {
  let repoRoot = '';

  afterEach(async () => {
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    repoRoot = '';
  });

  async function createHome(): Promise<string> {
    const directory = await createTempDir(
      join(tmpdir(), 'ensemble-tool-calls-'),
    );
    vi.stubEnv('HOME', directory);
    return directory;
  }

  it('round-trips a history file without making it a session resume store', async () => {
    repoRoot = await createHome();
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: 'agent-1',
      issueUrl: ISSUE_URL,
    });

    await saveToolCallSnapshotHistory(path, [ENTRY]);
    const paths = resolveEnsemblePaths({ repoRoot });
    expect(path).toBe(
      paths.canonicalToolCallHistoryPath(ISSUE_URL, 'agent-1'),
    );
    await expect(access(paths.toolCallHistoryPath('agent-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await expect(loadToolCallSnapshotHistory({
      repoRoot,
      conductorAgentId: 'agent-1',
      issueUrl: ISSUE_URL,
    })).resolves.toEqual({
      entries: [ENTRY],
      needsRewrite: false,
    });
    expect(path.endsWith('.json')).toBe(false);
  });

  it.each(['user-path-hash', 'project-legacy'] as const)(
    'promotes %s history to a missing slug file and leaves the legacy source intact',
    async (location) => {
      repoRoot = await createHome();
      const conductorAgentId = `agent-${location}-history`;
      const paths = resolveEnsemblePaths({ repoRoot });
      const canonicalPath = toolCallSnapshotHistoryPath({
        repoRoot,
        conductorAgentId,
        issueUrl: ISSUE_URL,
      });
      const legacyPath =
        location === 'user-path-hash'
          ? paths.toolCallHistoryPath(conductorAgentId)
          : paths.legacyToolCallHistoryPath(conductorAgentId);
      const legacyText = JSON.stringify({ version: 1, snapshots: [ENTRY] });
      await mkdir(dirname(legacyPath), { recursive: true });
      await writeFile(legacyPath, legacyText, 'utf8');

      await expect(
        loadToolCallSnapshotHistory({
          repoRoot,
          conductorAgentId,
          issueUrl: ISSUE_URL,
        }),
      ).resolves.toEqual({ entries: [ENTRY], needsRewrite: false });

      const sourceBefore = await readFile(legacyPath);
      const destination = await readFile(canonicalPath);
      const sourceAfter = await readFile(legacyPath);
      expect(sha256(destination)).toBe(sha256(sourceBefore));
      expect(sourceAfter).toEqual(sourceBefore);
      expect(sha256(sourceAfter)).toBe(sha256(sourceBefore));
    },
  );

  it('uses an existing slug history without merging a newer hash copy', async () => {
    repoRoot = await createHome();
    const conductorAgentId = 'agent-slug-history-wins';
    const paths = resolveEnsemblePaths({ repoRoot });
    const canonicalPath = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId,
      issueUrl: ISSUE_URL,
    });
    const legacyPath = paths.toolCallHistoryPath(conductorAgentId);
    const slugEntry = {
      ...ENTRY,
      snapshot: { ...ENTRY.snapshot, toolCallId: 'slug-call' },
    };
    const hashEntry = {
      ...ENTRY,
      snapshot: { ...ENTRY.snapshot, toolCallId: 'hash-call' },
    };
    await mkdir(dirname(canonicalPath), { recursive: true });
    await writeFile(
      canonicalPath,
      JSON.stringify({ version: 1, snapshots: [slugEntry] }),
      'utf8',
    );
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({ version: 1, snapshots: [hashEntry] }),
      'utf8',
    );

    await expect(
      loadToolCallSnapshotHistory({
        repoRoot,
        conductorAgentId,
        issueUrl: ISSUE_URL,
      }),
    ).resolves.toEqual({ entries: [slugEntry], needsRewrite: false });
  });

  it('does not delete an invalid legacy history file while reading fallback data', async () => {
    repoRoot = await createHome();
    const conductorAgentId = 'agent-invalid-legacy-history';
    const legacyPath = resolveEnsemblePaths({ repoRoot }).toolCallHistoryPath(
      conductorAgentId,
    );
    const legacyText = '{broken json';
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, legacyText, 'utf8');

    await expect(
      loadToolCallSnapshotHistory({
        repoRoot,
        conductorAgentId,
        issueUrl: ISSUE_URL,
      }),
    ).resolves.toMatchObject({
      entries: [],
      warning: expect.stringContaining('invalid'),
    });
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe(legacyText);
  });

  it('treats absent and corrupt history as optional data without deleting a slug file', async () => {
    repoRoot = await createHome();
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: 'agent-1',
      issueUrl: ISSUE_URL,
    });

    await expect(loadToolCallSnapshotHistory({
      repoRoot,
      conductorAgentId: 'agent-1',
      issueUrl: ISSUE_URL,
    })).resolves.toMatchObject({
      entries: [],
      needsRewrite: false,
    });

    await saveToolCallSnapshotHistory(path, [ENTRY]);
    await writeFile(path, '{broken json', 'utf8');
    await expect(loadToolCallSnapshotHistory({
      repoRoot,
      conductorAgentId: 'agent-1',
      issueUrl: ISSUE_URL,
    })).resolves.toMatchObject({
      entries: [],
      warning: expect.stringContaining('invalid'),
    });
    await expect(access(path)).resolves.toBeUndefined();
  });

  it('preserves an invalid slug history and does not replace it with legacy history', async () => {
    repoRoot = await createHome();
    const conductorAgentId = 'agent-invalid-slug-history';
    const paths = resolveEnsemblePaths({ repoRoot });
    const canonicalPath = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId,
      issueUrl: ISSUE_URL,
    });
    const hashPath = paths.toolCallHistoryPath(conductorAgentId);
    const canonicalText = '{broken slug history';
    const hashText = JSON.stringify({ version: 1, snapshots: [ENTRY] });
    await mkdir(dirname(canonicalPath), { recursive: true });
    await writeFile(canonicalPath, canonicalText, 'utf8');
    await mkdir(dirname(hashPath), { recursive: true });
    await writeFile(hashPath, hashText, 'utf8');

    await expect(
      loadToolCallSnapshotHistory({ repoRoot, conductorAgentId, issueUrl: ISSUE_URL }),
    ).resolves.toMatchObject({
      entries: [],
      warning: expect.stringContaining('invalid'),
    });
    await expect(readFile(canonicalPath, 'utf8')).resolves.toBe(canonicalText);
    await expect(readFile(hashPath, 'utf8')).resolves.toBe(hashText);
  });

  it('skips malformed entries while preserving valid history', async () => {
    repoRoot = await createHome();
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: 'agent-1',
      issueUrl: ISSUE_URL,
    });
    await saveToolCallSnapshotHistory(path, [ENTRY]);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        snapshots: [
          ENTRY,
          { ...ENTRY, sessionId: 17 },
        ],
      }),
      'utf8',
    );

    await expect(loadToolCallSnapshotHistory({
      repoRoot,
      conductorAgentId: 'agent-1',
      issueUrl: ISSUE_URL,
    })).resolves.toMatchObject({
      entries: [ENTRY],
      needsRewrite: true,
      warning: expect.stringContaining('1 invalid entry'),
    });
  });

  it('skips future-dated entries and marks the history for rewrite', async () => {
    repoRoot = await createHome();
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: 'agent-future-entry',
      issueUrl: ISSUE_URL,
    });
    const now = Date.now();
    const validEntry = { ...ENTRY, updatedAt: now - 1_000 };
    const futureEntry = {
      ...ENTRY,
      updatedAt: now + 1,
      snapshot: {
        ...ENTRY.snapshot,
        toolCallId: 'call-future',
        rawInput: { command: 'private command' },
      },
    };
    await saveToolCallSnapshotHistory(path, [validEntry, futureEntry]);

    await expect(loadToolCallSnapshotHistory({
      repoRoot,
      conductorAgentId: 'agent-future-entry',
      issueUrl: ISSUE_URL,
      now,
    })).resolves.toMatchObject({
      entries: [validEntry],
      needsRewrite: true,
      warning: expect.stringContaining('1 invalid entry'),
    });
  });

  it('keeps unsupported slug history formats without failing the session', async () => {
    repoRoot = await createHome();
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: 'agent-legacy',
      issueUrl: ISSUE_URL,
    });
    await saveToolCallSnapshotHistory(path, [ENTRY]);
    await writeFile(
      path,
      JSON.stringify({
        snapshots: [
          {
            workerId: ENTRY.workerId,
            sessionId: ENTRY.sessionId,
            snapshot: ENTRY.snapshot,
          },
        ],
      }),
      'utf8',
    );

    await expect(loadToolCallSnapshotHistory({
      repoRoot,
      conductorAgentId: 'agent-legacy',
      issueUrl: ISSUE_URL,
    })).resolves.toMatchObject({
      entries: [],
      needsRewrite: false,
      warning: expect.stringContaining('unsupported format'),
    });
    await expect(access(path)).resolves.toBeUndefined();
  });

  it('rejects a history larger than the configured file limit', async () => {
    repoRoot = await createHome();
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: 'agent-too-large',
      issueUrl: ISSUE_URL,
    });
    await saveToolCallSnapshotHistory(path, [ENTRY]);

    await expect(saveToolCallSnapshotHistory(path, [{
      ...ENTRY,
      snapshot: {
        ...ENTRY.snapshot,
        rawInput: { value: 'x'.repeat(TOOL_CALL_SNAPSHOT_HISTORY_MAX_BYTES) },
      },
    }])).rejects.toThrow('exceeds its configured limit');
  });

  it('drops expired entries and deletes empty history files', async () => {
    repoRoot = await createHome();
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: 'agent-expired',
      issueUrl: ISSUE_URL,
    });
    const now = Date.now();
    const expiredEntry = {
      ...ENTRY,
      updatedAt: now - TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS - 1,
    };
    await saveToolCallSnapshotHistory(path, [expiredEntry]);

    await expect(loadToolCallSnapshotHistory({
      repoRoot,
      conductorAgentId: 'agent-expired',
      issueUrl: ISSUE_URL,
      now,
    })).resolves.toMatchObject({
      entries: [],
      needsRewrite: true,
    });
    await saveToolCallSnapshotHistory(path, []);
    await expect(access(path)).rejects.toThrow();
  });

  it('removes inactive history files after the retention window', async () => {
    repoRoot = await createHome();
    const conductorAgentId = 'agent-inactive';
    const paths = resolveEnsemblePaths({ repoRoot });
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId,
      issueUrl: ISSUE_URL,
    });
    const legacyPath = paths.toolCallHistoryPath(conductorAgentId);
    const projectPath = paths.legacyToolCallHistoryPath(conductorAgentId);
    await saveToolCallSnapshotHistory(path, [ENTRY]);
    await saveToolCallSnapshotHistory(legacyPath, [ENTRY]);
    await saveToolCallSnapshotHistory(projectPath, [ENTRY]);
    const oldTime = (Date.now() - TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS - 1000) / 1000;
    await utimes(path, oldTime, oldTime);
    await utimes(legacyPath, oldTime, oldTime);
    await utimes(projectPath, oldTime, oldTime);

    await expect(
      pruneExpiredToolCallSnapshotHistoryFiles({
        repoRoot,
        issueUrl: ISSUE_URL,
      }),
    ).resolves.toEqual({ removedCount: 1, failedCount: 0 });
    await expect(access(path)).rejects.toThrow();
    await expect(access(legacyPath)).resolves.toBeUndefined();
    await expect(access(projectPath)).resolves.toBeUndefined();
  });

  it('removes expired atomic-write temp files', async () => {
    repoRoot = await createHome();
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: 'agent-stale-temp',
      issueUrl: ISSUE_URL,
    });
    await saveToolCallSnapshotHistory(path, [ENTRY]);
    const tempPath = `${path}.tmp`;
    await writeFile(tempPath, 'partial private snapshot', 'utf8');
    const oldTime = (Date.now() - TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS - 1000) / 1000;
    await utimes(tempPath, oldTime, oldTime);

    await expect(
      pruneExpiredToolCallSnapshotHistoryFiles({
        repoRoot,
        issueUrl: ISSUE_URL,
      }),
    ).resolves.toEqual({ removedCount: 1, failedCount: 0 });
    await expect(access(tempPath)).rejects.toThrow();
  });
});
