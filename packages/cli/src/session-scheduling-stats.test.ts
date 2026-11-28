import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readSchedulingStats } from './session-scheduling-stats.js';

describe('scheduling statistics', () => {
  it('reads the selected config namespace and preserves the legacy default namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scheduling-config-scope-'));
    try {
      const defaultConfig = join(root, 'operator-agents.config.yaml');
      const alternateConfig = join(root, 'alternate.yaml');
      await writeFile(defaultConfig, 'version: 1\nprofiles:\n  work: {}\n');
      await writeFile(alternateConfig, 'version: 1\nprofiles:\n  work: {}\n');
      const scope = createHash('sha256')
        .update(await realpath(alternateConfig))
        .digest('hex');
      const legacyDirectory = join(root, 'operator-agents', 'work');
      const alternateDirectory = join(
        root,
        'operator-agents',
        '.config-scopes',
        scope,
        'work',
      );
      await mkdir(legacyDirectory, { recursive: true });
      await mkdir(alternateDirectory, { recursive: true });
      await writeFile(
        join(legacyDirectory, 'scheduling-events.jsonl'),
        `${JSON.stringify({ type: 'report.queued', ts: 1, reportId: 'legacy' })}\n`,
      );
      await writeFile(
        join(alternateDirectory, 'scheduling-events.jsonl'),
        `${JSON.stringify({ type: 'report.queued', ts: 2, reportId: 'alternate' })}\n`,
      );

      const implicitDefault = await readSchedulingStats({ root });
      const explicitDefault = await readSchedulingStats({
        root,
        configPath: defaultConfig,
      });
      const alternate = await readSchedulingStats({
        root,
        configPath: alternateConfig,
      });
      expect(implicitDefault.profiles).toEqual(['work']);
      expect(implicitDefault.queued).toBe(1);
      expect(explicitDefault.queued).toBe(1);
      expect(alternate.profiles).toEqual(['work']);
      expect(alternate.queued).toBe(1);
      await expect(
        readSchedulingStats({
          root,
          configPath: join(root, 'missing-config.yaml'),
        }),
      ).rejects.toThrow(/Operator-agent config not found/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('correlates outside the window, counts retries and reports missing records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scheduling-stats-'));
    try {
      const directory = join(root, 'operator-agents', 'default');
      await mkdir(directory, { recursive: true });
      const events = [
        { type: 'report.queued', ts: 1, reportId: 'r', reportType: 'session_state', firstQueuedAt: 1 },
        { type: 'report.queued', ts: 1, reportId: 'r', reportType: 'session_state', firstQueuedAt: 1 },
        { type: 'batch.committed', ts: 2, batchId: 'b', reportIds: ['r'], readyReason: 'oq', deadlineReason: 'cap' },
        { type: 'report.deferred_by_focus', ts: 3, reportId: 'r', evidence: 'selection_counterfactual', schedulingInstanceId: 'one' },
        { type: 'batch.sent', ts: 4, batchId: 'b', startedAt: 4, schedulingInstanceId: 'one', deliveryKind: 'initial' },
        { type: 'batch.sent', ts: 5, batchId: 'b', startedAt: 5, schedulingInstanceId: 'one', deliveryKind: 'frozen_replay' },
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
      expect(stats.latencyByFocus['session_state/unknown']).toEqual({ count: 2, p50Ms: 3, p95Ms: 4, maxMs: 4 });
      expect(stats.correlation).toEqual({ matched: 2, missing: 0, malformed: 1, duplicates: 1 });
      expect((await readSchedulingStats({ root, profile: 'default' })).correlation.missing).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('uses observed focus selections from separate processes and marks legacy evidence unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'focus-stats-'));
    try {
      const fixture = fileURLToPath(new URL('../test/fixtures/focus-stats-child.mjs', import.meta.url));
      const run = promisify(execFile);
      const workers = await Promise.all([
        run(process.execPath, [fixture, 'low', '1', 'yes']),
        run(process.execPath, [fixture, 'ready', '10', 'yes']),
        run(process.execPath, [fixture, 'no-focus', '10', 'no']),
      ]);
      const events = workers.flatMap(({ stdout }) => JSON.parse(stdout) as Record<string, unknown>[]);
      events.push({ type: 'report.queued', ts: 100, reportId: 'old', reportType: 'session_state', firstQueuedAt: 100 },
        { type: 'report.deferred_by_focus', ts: 100, reportId: 'old' },
        { type: 'batch.committed', ts: 100, batchId: 'old', reportIds: ['old'] },
        { type: 'batch.sent', ts: 100, batchId: 'old', startedAt: 100 });
      const directory = join(root, 'operator-agents', 'default');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'scheduling-events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n'));
      const stats = await readSchedulingStats({ root });
      expect(stats.focus).toMatchObject({ deferred: 1, unverified: 1 });
      expect(stats.latency['session_state/deferred']?.count).toBe(1);
      expect(stats.latency['session_state/unknown_deferred']?.count).toBe(3);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('correlates the same report only within the sending process across restart and period boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'focus-peer-'));
    try {
      const fixture = fileURLToPath(new URL('../test/fixtures/focus-stats-child.mjs', import.meta.url));
      const run = promisify(execFile);
      const workers = await Promise.all([
        run(process.execPath, [fixture, 'a', '10', 'yes', 'shared']),
        run(process.execPath, [fixture, 'b', '10', 'no', 'shared']),
        run(process.execPath, [fixture, 'restart', '10', 'other', 'shared']),
      ]);
      const events = workers.flatMap(({ stdout }, index) => (JSON.parse(stdout) as Record<string, unknown>[]).map((event) =>
        event.type === 'batch.sent' ? { ...event, ...(index === 2 ? { batchId: 'a' } : {}), ts: 200 + index, startedAt: 200 + index, deliveryKind: index === 2 ? 'frozen_replay' : 'initial' } : event));
      events.push({ type: 'report.deferred_by_focus', ts: 101, reportId: 'shared', evidence: 'selection_counterfactual' },
        { type: 'batch.sent', ts: 203, batchId: 'a', startedAt: 203, focusState: 'off' });
      const directory = join(root, 'operator-agents', 'default');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'scheduling-events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n'));
      const all = await readSchedulingStats({ root });
      expect(all.latency['session_state/deferred']?.count).toBe(2);
      expect(all.latency['session_state/unknown_deferred']?.count).toBe(2);
      expect(all.focus).toMatchObject({ deferred: 2, unverified: 1 });
      expect(all.latencyByFocus).toMatchObject({
        'session_state/focused_session': { count: 1, p50Ms: 100, p95Ms: 100, maxMs: 100 },
        'session_state/off': { count: 1, p50Ms: 101, p95Ms: 101, maxMs: 101 },
        'session_state/other_session': { count: 1, p50Ms: 102, p95Ms: 102, maxMs: 102 },
        'session_state/unknown': { count: 1, p50Ms: 103, p95Ms: 103, maxMs: 103 },
      });
      expect(all.latencyByFocusPresence).toMatchObject({
        'session_state/on': { count: 2, p50Ms: 100, p95Ms: 102, maxMs: 102 },
        'session_state/off': { count: 1 }, 'session_state/unknown': { count: 1 },
      });
      const later = await readSchedulingStats({ root, since: '1970-01-01T00:00:00.201Z', until: '1970-01-01T00:00:00.203Z' });
      expect(later.latency['session_state/deferred']?.count).toBe(1);
      expect(later.latency['session_state/unknown_deferred']?.count).toBe(1);
      expect(later.deliveries.frozenReplay).toBe(1);
      expect(later.latencyByFocusPresence).toMatchObject({ 'session_state/off': { count: 1 }, 'session_state/on': { count: 1 } });
      const withoutFocusEvidence = events.filter((event) => event.type !== 'report.deferred_by_focus');
      await writeFile(join(directory, 'scheduling-events.jsonl'), withoutFocusEvidence.map((event) => JSON.stringify(event)).join('\n'));
      const missing = await readSchedulingStats({ root });
      expect(missing.latency['session_state/deferred']).toBeUndefined();
      expect(missing.latency['session_state/unknown_deferred']?.count).toBe(4);
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
