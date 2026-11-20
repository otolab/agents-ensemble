import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createOperatorDispatchQueue, DEFAULT_OPERATOR_DISPATCH_SCHEDULING } from './operator-dispatch.js';
import { createOperatorWatchPool } from './operator-watch-pool.js';
import { resolveEnsemblePaths } from '@agents-ensemble/core';
import { retryOperatorWatchAcknowledgement } from './operator-watch-ack.js';
import { withWatchStateLock } from './watch-state-store.js';
import { DatabaseSync } from 'node:sqlite';

describe('scheduling event persistence', () => {
  it('persists events independently of a held profile lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scheduling-lock-delay-'));
    let pool: Awaited<ReturnType<typeof createOperatorWatchPool>> | undefined;
    let release: () => void = () => {};
    try {
      const queue = createOperatorDispatchQueue();
      pool = await createOperatorWatchPool({ userEnsembleRoot: root, profile: 'default', autoDiscoverSessions: false, dispatchQueue: queue });
      let signalEntered: () => void = () => {};
      const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const lock = withWatchStateLock(root, 'default', async () => { signalEntered(); await gate; });
      await entered;
      pool.recordSchedulingEvent!({ type: 'focus.set', ts: Date.now(), conductorAgentId: 'one' });
      queue.enqueueUser('hello');
      expect(queue.selectBatch({ continuationConsumed: false })?.sourceKey).toBe('user');
      const flush = pool.flushSchedulingEvents!();
      await flush;
      expect(await readFile(join(root, 'operator-agents', 'default', 'scheduling-events.jsonl'), 'utf8')).toContain('focus.set');
      release();
      await lock;
    } finally { release(); pool?.close(); await pool?.flushSchedulingEvents?.(); await rm(root, { recursive: true, force: true }); }
  });

  it('serializes concurrent process writers without losing or interleaving events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scheduling-process-'));
    const fixture = fileURLToPath(new URL('../test/fixtures/scheduling-events-child.mjs', import.meta.url));
    try {
      const run = (id: string) => new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [fixture, root, id], { stdio: ['ignore', 'ignore', 'pipe'] });
        let errors = '';
        child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
        child.on('error', reject);
        child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`child ${id} exited ${code}: ${errors}`)));
      });
      const directory = join(root, 'operator-agents', 'default');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'scheduling-events.jsonl'), JSON.stringify({ type: 'padding', data: 'x'.repeat(5 * 1024 * 1024 - 100) }) + '\n');
      await Promise.all([run('a'), run('b')]);
      const files = await Promise.all(['scheduling-events.jsonl.1', 'scheduling-events.jsonl'].map((name) => readFile(join(directory, name), 'utf8')));
      const events = files.flatMap((text) => text.trim().split('\n').map((line) => JSON.parse(line) as { type: string; conductorAgentId: string })).filter((event) => event.type !== 'padding');
      expect(events).toHaveLength(48);
      expect(new Set(events.map((event) => event.conductorAgentId)).size).toBe(48);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps enqueue, durable commit and acknowledgement moving while the event lock is held', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scheduling-event-stall-'));
    let pool: Awaited<ReturnType<typeof createOperatorWatchPool>> | undefined;
    let database: DatabaseSync | undefined;
    try {
      const issueUrl = 'https://github.com/example/repo/issues/1';
      const path = resolveEnsemblePaths({ repoRoot: root, userEnsembleRoot: root }).canonicalSessionResumeStorePath(issueUrl, 'one');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ version: 1, conductorAgentId: 'one', issueUrl, repoRoot: root, profile: { workers: [], agents: {} }, openQuestions: [], sequence: 0, workers: {}, updatedAt: Date.now() }));
      const directory = join(root, 'operator-agents', 'default');
      await mkdir(directory, { recursive: true });
      database = new DatabaseSync(join(directory, 'scheduling-events-lock.sqlite'));
      database.exec('BEGIN IMMEDIATE');
      const queue = createOperatorDispatchQueue();
      pool = await createOperatorWatchPool({ userEnsembleRoot: root, profile: 'default', autoDiscoverSessions: false, dispatchQueue: queue });
      const lifecycle = (async () => {
        await pool!.enqueueIdleCandidate!({ conductorAgentId: 'one', text: 'candidate', kind: 'idle_phase', fingerprint: 'fp', eligibleAt: Date.now() });
        const batch = queue.selectBatch({ continuationConsumed: false })!;
        expect(await pool!.commitBatch(batch, { continuationConsumed: false })).toBe(true);
        await pool!.acknowledge(batch.events);
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([lifecycle, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('state lifecycle blocked by event writer')), 400); })]); }
      finally { if (timer) clearTimeout(timer); }
      pool.close();
      const start = Date.now();
      await pool.flushSchedulingEvents?.();
      expect(Date.now() - start).toBeLessThan(1200);
    } finally { database?.exec('ROLLBACK'); database?.close(); pool?.close(); await pool?.flushSchedulingEvents?.(); await rm(root, { recursive: true, force: true }); }
  });

  it('uses one fresh scheduling instance ID per pool for focus and send events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scheduling-instance-'));
    let first: Awaited<ReturnType<typeof createOperatorWatchPool>> | undefined;
    let second: Awaited<ReturnType<typeof createOperatorWatchPool>> | undefined;
    try {
      const makePool = () => createOperatorWatchPool({ userEnsembleRoot: root, profile: 'default', autoDiscoverSessions: false, dispatchQueue: createOperatorDispatchQueue() });
      first = await makePool();
      second = await makePool();
      first.recordSchedulingEvent!({ type: 'report.deferred_by_focus', ts: 1, reportId: 'shared', evidence: 'selection_counterfactual' });
      first.recordSchedulingEvent!({ type: 'batch.sent', ts: 2, batchId: 'a' });
      second.recordSchedulingEvent!({ type: 'batch.sent', ts: 3, batchId: 'b' });
      await Promise.all([first.flushSchedulingEvents!(), second.flushSchedulingEvents!()]);
      const events = (await readFile(join(root, 'operator-agents', 'default', 'scheduling-events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string; batchId?: string; schedulingInstanceId?: string });
      const deferred = events.find((event) => event.type === 'report.deferred_by_focus')!;
      const a = events.find((event) => event.batchId === 'a')!;
      const b = events.find((event) => event.batchId === 'b')!;
      expect(deferred.schedulingInstanceId).toEqual(expect.any(String));
      expect(a.schedulingInstanceId).toBe(deferred.schedulingInstanceId);
      expect(b.schedulingInstanceId).toEqual(expect.any(String));
      expect(b.schedulingInstanceId).not.toBe(a.schedulingInstanceId);
    } finally {
      first?.close(); second?.close();
      await Promise.all([first?.flushSchedulingEvents?.(), second?.flushSchedulingEvents?.()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains frozen report identity and first queue time after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scheduling-restart-'));
    let pool: Awaited<ReturnType<typeof createOperatorWatchPool>> | undefined;
    try {
      const issueUrl = 'https://github.com/example/repo/issues/1';
      const path = resolveEnsemblePaths({ repoRoot: root, userEnsembleRoot: root }).canonicalSessionResumeStorePath(issueUrl, 'one');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ version: 1, conductorAgentId: 'one', issueUrl, repoRoot: root, profile: { workers: [], agents: {} }, openQuestions: [], sequence: 0, workers: {}, updatedAt: Date.now() }));
      const queue = createOperatorDispatchQueue();
      pool = await createOperatorWatchPool({ userEnsembleRoot: root, profile: 'default', autoDiscoverSessions: false, dispatchQueue: queue });
      const id = await pool.enqueueIdleCandidate!({ conductorAgentId: 'one', text: 'candidate', kind: 'idle_phase', fingerprint: 'fingerprint', eligibleAt: Date.now() });
      const batch = queue.selectBatch({ continuationConsumed: false })!;
      expect(await pool.commitBatch(batch, { continuationConsumed: false })).toBe(true);
      const firstQueuedAt = batch.events[0]?.type === 'report' ? batch.events[0].firstQueuedAt : undefined;
      pool.close();
      await pool.flushSchedulingEvents?.();
      const replayQueue = createOperatorDispatchQueue();
      pool = await createOperatorWatchPool({ userEnsembleRoot: root, profile: 'default', autoDiscoverSessions: false, dispatchQueue: replayQueue });
      const replay = replayQueue.selectBatch({ continuationConsumed: false })!;
      expect(replay.batchId).toBe(batch.batchId);
      expect(replay.events[0]).toMatchObject({ reportId: id, firstQueuedAt });
      await pool.acknowledge(replay.events);
    } finally { pool?.close(); await pool?.flushSchedulingEvents?.(); await rm(root, { recursive: true, force: true }); }
  });

  it.each([false, true])('records queue, commit and ack without changing delivery when writing fails=%s', async (fail) => {
    const root = await mkdtemp(join(tmpdir(), 'scheduling-lifecycle-'));
    let pool: Awaited<ReturnType<typeof createOperatorWatchPool>> | undefined;
    try {
      const issueUrl = 'https://github.com/example/repo/issues/1';
      const path = resolveEnsemblePaths({ repoRoot: root, userEnsembleRoot: root }).canonicalSessionResumeStorePath(issueUrl, 'one');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ version: 1, conductorAgentId: 'one', issueUrl, repoRoot: root, profile: { workers: [], agents: {} }, openQuestions: [], sequence: 0, workers: {}, updatedAt: Date.now() }));
      if (fail) await mkdir(join(root, 'operator-agents', 'default', 'scheduling-events.jsonl'), { recursive: true });
      const queue = createOperatorDispatchQueue();
      const errors: string[] = [];
      pool = await createOperatorWatchPool({ userEnsembleRoot: root, profile: 'default', autoDiscoverSessions: false, dispatchQueue: queue, onError: (message) => errors.push(message) });
      const id = await pool.enqueueIdleCandidate!({ conductorAgentId: 'one', text: 'secret', kind: 'idle_phase', fingerprint: 'fingerprint', eligibleAt: Date.now(), evidence: { phase: 'idle', ageMs: 100, thresholdMs: 50 } });
      expect(id).toBeDefined();
      const batch = queue.selectBatch({ continuationConsumed: false });
      expect(batch).toBeDefined();
      expect(await pool.commitBatch(batch!, { continuationConsumed: false })).toBe(true);
      let attempts = 0;
      const acknowledgement = await retryOperatorWatchAcknowledgement(async () => {
        attempts++;
        if (attempts === 1) throw new Error('transient ack failure');
        await pool!.acknowledge(batch!.events);
      }, async () => false);
      expect(acknowledgement).toMatchObject({ status: 'acknowledged', attempts: 2, retries: 1 });
      expect(queue.selectBatch({ continuationConsumed: false })).toBeUndefined();
      await pool.flushSchedulingEvents?.();
      if (fail) expect(errors.some((message) => message.includes('scheduling event write failed'))).toBe(true);
      else {
        const text = await readFile(join(root, 'operator-agents', 'default', 'scheduling-events.jsonl'), 'utf8');
        const events = text.trim().split('\n').map((line) => JSON.parse(line));
        expect(events.map((event) => event.type)).toEqual(['report.queued', 'batch.committed', 'report.acked']);
        expect(events[0]).toMatchObject({ reportId: id, evidence: { phase: 'idle', ageMs: 100, thresholdMs: 50 } });
        expect(events[2].reportId).toBe(id);
        expect(text).not.toContain('secret');
      }
    } finally { pool?.close(); await pool?.flushSchedulingEvents?.(); await rm(root, { recursive: true, force: true }); }
  });

  it.each([false, true])('flushes focus events without changing scheduling when writing fails=%s', async (fail) => {
    const root = await mkdtemp(join(tmpdir(), 'scheduling-events-'));
    let pool: Awaited<ReturnType<typeof createOperatorWatchPool>> | undefined;
    const errors: string[] = [];
    try {
      if (fail) await mkdir(join(root, 'operator-agents', 'default', 'scheduling-events.jsonl'), { recursive: true });
      const queue = createOperatorDispatchQueue(DEFAULT_OPERATOR_DISPATCH_SCHEDULING, undefined, (event) => pool?.recordSchedulingEvent?.(event));
      pool = await createOperatorWatchPool({ userEnsembleRoot: root, profile: 'default', autoDiscoverSessions: false, dispatchQueue: queue, onError: (message) => errors.push(message) });
      const now = Date.now();
      queue.setFocus('one', now);
      queue.enqueueReport({ type: 'report', reportId: 'r', reportType: 'session_state', conductorAgentId: 'one', issueUrl: 'https://github.com/a/b/issues/1', text: 'x' }, 0);
      expect(queue.selectBatch({ continuationConsumed: false })?.sourceKey).toBe('session:one');
      queue.setFocus(undefined, now + 1);
      await pool.flushSchedulingEvents?.();
      expect(queue.selectBatch({ continuationConsumed: false })?.sourceKey).toBe('session:one');
      if (fail) expect(errors.some((message) => message.includes('scheduling event write failed'))).toBe(true);
      else {
        const events = (await readFile(join(root, 'operator-agents', 'default', 'scheduling-events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(events).toMatchObject([{ type: 'focus.set', ts: now }, { type: 'focus.clear', ts: now + 1, reason: 'manual' }]);
      }
    } finally { pool?.close(); await pool?.flushSchedulingEvents?.(); await rm(root, { recursive: true, force: true }); }
  });
});
