import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createOperatorDispatchQueue, DEFAULT_OPERATOR_DISPATCH_SCHEDULING } from './operator-dispatch.js';
import { createOperatorWatchPool } from './operator-watch-pool.js';
import { resolveEnsemblePaths } from '@agents-ensemble/core';
import { retryOperatorWatchAcknowledgement } from './operator-watch-ack.js';
import { withWatchStateLock } from './watch-state-store.js';

describe('scheduling event persistence', () => {
  it('keeps the dispatch queue usable while an event waits for a held profile lock', async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      await lock;
      await flush;
      expect(await readFile(join(root, 'operator-agents', 'default', 'scheduling-events.jsonl'), 'utf8')).toContain('focus.set');
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
      await Promise.all([run('a'), run('b')]);
      const text = await readFile(join(root, 'operator-agents', 'default', 'scheduling-events.jsonl'), 'utf8');
      const events = text.trim().split('\n').map((line) => JSON.parse(line) as { conductorAgentId: string });
      expect(events).toHaveLength(48);
      expect(new Set(events.map((event) => event.conductorAgentId)).size).toBe(48);
    } finally { await rm(root, { recursive: true, force: true }); }
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
      if (!fail) {
        await vi.waitFor(async () => {
          const text = await readFile(join(root, 'operator-agents', 'default', 'scheduling-events.jsonl'), 'utf8');
          expect(text).toContain('focus.clear');
        });
      }
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
