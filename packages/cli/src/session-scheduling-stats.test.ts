import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSchedulingStats } from './session-scheduling-stats.js';

describe('scheduling statistics', () => {
  it('correlates outside the window, counts retries and reports missing records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scheduling-stats-'));
    try {
      const directory = join(root, 'operator-agents', 'default');
      await mkdir(directory, { recursive: true });
      const events = [
        { type: 'report.queued', ts: 1, reportId: 'r', reportType: 'session_state', firstQueuedAt: 1 },
        { type: 'report.queued', ts: 1, reportId: 'r', reportType: 'session_state', firstQueuedAt: 1 },
        { type: 'batch.committed', ts: 2, batchId: 'b', reportIds: ['r'], readyReason: 'oq', deadlineReason: 'cap' },
        { type: 'report.deferred_by_focus', ts: 3, reportId: 'r' },
        { type: 'batch.sent', ts: 4, batchId: 'b', startedAt: 4, deliveryKind: 'initial' },
        { type: 'batch.sent', ts: 5, batchId: 'b', startedAt: 5, deliveryKind: 'frozen_replay' },
        { type: 'batch.sent', ts: 6, batchId: 'missing', startedAt: 6 },
      ];
      await writeFile(join(directory, 'scheduling-events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n{bad\n`);
      const stats = await readSchedulingStats({ root, profile: 'default', since: '1970-01-01T00:00:00.004Z', until: '1970-01-01T00:00:00.006Z' });
      expect(stats.queued).toBe(0);
      expect(stats.sends).toBe(2);
      expect(stats.aggregationRate).toBe(1);
      expect(stats.readyReasons).toEqual({});
      expect(stats.deadlineReasons).toEqual({});
      expect(stats.capFraction).toBeNull();
      expect(stats.deliveries).toEqual({ initial: 1, frozenReplay: 1, unknown: 0 });
      expect(stats.latency['session_state/deferred']).toEqual({ count: 2, p50Ms: 3, p95Ms: 4, maxMs: 4 });
      expect(stats.correlation).toEqual({ matched: 2, missing: 0, malformed: 1, duplicates: 1 });
      expect((await readSchedulingStats({ root, profile: 'default' })).correlation.missing).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('counts cap once per committed batch and identifies replays after rotation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scheduling-retry-'));
    try {
      const directory = join(root, 'operator-agents', 'default');
      await mkdir(directory, { recursive: true });
      const previous = [
        { type: 'batch.committed', ts: 10, batchId: 'cap', reportIds: [], deadlineReason: 'cap' },
        { type: 'batch.committed', ts: 11, batchId: 'quiet', reportIds: [], deadlineReason: 'quiet' },
        { type: 'batch.committed', ts: 11, batchId: 'unknown', reportIds: [], deadlineReason: 'unknown' },
        { type: 'batch.committed', ts: 11, batchId: 'tie', reportIds: [], deadlineReason: 'tie' },
        { type: 'batch.committed', ts: 11, batchId: 'cap', reportIds: [], deadlineReason: 'cap' },
        { type: 'batch.sent', ts: 12, batchId: 'cap', deliveryKind: 'initial' },
      ];
      const current = Array.from({ length: 10 }, (_, i) => ({ type: 'batch.sent', ts: 20 + i, batchId: 'cap', deliveryKind: 'frozen_replay' }));
      await writeFile(join(directory, 'scheduling-events.jsonl.1'), previous.map((event) => JSON.stringify(event)).join('\n'));
      await writeFile(join(directory, 'scheduling-events.jsonl'), current.map((event) => JSON.stringify(event)).join('\n'));
      const all = await readSchedulingStats({ root });
      expect(all.capFraction).toBe(0.5);
      expect(all.deadlineReasons).toEqual({ cap: 1, quiet: 1, unknown: 1, tie: 1 });
      expect(all.correlation.duplicates).toBe(1);
      expect(all.deliveries).toEqual({ initial: 1, frozenReplay: 10, unknown: 0 });
      const duplicateWindow = await readSchedulingStats({ root, since: '1970-01-01T00:00:00.011Z', until: '1970-01-01T00:00:00.012Z' });
      expect(duplicateWindow.deadlineReasons).toEqual({ quiet: 1, unknown: 1, tie: 1 });
      expect(duplicateWindow.capFraction).toBe(0);
      const later = await readSchedulingStats({ root, since: '1970-01-01T00:00:00.020Z' });
      expect(later.capFraction).toBeNull();
      expect(later.deliveries).toEqual({ initial: 0, frozenReplay: 10, unknown: 0 });
      await rm(join(directory, 'scheduling-events.jsonl.1'));
      const rotated = await readSchedulingStats({ root });
      expect(rotated.deliveries.frozenReplay).toBe(10);
      expect(rotated.correlation.missing).toBe(10);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
