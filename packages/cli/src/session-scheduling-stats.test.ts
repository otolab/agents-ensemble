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
        { type: 'batch.sent', ts: 4, batchId: 'b', startedAt: 4 },
        { type: 'batch.sent', ts: 5, batchId: 'b', startedAt: 5 },
        { type: 'batch.sent', ts: 6, batchId: 'missing', startedAt: 6 },
      ];
      await writeFile(join(directory, 'scheduling-events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n{bad\n`);
      const stats = await readSchedulingStats({ root, profile: 'default', since: '1970-01-01T00:00:00.004Z', until: '1970-01-01T00:00:00.006Z' });
      expect(stats.queued).toBe(0);
      expect(stats.sends).toBe(2);
      expect(stats.aggregationRate).toBe(1);
      expect(stats.readyReasons).toEqual({ oq: 2 });
      expect(stats.deadlineReasons).toEqual({ cap: 2 });
      expect(stats.capFraction).toBe(1);
      expect(stats.latency['session_state/deferred']).toEqual({ count: 2, p50Ms: 3, p95Ms: 4, maxMs: 4 });
      expect(stats.correlation).toEqual({ matched: 2, missing: 0, malformed: 1, duplicates: 1 });
      expect((await readSchedulingStats({ root, profile: 'default' })).correlation.missing).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
