import { access, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('tool-call snapshot history', () => {
  let repoRoot = '';

  afterEach(async () => {
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    repoRoot = '';
  });

  it('round-trips a history file without making it a session resume store', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-tool-calls-'));
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: 'agent-1',
    });

    await saveToolCallSnapshotHistory(path, [ENTRY]);

    await expect(loadToolCallSnapshotHistory({
      repoRoot,
      conductorAgentId: 'agent-1',
    })).resolves.toEqual({
      entries: [ENTRY],
      needsRewrite: false,
    });
    expect(path.endsWith('.json')).toBe(false);
  });

  it('treats absent and corrupt history as optional data', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-tool-calls-'));
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: 'agent-1',
    });

    await expect(loadToolCallSnapshotHistory({
      repoRoot,
      conductorAgentId: 'agent-1',
    })).resolves.toMatchObject({
      entries: [],
      needsRewrite: false,
    });

    await saveToolCallSnapshotHistory(path, [ENTRY]);
    await writeFile(path, '{broken json', 'utf8');
    await expect(loadToolCallSnapshotHistory({
      repoRoot,
      conductorAgentId: 'agent-1',
    })).resolves.toMatchObject({
      entries: [],
      warning: expect.stringContaining('invalid'),
    });
    await expect(access(path)).rejects.toThrow();
  });

  it('skips malformed entries while preserving valid history', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-tool-calls-'));
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: 'agent-1',
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
    })).resolves.toMatchObject({
      entries: [ENTRY],
      needsRewrite: true,
      warning: expect.stringContaining('1 invalid entry'),
    });
  });

  it('skips future-dated entries and marks the history for rewrite', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-tool-calls-'));
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: 'agent-future-entry',
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
      now,
    })).resolves.toMatchObject({
      entries: [validEntry],
      needsRewrite: true,
      warning: expect.stringContaining('1 invalid entry'),
    });
  });

  it('discards legacy history formats without failing the session', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-tool-calls-'));
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: 'agent-legacy',
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
    })).resolves.toMatchObject({
      entries: [],
      needsRewrite: false,
      warning: expect.stringContaining('unsupported format'),
    });
    await expect(access(path)).rejects.toThrow();
  });

  it('rejects a history larger than the configured file limit', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-tool-calls-'));
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: 'agent-too-large',
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
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-tool-calls-'));
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: 'agent-expired',
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
      now,
    })).resolves.toMatchObject({
      entries: [],
      needsRewrite: true,
    });
    await saveToolCallSnapshotHistory(path, []);
    await expect(access(path)).rejects.toThrow();
  });

  it('removes inactive history files after the retention window', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-tool-calls-'));
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: 'agent-inactive',
    });
    await saveToolCallSnapshotHistory(path, [ENTRY]);
    const oldTime = (Date.now() - TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS - 1000) / 1000;
    await utimes(path, oldTime, oldTime);

    await expect(
      pruneExpiredToolCallSnapshotHistoryFiles(repoRoot),
    ).resolves.toEqual({ removedCount: 1, failedCount: 0 });
    await expect(access(path)).rejects.toThrow();
  });

  it('removes expired atomic-write temp files', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-tool-calls-'));
    const path = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: 'agent-stale-temp',
    });
    await saveToolCallSnapshotHistory(path, [ENTRY]);
    const tempPath = `${path}.tmp`;
    await writeFile(tempPath, 'partial private snapshot', 'utf8');
    const oldTime = (Date.now() - TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS - 1000) / 1000;
    await utimes(tempPath, oldTime, oldTime);

    await expect(
      pruneExpiredToolCallSnapshotHistoryFiles(repoRoot),
    ).resolves.toEqual({ removedCount: 1, failedCount: 0 });
    await expect(access(tempPath)).rejects.toThrow();
  });
});
