import {
  resolveEnsemblePaths
} from '@agents-ensemble/core';
import { fork, type ChildProcess } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, vi } from 'vitest';
import {
  createOperatorWatchPool as createWatchPool,
  operatorWatchStatePath
} from '../../src/operator-watch-pool.js';

export const DEFAULT_ISSUE_URL = 'https://github.com/example/repo/issues/1';

export function currentWatchStatePath(_repoRoot: string): string {
  return operatorWatchStatePath(
    join(process.env.ENSEMBLE_USER_ROOT ?? '', ''),
    'default',
    DEFAULT_ISSUE_URL,
  );
}

export function startWatchPollProcess(
  userEnsembleRoot: string,
  conductorAgentId: string,
  mode?: 'crash-after-persist',
): {
  child: ChildProcess;
  ready: Promise<void>;
  poll: () => void;
  result: Promise<number>;
  persistedBeforeEnqueue: Promise<void>;
  exit: Promise<void>;
} {
  const fixture = fileURLToPath(
    new URL('../fixtures/watch-state-poll-child.mjs', import.meta.url),
  );
  const child = fork(
    fixture,
    [userEnsembleRoot, conductorAgentId, ...(mode ? [mode] : [])],
    {
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (count: number) => void;
  let rejectResult!: (error: Error) => void;
  let resolvePersistedBeforeEnqueue!: () => void;
  let rejectPersistedBeforeEnqueue!: (error: Error) => void;
  let resultSettled = false;
  const persistedBeforeEnqueue = new Promise<void>((resolve, reject) => {
    resolvePersistedBeforeEnqueue = resolve;
    rejectPersistedBeforeEnqueue = reject;
  });
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<number>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let readySettled = false;
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const payload = message as {
      type?: string;
      count?: number;
      error?: string;
    };
    if (payload.type === 'ready') {
      readySettled = true;
      resolveReady();
    } else if (payload.type === 'persisted-before-enqueue') {
      resolvePersistedBeforeEnqueue();
    } else if (payload.type === 'done' && typeof payload.count === 'number') {
      resultSettled = true;
      resolveResult(payload.count);
    } else if (payload.type === 'error') {
      const error = new Error(payload.error ?? 'watch poll child failed');
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      if (mode) rejectPersistedBeforeEnqueue(error);
      if (!mode) rejectResult(error);
    }
  });
  child.once('error', (error) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    if (mode) rejectPersistedBeforeEnqueue(error);
    if (!mode) rejectResult(error);
  });
  child.once('exit', (code) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error(`watch poll child exited before ready (${code}): ${stderr}`));
    }
    if (!resultSettled && !mode) {
      rejectResult(
        new Error(`watch poll child exited before returning a result (${code}): ${stderr}`),
      );
    }
  });
  const exit = new Promise<void>((resolve, reject) => {
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`watch poll child exited with code ${code}: ${stderr}`));
    });
  });

  return {
    child,
    ready,
    poll: () => {
      child.send({ type: 'poll' });
    },
    result,
    persistedBeforeEnqueue,
    exit,
  };
}
export function setupWatchPoolSuite(register: (context: {
  repoRoot: string;
  homeRoot: string;
  closeServers: Array<() => Promise<void>>;
  createOperatorWatchPool: typeof createWatchPool;
  writeResumeStore: (
    agentId: string,
    updatedAt: number,
    harnessSocketPath?: string,
    issueUrl?: string,
    phase?: {
      harnessPhase: 'running' | 'idle' | 'close' | 'abort' | 'exit';
      modifiedAt: number;
      lifecycle?: 'unknown' | 'closed' | 'exited' | 'interrupted';
    },
  ) => Promise<void>;
  writeOfflineSnapshots: (
    agentId: string,
    input: {
      issueUrl?: string;
      sequence: number;
      questions: Array<Record<string, unknown>>;
      statusLine: string;
      reportedAt: number;
    },
  ) => Promise<void>;
}) => void) {
  describe('operator watch pool', () => {
    let repoRoot = '';
    let homeRoot = '';
    let closeServers: Array<() => Promise<void>> = [];
    let writerDrains: Promise<void>[] = [];

    const createOperatorWatchPool: typeof createWatchPool = async (...args) => {
      const pool = await createWatchPool(...args);
      const close = pool.close.bind(pool);
      pool.close = () => {
        // close() starts a bounded asynchronous drain. Wait for the preceding
        // barrier in teardown before removing the writer's temporary directory.
        const drain = pool.flushSchedulingEvents?.();
        if (drain) writerDrains.push(drain);
        close();
      };
      return pool;
    };

    beforeEach(async () => {
      homeRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-watch-home-'));
      vi.stubEnv('HOME', homeRoot);
      vi.stubEnv('ENSEMBLE_USER_ROOT', join(homeRoot, '.ensemble'));
    });

    afterEach(async () => {
      vi.useRealTimers();
      for (const close of closeServers) await close();
      closeServers = [];
      await Promise.all(writerDrains);
      writerDrains = [];
      if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
      repoRoot = '';
      if (homeRoot) await rm(homeRoot, { recursive: true, force: true });
      homeRoot = '';
      vi.unstubAllEnvs();
    });

    async function writeResumeStore(
      agentId: string,
      updatedAt: number,
      harnessSocketPath?: string,
      issueUrl = 'https://github.com/example/repo/issues/1',
      phase?: {
        harnessPhase: 'running' | 'idle' | 'close' | 'abort' | 'exit';
        modifiedAt: number;
        lifecycle?: 'unknown' | 'closed' | 'exited' | 'interrupted';
      },
    ) {
      const path = resolveEnsemblePaths({
        repoRoot,
      }).canonicalSessionResumeStorePath(issueUrl, agentId);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          conductorAgentId: agentId,
          issueUrl,
          repoRoot,
          ...(harnessSocketPath ? { harnessSocketPath } : {}),
          ...(phase ?? {}),
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
        issueUrl?: string;
        sequence: number;
        questions: Array<Record<string, unknown>>;
        statusLine: string;
        reportedAt: number;
      },
    ) {
      const paths = resolveEnsemblePaths({ repoRoot });
      const openQuestionsPath = paths.canonicalOpenQuestionsPath(
        input.issueUrl ?? DEFAULT_ISSUE_URL,
        agentId,
      );
      const sessionStatePath = paths.canonicalSessionStatePath(
        input.issueUrl ?? DEFAULT_ISSUE_URL,
        agentId,
      );
      await mkdir(dirname(openQuestionsPath), { recursive: true });
      await mkdir(dirname(sessionStatePath), { recursive: true });
      await writeFile(
        openQuestionsPath,
        [
          'version: 1',
          `sequence: ${input.sequence}`,
          ...(input.questions.length === 0
            ? ['openQuestions: []']
            : ['openQuestions:']),
          ...input.questions.flatMap((question) => [
            `  - id: ${question.id}`,
            `    question: ${JSON.stringify(question.question)}`,
            `    responseType: ${question.responseType}`,
            `    source: ${question.source}`,
            `    status: ${question.status}`,
            `    askedAt: ${question.askedAt}`,
            ...(typeof question.answer === 'string'
              ? [`    answer: ${JSON.stringify(question.answer)}`]
              : []),
            ...(typeof question.assent === 'string'
              ? [`    assent: ${question.assent}`]
              : []),
            ...(typeof question.selectedChoice === 'string'
              ? [`    selectedChoice: ${JSON.stringify(question.selectedChoice)}`]
              : []),
            ...(typeof question.answeredBy === 'string'
              ? [`    answeredBy: ${question.answeredBy}`]
              : []),
            ...(typeof question.answeredAt === 'number'
              ? [`    answeredAt: ${question.answeredAt}`]
              : []),
          ]),
          '',
        ].join('\n'),
      );
      await writeFile(
        sessionStatePath,
        `version: 1\nstatusLine: "${input.statusLine}"\nreportedAt: ${input.reportedAt}\n`,
      );
    }
    register({
      get repoRoot() { return repoRoot; }, set repoRoot(value) { repoRoot = value; },
      get homeRoot() { return homeRoot; }, set homeRoot(value) { homeRoot = value; },
      get closeServers() { return closeServers; }, set closeServers(value) { closeServers = value; },
      createOperatorWatchPool, writeResumeStore, writeOfflineSnapshots,
    });
  });
}
