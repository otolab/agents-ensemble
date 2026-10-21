import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startOpenQuestionControlServer,
} from '@agents-ensemble/core';
import { createOperatorDispatchQueue } from './operator-dispatch.js';
import {
  createOperatorWatchPool,
  operatorWatchStatePath,
} from './operator-watch-pool.js';

describe('operator watch pool', () => {
  let repoRoot = '';
  let closeServers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closeServers) await close();
    closeServers = [];
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    repoRoot = '';
  });

  it('watches multiple sessions through live UDS and persists cursors without replay', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => ({
        sequence: 1,
        openQuestions: [
          {
            id: 'inq-1',
            question: 'Review the release?',
            responseType: 'yes_no',
            source: 'conductor',
            status: 'open',
            askedAt: 10,
          },
        ],
        sessionState: {
          current: { statusLine: 'CI 待ち', reportedAt: 20 },
          history: [],
        },
      }),
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());
    await writeSidecar('live-one', 1, liveServer.socketPath);
    await writeSidecar('offline-two', 2, '/tmp/no-such-ensemble-socket');
    await writeOfflineSnapshots('offline-two', {
      sequence: 1,
      questions: [
        {
          id: 'inq-1',
          question: 'Choose an approach?',
          responseType: 'choice',
          source: 'conductor',
          status: 'open',
          askedAt: 30,
        },
      ],
      statusLine: 'レビュー中',
      reportedAt: 40,
    });

    const dispatchQueue = createOperatorDispatchQueue();
    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue,
    });
    try {
      await pool.register('live-one', { pollIntervalMs: 60_000, debounceMs: 0 });
      await pool.register('offline-two', { pollIntervalMs: 60_000, debounceMs: 0 });
      expect(await pool.pollOnce('live-one')).toBe(2);
      expect(await pool.pollOnce('offline-two')).toBe(2);

      const firstBatch = dispatchQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      );
      expect(firstBatch?.sourceKey).toBe('open_question:live-one');
      expect(firstBatch?.events[0]?.text).toContain('Review the release?');
      expect(dispatchQueue.pendingEventCount).toBe(3);
      await pool.acknowledge(firstBatch!.events);

      expect(await pool.pollOnce('live-one')).toBe(0);
      expect(await pool.pollOnce('offline-two')).toBe(0);
      const stored = JSON.parse(
        await readFile(operatorWatchStatePath(repoRoot), 'utf8'),
      ) as { cursors: Record<string, { sequence: number }> };
      expect(stored.cursors['live-one']?.sequence).toBe(1);
      expect(stored.cursors['offline-two']?.sequence).toBe(1);
      pool.close();

      const resumedQueue = createOperatorDispatchQueue();
      const resumedPool = await createOperatorWatchPool({
        repoRoot,
        dispatchQueue: resumedQueue,
      });
      try {
        expect(resumedQueue.pendingEventCount).toBe(3);
      } finally {
        resumedPool.close();
      }
    } finally {
      pool.close();
    }
  });

  it('restores unacknowledged reports after restart and removes only acknowledged reports', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-retry-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    await writeSidecar('session-retry', 1);
    await writeOfflineSnapshots('session-retry', {
      sequence: 1,
      questions: [
        {
          id: 'inq-1',
          question: 'Retry after cancellation?',
          responseType: 'text',
          source: 'conductor',
          status: 'open',
          askedAt: 10,
        },
      ],
      statusLine: 'waiting',
      reportedAt: 20,
    });

    const firstQueue = createOperatorDispatchQueue();
    const firstPool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: firstQueue,
    });
    await firstPool.register('session-retry', {
      pollIntervalMs: 60_000,
      debounceMs: 0,
    });
    expect(await firstPool.pollOnce('session-retry')).toBe(2);
    const firstAttempt = firstQueue.takeBatch(
      { continuationConsumed: false },
      Date.now(),
    )!;
    const firstReportId = firstAttempt.events[0]!.reportId;
    expect(firstReportId).toBeTruthy();
    expect(firstQueue.pendingEventCount).toBe(1);
    firstPool.close();

    const resumedQueue = createOperatorDispatchQueue();
    const resumedPool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: resumedQueue,
    });
    try {
      expect(resumedQueue.pendingEventCount).toBe(2);
      const retry = resumedQueue.takeBatch(
        { continuationConsumed: false },
        Date.now(),
      )!;
      expect(retry.events[0]?.reportId).toBe(firstReportId);

      await resumedPool.acknowledge(retry.events);
      const stored = JSON.parse(
        await readFile(operatorWatchStatePath(repoRoot), 'utf8'),
      ) as { pendingReports: Array<{ reportId: string }> };
      expect(stored.pendingReports).toHaveLength(1);
      expect(stored.pendingReports[0]?.reportId).not.toBe(firstReportId);
    } finally {
      resumedPool.close();
    }
  });

  it('registers and removes watches through bounded tools', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-tools-'));
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    await writeSidecar('session-one', 1);
    const pool = await createOperatorWatchPool({
      repoRoot,
      dispatchQueue: createOperatorDispatchQueue(),
    });
    try {
      const watch = await pool.register('session-one', {
        pollIntervalMs: 500,
        debounceMs: 1_000,
      });
      expect(watch).toMatchObject({
        conductorAgentId: 'session-one',
        pollIntervalMs: 500,
        debounceMs: 1_000,
      });
      await expect(
        pool.register('session-one', { pollIntervalMs: 100 }),
      ).rejects.toThrow('pollIntervalMs must be an integer');
      await expect(pool.unregister('session-one')).resolves.toBe(true);
      expect(pool.list()).toEqual([]);
    } finally {
      pool.close();
    }
  });

  async function writeSidecar(
    agentId: string,
    updatedAt: number,
    harnessSocketPath?: string,
  ) {
    await writeFile(
      join(repoRoot, '.ensemble', 'sessions', `${agentId}.json`),
      JSON.stringify({
        version: 1,
        conductorAgentId: agentId,
        issueUrl: `https://github.com/example/repo/issues/${agentId}`,
        repoRoot,
        ...(harnessSocketPath ? { harnessSocketPath } : {}),
        profile: { workers: [], agents: {} },
        openQuestions: [],
        sequence: 0,
        workers: {},
        updatedAt,
      }),
    );
  }

  async function writeOfflineSnapshots(
    agentId: string,
    input: {
      sequence: number;
      questions: Array<Record<string, unknown>>;
      statusLine: string;
      reportedAt: number;
    },
  ) {
    const sessionDir = join(repoRoot, '.ensemble', 'sessions', agentId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'open-questions.yaml'),
      [
        'version: 1',
        `sequence: ${input.sequence}`,
        'openQuestions:',
        ...input.questions.flatMap((question) => [
          `  - id: ${question.id}`,
          `    question: "${question.question}"`,
          `    responseType: ${question.responseType}`,
          `    source: ${question.source}`,
          `    status: ${question.status}`,
          `    askedAt: ${question.askedAt}`,
        ]),
        '',
      ].join('\n'),
    );
    await writeFile(
      join(sessionDir, 'session-state.yaml'),
      `version: 1\nstatusLine: "${input.statusLine}"\nreportedAt: ${input.reportedAt}\n`,
    );
  }
});
