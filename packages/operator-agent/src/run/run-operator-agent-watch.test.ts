import { setupRunnerSuite } from '../../test/support/runner-suite.js';
import { readSchedulingStats } from '../../../cli/src/session-scheduling-stats.js';
import { createFakeAgent, createOutput, writeOperatorSettings } from '../../test/support/operator-fixtures.js';
import { waitForNotification } from '../../test/support/wait.js';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { createInteractiveInput } from '../../test/support/interactive-input.js';
import xterm from '@xterm/headless';
import { PiConductorAgent } from '../../../core/src/conductor/pi-conductor-agent.js';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startOpenQuestionControlServer,
  resolveEnsemblePaths,
  type SessionObservationSnapshot,
} from '@agents-ensemble/core';
import {
  MCP_CONFIG_FILE,
  listUserLocatedSessionResumeStoresPage,
} from '@agents-ensemble/core/operator-runtime';
import type {
  ConductorAgent,
  ConductorAgentCreateOptions,
  ConductorAgentFactory,
} from '@agents-ensemble/core/operator-runtime';
import {
  runOperatorAgent,
  type OperatorAgentInput,
} from '../run-operator-agent.js';
import {
  OPERATOR_WATCH_ACK_MAX_RETRIES,
  OPERATOR_WATCH_ACK_RETRY_DELAY_MS,
  retryOperatorWatchAcknowledgement,
} from '../watch/operator-watch-ack.js';
import { createOperatorDispatchQueue } from '../dispatch/operator-dispatch.js';
import { withOperatorWorkspaceLock } from '../workspace/operator-workspace-lock.js';
import {
  createOperatorWatchPool,
  operatorWatchStatePath,
} from '../watch/operator-watch-pool.js';
import {
  loadOperatorAgentState,
  listOperatorAgentStates,
  operatorAgentStatePath,
  operatorPiSessionDirectory,
  saveOperatorAgentState,
  type OperatorAgentState,
} from './operator-agent-state.js';

const watchPollHarness = vi.hoisted(() => ({
  pending: new Set<Promise<unknown>>(),
  onCompleted: undefined as ((id: string, count: number) => void) | undefined,
  onAcknowledged: undefined as (() => void) | undefined,
}));

vi.mock('../watch/operator-watch-pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../watch/operator-watch-pool.js')>();
  return {
    ...actual,
    createOperatorWatchPool: async (...args: Parameters<typeof actual.createOperatorWatchPool>) => {
      const pool = await actual.createOperatorWatchPool(...args);
      const track = <T>(operation: Promise<T>): Promise<T> => {
        watchPollHarness.pending.add(operation);
        void operation.then(
          () => watchPollHarness.pending.delete(operation),
          () => watchPollHarness.pending.delete(operation),
        );
        return operation;
      };
      const pollOnce = pool.pollOnce.bind(pool);
      const polling = new Set<string>();
      pool.pollOnce = (id) => track((async () => {
        if (polling.has(id)) return pollOnce(id);
        polling.add(id);
        try {
          const count = await pollOnce(id);
          watchPollHarness.onCompleted?.(id, count);
          return count;
        } finally {
          polling.delete(id);
        }
      })());
      const acknowledge = pool.acknowledge.bind(pool);
      pool.acknowledge = async (...args) => {
        const result = await acknowledge(...args);
        if (args[0].some((event) => event.type === 'report' && event.reportId)) {
          watchPollHarness.onAcknowledged?.();
        }
        return result;
      };
      return pool;
    },
  };
});

function nextWatchPoll(minimumReports = 0): Promise<void> {
  return new Promise((resolve) => {
    watchPollHarness.onCompleted = (id, count) => {
      if (id !== 'conductor-one' || count < minimumReports) return;
      watchPollHarness.onCompleted = undefined;
      resolve();
    };
  });
}

describe('runOperatorAgent', () => {
  const fixture = setupRunnerSuite(watchPollHarness);


  it('keeps the conversation hold through consecutive user turns', async () => {
    const input = createInteractiveInput();
    input.isTTY = true;
    const output = createOutput();
    let agentOptions: ConductorAgentCreateOptions | undefined;
    let finishFirstTurn!: () => void;
    let firstTurnStarted!: () => void;
    let secondTurnStarted!: () => void;
    const firstTurnGate = new Promise<void>((resolve) => {
      finishFirstTurn = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      firstTurnStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      secondTurnStarted = resolve;
    });
    const sentPrompts: string[] = [];
    const fakeAgent = createFakeAgent({
      send: async (prompt) => {
        sentPrompts.push(prompt);
        if (sentPrompts.length === 1) {
          await agentOptions!.customTools!.set_report_hold!.execute({
            hold: true,
          });
          firstTurnStarted();
          await firstTurnGate;
        } else {
          const result =
            await agentOptions!.customTools!.set_report_hold!.execute({
              hold: true,
            });
          expect(result.structuredContent).toMatchObject({
            conversationHold: true,
            reportHold: true,
            effectiveHold: true,
          });
          secondTurnStarted();
        }
        return {
          runId: `run-${sentPrompts.length}`,
          status: 'completed',
          result: 'done',
        };
      },
    });
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async (options) => {
            agentOptions = options;
            return fakeAgent;
          },
          resume: async () => fakeAgent,
        },
      },
    );

    await vi.waitFor(() =>
      expect(output.capturedText()).toContain('user>'),
    );
    input.write('first turn\n');
    await firstStarted;
    input.write('second turn\n');
    finishFirstTurn();
    await secondStarted;
    input.write('/exit\n');
    await run;

    expect(sentPrompts).toHaveLength(2);
    expect(sentPrompts[0]).toBe('first turn');
    expect(sentPrompts[1]).toBe('second turn');
    expect(sentPrompts.join('\n')).not.toContain('/resume-watch');
    expect(output.capturedText()).toContain(
      '監視報告: 保留（理由: 会話・手動、保留件数: 0 件）',
    );
  });

  it('buffers a live UDS report on conversation hold and dispatches it after the user turn', async () => {
    let liveSnapshot: SessionObservationSnapshot = {
      sequence: 0,
      openQuestions: [],
    };
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => liveSnapshot,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    fixture.closeServers.push(() => liveServer.close());

    const resumeStorePath = canonicalBaseResumeStorePath(fixture.repoRoot);
    const resumeStore = JSON.parse(await readFile(resumeStorePath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      resumeStorePath,
      JSON.stringify({ ...resumeStore, harnessSocketPath: liveServer.socketPath }),
    );

    const input = createInteractiveInput();
    input.isTTY = true;
    const output = createOutput();
    let agentOptions: ConductorAgentCreateOptions | undefined;
    let finishUserTurn!: () => void;
    let userTurnStarted!: () => void;
    let reportTurnStarted!: () => void;
    const userTurnGate = new Promise<void>((resolve) => {
      finishUserTurn = resolve;
    });
    const userStarted = new Promise<void>((resolve) => {
      userTurnStarted = resolve;
    });
    const reportStarted = new Promise<void>((resolve) => {
      reportTurnStarted = resolve;
    });
    const sentPrompts: string[] = [];
    let pi: ReturnType<typeof createScriptedPiAgent>;
    const runPrompt = async (emit: (event: any) => void, prompt: string) => {
      sentPrompts.push(prompt);
      if (sentPrompts.length === 1) {
        await agentOptions!.customTools!.register_session_watch!.execute({
          conductorAgentId: 'conductor-one', pollIntervalMs: 250, debounceMs: 0,
        });
        userTurnStarted();
        await userTurnGate;
        emit({ type: 'auto_retry_end', success: true, attempt: 1 });
      } else {
        reportTurnStarted();
      }
      return { text: 'done' };
    };
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async (options) => {
            agentOptions = options;
            pi = createScriptedPiAgent(options, runPrompt);
            return pi.agent;
          },
          resume: async (_id, options) => createScriptedPiAgent(options, runPrompt).agent,
        },
      },
    );

    let runFinished = false;
    try {
      await vi.waitFor(() =>
        expect(output.capturedText()).toContain('user>'),
      );
      const baselinePoll = nextWatchPoll();
      input.write('summarize the live update\n');
      await userStarted;
      await baselinePoll;
      const baselineState = JSON.parse(await readFile(baseWatchStatePath(fixture.repoRoot), 'utf8')) as {
        cursors: Record<string, { sequence: number }>;
      };
      expect(baselineState.cursors['conductor-one']?.sequence).toBe(0);
      const reportPoll = nextWatchPoll(1);

      liveSnapshot = {
        sequence: 1,
        openQuestions: [
          {
            id: 'inq-live-report',
            question: 'Should the operator review this live report?',
            responseType: 'text',
            source: 'conductor',
            status: 'open',
            askedAt: 2,
          },
        ],
      };
      await reportPoll;
      const state = JSON.parse(
        await readFile(baseWatchStatePath(fixture.repoRoot), 'utf8'),
      ) as {
        cursors: Record<string, { sequence: number }>;
      };
      expect(state.cursors['conductor-one']?.sequence).toBe(1);
      const holdState =
        await agentOptions!.customTools!.set_report_hold!.execute({
          hold: false,
        });
      expect(holdState.structuredContent).toMatchObject({
        conversationHold: true,
        reportHold: false,
        effectiveHold: true,
        heldEventCount: 1,
      });

      // The event enters through Pi's session listener while the report is held.
      // This is the same session that will finish the user send and receive the report.
      pi.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 10, errorMessage: 'timeout' });
      await vi.waitFor(() => expect(output.capturedText()).toContain('[pi retry] attempt 1/2'));
      pi.emit({ type: 'compaction_start', reason: 'threshold' });
      pi.emit({ type: 'compaction_end', reason: 'threshold', result: { tokensBefore: 100 }, aborted: false, willRetry: false });
      expect(sentPrompts).toHaveLength(1);
      expect(sentPrompts[0]).toBe('summarize the live update');

      finishUserTurn();
      await reportStarted;
      await vi.waitFor(() => expect(pi.results[0]).toMatchObject({ status: 'finished', result: 'done' }));
      expect(sentPrompts).toHaveLength(2);
      expect(sentPrompts[1]).toContain(
        'Should the operator review this live report?',
      );
      expect(output.capturedText()).toContain(
        '監視報告: 解除（理由: なし、保留件数: 0 件）',
      );
      input.write('/exit\n');
      await run;
      runFinished = true;
    } finally {
      if (!runFinished) {
        finishUserTurn();
        input.end();
        await run.catch(() => {});
      }
    }
  });

  it('lets /resume-watch clear only conversation hold while manual hold stays active', async () => {
    let liveSnapshot: SessionObservationSnapshot = {
      sequence: 0,
      openQuestions: [],
    };
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => liveSnapshot,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    fixture.closeServers.push(() => liveServer.close());

    const resumeStorePath = canonicalBaseResumeStorePath(fixture.repoRoot);
    const resumeStore = JSON.parse(await readFile(resumeStorePath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      resumeStorePath,
      JSON.stringify({ ...resumeStore, harnessSocketPath: liveServer.socketPath }),
    );

    const input = createInteractiveInput();
    input.isTTY = true;
    const output = createOutput();
    let agentOptions: ConductorAgentCreateOptions | undefined;
    let finishFirstTurn!: () => void;
    let firstTurnStarted!: () => void;
    let reportTurnStarted!: () => void;
    const firstTurnGate = new Promise<void>((resolve) => {
      finishFirstTurn = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      firstTurnStarted = resolve;
    });
    const reportStarted = new Promise<void>((resolve) => {
      reportTurnStarted = resolve;
    });
    const sentPrompts: string[] = [];
    const fakeAgent = createFakeAgent({
      send: async (prompt) => {
        sentPrompts.push(prompt);
        if (sentPrompts.length === 1) {
          await agentOptions!.customTools!.register_session_watch!.execute({
            conductorAgentId: 'conductor-one',
            pollIntervalMs: 250,
            debounceMs: 0,
          });
          await agentOptions!.customTools!.set_report_hold!.execute({
            hold: true,
          });
          firstTurnStarted();
          await firstTurnGate;
        } else {
          expect(prompt).toContain('conversation hold escape test?');
          reportTurnStarted();
        }
        return {
          runId: `run-${sentPrompts.length}`,
          status: 'completed',
          result: 'done',
        };
      },
    });
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async (options) => {
            agentOptions = options;
            return fakeAgent;
          },
          resume: async () => fakeAgent,
        },
      },
    );

    let runFinished = false;
    try {
      await vi.waitFor(() =>
        expect(output.capturedText()).toContain('user>'),
      );
      const baselinePoll = nextWatchPoll();
      input.write('start the discussion\n');
      await firstStarted;
      await baselinePoll;
      const baselineState = JSON.parse(await readFile(baseWatchStatePath(fixture.repoRoot), 'utf8')) as {
        cursors: Record<string, { sequence: number }>;
      };
      expect(baselineState.cursors['conductor-one']?.sequence).toBe(0);
      const reportPoll = nextWatchPoll(1);
      liveSnapshot = {
        sequence: 1,
        openQuestions: [
          {
            id: 'inq-2',
            question: 'conversation hold escape test?',
            responseType: 'text',
            source: 'conductor',
            status: 'open',
            askedAt: 2,
          },
        ],
      };
      await reportPoll;
      const result =
        await agentOptions!.customTools!.set_report_hold!.execute({
          hold: true,
        });
      expect(result.structuredContent).toMatchObject({
        conversationHold: true,
        reportHold: true,
        effectiveHold: true,
        heldEventCount: 1,
      });

      input.write('/resume-watch\n');
      await vi.waitFor(() =>
        expect(output.capturedText()).toContain(
          '監視報告: 保留（理由: 手動、保留件数: 1 件）',
        ),
      );
      expect(sentPrompts).toHaveLength(1);
      finishFirstTurn();
      await vi.waitFor(() =>
        expect(output.capturedText()).toContain(
          '監視報告: 保留（理由: 手動、保留件数: 1 件）',
        ),
      );
      const releaseResult =
        await agentOptions!.customTools!.release_reports!.execute({});
      expect(releaseResult.structuredContent).toMatchObject({
        conversationHold: false,
        reportHold: false,
        effectiveHold: false,
        releasedEventCount: 1,
      });
      await reportStarted;
      input.write('/exit\n');
      await run;
      runFinished = true;
    } finally {
      if (!runFinished) {
        finishFirstTurn();
        input.end();
        await run.catch(() => {});
      }
    }

    expect(sentPrompts).toHaveLength(2);
    expect(sentPrompts.join('\n')).not.toContain('/resume-watch');
    expect(output.capturedText()).toContain(
      '監視報告: 保留（理由: 手動、保留件数: 1 件）',
    );
  });

  it('polls an offline watched session and refreshes the held-report count in the TTY', async () => {
    const input = createInteractiveInput();
    input.isTTY = true;
    const output = createOutput();
    let agentOptions: ConductorAgentCreateOptions | undefined;
    const fakeAgent = createFakeAgent({
      send: async () => {
        const baselinePoll = nextWatchPoll();
        await agentOptions!.customTools!.set_report_hold!.execute({ hold: true });
        await agentOptions!.customTools!.register_session_watch!.execute({
          conductorAgentId: 'conductor-one',
          pollIntervalMs: 250,
          debounceMs: 0,
        });
        await baselinePoll;
        const questionPath = resolveEnsemblePaths({ repoRoot: fixture.repoRoot })
          .canonicalOpenQuestionsPath(
            'https://github.com/example/project/issues/12',
            'conductor-one',
          );
        await mkdir(dirname(questionPath), { recursive: true });
        await writeFile(
          questionPath,
          [
            'version: 1',
            'sequence: 2',
            'openQuestions:',
            '  - id: inq-1',
            '    question: "Approve this operation?"',
            '    responseType: yes_no',
            '    source: conductor',
            '    status: open',
            '    askedAt: 1',
            '  - id: inq-2',
            '    question: "New question while offline?"',
            '    responseType: text',
            '    source: conductor',
            '    status: open',
            '    askedAt: 2',
            '',
          ].join('\n'),
        );
        return { runId: 'run-1', status: 'completed', result: 'watch started' };
      },
    });
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async (options) => {
            agentOptions = options;
            return fakeAgent;
          },
          resume: async () => fakeAgent,
        },
      },
    );

    await vi.waitFor(() =>
      expect(output.capturedText()).toContain('user>'),
    );
    input.write('監視を開始\n');
    await waitForOutput(output, '監視報告: 保留（理由: 手動、保留件数: 1 件）');
    input.write('/exit\n');
    await run;

    expect(output.capturedText()).toContain(
      '監視報告: 保留（理由: 手動、保留件数: 1 件）',
    );
  });

  it('sends Open Question, status, and conductor-message reports for one session in one dispatch', async () => {
    let messages: Array<{
      text: string;
      inbound: string;
      at: number;
      sendCount: number;
      dispatchSource: string;
    }> = [];
    const initialPollCompleted = new Promise<void>((resolve) => {
      watchPollHarness.onCompleted = (id) => {
        if (id === 'conductor-one') resolve();
      };
    });
    let liveSnapshot: SessionObservationSnapshot = {
      sequence: 0,
      openQuestions: [],
    };
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => liveSnapshot,
      listConductorMessages: () => messages,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    fixture.closeServers.push(() => liveServer.close());

    const resumeStorePath = canonicalBaseResumeStorePath(fixture.repoRoot);
    const resumeStore = JSON.parse(await readFile(resumeStorePath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      resumeStorePath,
      JSON.stringify({ ...resumeStore, harnessSocketPath: liveServer.socketPath }),
    );

    const input = createInteractiveInput();
    input.isTTY = true;
    const output = createOutput();
    let agentOptions: ConductorAgentCreateOptions | undefined;
    const sentPrompts: string[] = [];
    let signalReportSent!: () => void;
    const reportSent = new Promise<void>((resolve) => { signalReportSent = resolve; });
    const fakeAgent = createFakeAgent({
      send: async (prompt) => {
        sentPrompts.push(prompt);
        if (sentPrompts.length === 2) signalReportSent();
        if (sentPrompts.length === 1) {
          await agentOptions!.customTools!.register_session_watch!.execute({
            conductorAgentId: 'conductor-one',
            pollIntervalMs: 250,
            debounceMs: 0,
          });
          await agentOptions!.customTools!.register_conductor_message_listen!.execute({
            conductorAgentId: 'conductor-one',
            messageDebounceMs: 5_000,
          });
          await initialPollCompleted;
          liveSnapshot = {
            sequence: 2,
            openQuestions: [
              {
                id: 'inq-2',
                question: 'Review the implementation?',
                responseType: 'text',
                source: 'conductor',
                status: 'open',
                askedAt: 2,
              },
              {
                id: 'inq-3',
                question: 'Confirm the test result?',
                responseType: 'yes_no',
                source: 'conductor',
                status: 'open',
                askedAt: 3,
              },
            ],
            sessionState: {
              current: { statusLine: 'レビュー確認済み', reportedAt: 4 },
              history: [],
            },
          };
          messages = [1, 2].map((sendCount) => ({
            text: `conductor reply ${sendCount}`,
            inbound: `operator message ${sendCount}`,
            at: 1_700_000_000_000 + sendCount,
            sendCount,
            dispatchSource: 'operator',
          }));
        }
        return {
          runId: `run-${sentPrompts.length}`,
          status: 'completed',
          result: 'received',
        };
      },
    });
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async (options) => {
            agentOptions = options;
            return fakeAgent;
          },
          resume: async () => fakeAgent,
        },
      },
    );

    try {
      await vi.waitFor(() =>
        expect(output.capturedText()).toContain('user>'),
      );
      input.write('start watching\n');
      await reportSent;
      input.write('/exit\n');
      await run;
    } finally {
      input.end();
    }

    expect(sentPrompts).toHaveLength(2);
    expect(sentPrompts[1]).toContain('## セッション報告（5 件）');
    expect(sentPrompts[1]).toContain('— Open Question');
    expect(sentPrompts[1]).toContain('— セッション状態');
    expect(sentPrompts[1]).toContain('— Conductor の発言');
    expect(sentPrompts[1]).toContain('Review the implementation?');
    expect(sentPrompts[1]).toContain('Confirm the test result?');
    expect(sentPrompts[1]).toContain('レビュー確認済み');
    expect(sentPrompts[1]).toContain('conductor reply 1');
    expect(sentPrompts[1]).toContain('conductor reply 2');
  }, 25_000);

  it('delivers and acknowledges a below-threshold report after an explicit request', async () => {
    const setupPool = await createOperatorWatchPool({
      repoRoot: fixture.repoRoot,
      userEnsembleRoot: join(fixture.repoRoot, '.ensemble'),
      profile: 'smoke',
      dispatchQueue: createOperatorDispatchQueue(),
    });
    try {
      await setupPool.enqueueIdleCandidate!({
        conductorAgentId: 'conductor-one',
        text: 'requested candidate',
        kind: 'idle_phase',
        fingerprint: 'explicit-request-fixture',
        eligibleAt: Date.now(),
      });
    } finally {
      setupPool.close();
    }
    const input = createInteractiveInput();
    const output = createOutput();
    let agentOptions: ConductorAgentCreateOptions | undefined;
    const prompts: string[] = [];
    const agent = createFakeAgent({
      send: async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          const result = await agentOptions!.customTools!.request_session_reports!.execute({
            conductorAgentId: 'conductor-one',
          });
          expect(result.structuredContent).toMatchObject({ accepted: true });
        }
        return { runId: 'request-test', status: 'finished', result: 'done' };
      },
    });
    const reportAcknowledged = new Promise<void>((resolve) => {
      watchPollHarness.onAcknowledged = resolve;
    });
    const run = runOperatorAgent({ repoRoot: fixture.repoRoot, newSession: true }, {
      stdin: input,
      stdout: output,
      agentFactory: {
        create: async (options) => { agentOptions = options; return agent; },
        resume: async () => agent,
      },
    });
    try {
      await vi.waitFor(() => expect(output.capturedText()).toContain('user>'));
      input.write('request the pending report\n');
      await reportAcknowledged;
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('requested candidate');
      const saved = JSON.parse(await readFile(baseWatchStatePath(fixture.repoRoot), 'utf8')) as { pendingReports: unknown[] };
      expect(saved.pendingReports).toHaveLength(0);
    } finally {
      input.end();
      await run;
    }
  });

  it('delivers a report while another process holds the scheduling event lock', async () => {
    const root = join(fixture.repoRoot, '.ensemble');
    const setupPool = await createOperatorWatchPool({
      repoRoot: fixture.repoRoot, userEnsembleRoot: root, profile: 'smoke', dispatchQueue: createOperatorDispatchQueue(),
    });
    await setupPool.enqueueIdleCandidate!({
      conductorAgentId: 'conductor-one', text: 'blocked writer candidate',
      kind: 'idle_phase', fingerprint: 'blocked-writer', eligibleAt: Date.now(),
    });
    await setupPool.flushSchedulingEvents?.();
    setupPool.close();
    await setupPool.flushSchedulingEvents?.();
    const lock = new DatabaseSync(join(root, 'operator-agents', 'smoke', 'scheduling-events-lock.sqlite'));
    lock.exec('BEGIN IMMEDIATE');
    const input = createInteractiveInput();
    const output = createOutput();
    let options: ConductorAgentCreateOptions | undefined;
    let sends = 0;
    const agent = createFakeAgent({ send: async () => {
      sends++;
      if (sends === 1) {
        await options!.customTools!.request_session_reports!.execute({ conductorAgentId: 'conductor-one' });
        return { runId: 'request', status: 'finished', result: 'requested' };
      }
      return { runId: 'report', status: 'cancelled', result: 'cancelled' };
    } });
    const run = runOperatorAgent({ repoRoot: fixture.repoRoot, newSession: true }, {
      stdin: input, stdout: output,
      agentFactory: { create: async (value) => { options = value; return agent; }, resume: async () => agent },
    });
    try {
      await vi.waitFor(() => expect(output.capturedText()).toContain('user>'));
      input.write('request report\n');
      await vi.waitFor(() => expect(output.capturedText()).toContain('send not completed (status=cancelled)'), { timeout: 8_000 });
      expect(sends).toBe(2);
    } finally {
      input.end();
      try { await run; } finally { lock.exec('ROLLBACK'); lock.close(); }
    }
  }, 20_000);

  it.each([
    ['off', undefined], ['focused_session', 'conductor-one'], ['other_session', 'conductor-other'],
  ] as const)('records send-time focus %s through runner and statistics', async (expected, focused) => {
    const root = join(fixture.repoRoot, '.ensemble');
    const setupPool = await createOperatorWatchPool({ repoRoot: fixture.repoRoot, userEnsembleRoot: root, profile: 'smoke', dispatchQueue: createOperatorDispatchQueue() });
    await setupPool.enqueueIdleCandidate!({ conductorAgentId: 'conductor-one', text: 'focus example', kind: 'idle_phase', fingerprint: `focus-${expected}`, eligibleAt: Date.now() });
    await setupPool.flushSchedulingEvents?.();
    setupPool.close();
    await setupPool.flushSchedulingEvents?.();
    const input = createInteractiveInput();
    const output = createOutput();
    let options: ConductorAgentCreateOptions | undefined;
    let sends = 0;
    const acknowledged = new Promise<void>((resolve) => { watchPollHarness.onAcknowledged = resolve; });
    const agent = createFakeAgent({ send: async () => {
      sends++;
      if (sends === 1) {
        if (focused) await options!.customTools!.set_session_focus!.execute({ conductorAgentId: focused });
        await options!.customTools!.request_session_reports!.execute({ conductorAgentId: 'conductor-one' });
      } else {
        // A focus change during send must not change its start-time snapshot.
        await options!.customTools!.set_session_focus!.execute(focused ? {} : { conductorAgentId: 'conductor-other' });
      }
      return { runId: 'focus-send', status: 'finished', result: 'done' };
    } });
    const run = runOperatorAgent({ repoRoot: fixture.repoRoot, newSession: true }, {
      stdin: input, stdout: output,
      agentFactory: { create: async (value) => { options = value; return agent; }, resume: async () => agent },
    });
    try {
      await vi.waitFor(() => expect(output.capturedText()).toContain('user>'));
      input.write('request report\n');
      await waitForNotification(acknowledged, 'focus report acknowledgement', 10_000);
    } finally {
      watchPollHarness.onAcknowledged = undefined;
      input.end();
      await run;
    }
    const events = (await readFile(join(root, 'operator-agents', 'smoke', 'scheduling-events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const sent = events.find((event) => event.type === 'batch.sent');
    expect(sent).toMatchObject({ focusState: expected, schedulingInstanceId: expect.any(String) });
    const stats = await readSchedulingStats({ root, profile: 'smoke' });
    expect(stats.latencyByFocus[`idle_candidate/${expected}`]).toMatchObject({ count: 1 });
    expect(stats.latencyByFocusPresence[`idle_candidate/${expected === 'off' ? 'off' : 'on'}`]).toMatchObject({ count: 1 });
    expect(stats.latency['idle_candidate/unknown_deferred']).toMatchObject({ count: 1 });
  }, 20_000);

  it('records an initial report attempt and its frozen replay after runner restart', async () => {
    const setupPool = await createOperatorWatchPool({
      repoRoot: fixture.repoRoot,
      userEnsembleRoot: join(fixture.repoRoot, '.ensemble'),
      profile: 'smoke',
      dispatchQueue: createOperatorDispatchQueue(),
    });
    await setupPool.enqueueIdleCandidate!({
      conductorAgentId: 'conductor-one', text: 'replay candidate',
      kind: 'idle_phase', fingerprint: 'replay-fixture', eligibleAt: Date.now(),
    });
    setupPool.close();
    const firstInput = createInteractiveInput();
    const firstOutput = createOutput();
    let agentOptions: ConductorAgentCreateOptions | undefined;
    let sends = 0;
    const firstAgent = createFakeAgent({
      send: async () => {
        sends++;
        if (sends === 1) {
          await agentOptions!.customTools!.request_session_reports!.execute({ conductorAgentId: 'conductor-one' });
          return { runId: 'request', status: 'finished', result: 'requested' };
        }
        return { runId: 'cancelled', status: 'cancelled', result: 'cancelled' };
      },
    });
    const firstRun = runOperatorAgent({ repoRoot: fixture.repoRoot, newSession: true }, {
      stdin: firstInput, stdout: firstOutput,
      agentFactory: { create: async (options) => { agentOptions = options; return firstAgent; }, resume: async () => firstAgent },
    });
    try {
      await vi.waitFor(() => expect(firstOutput.capturedText()).toContain('user>'));
      firstInput.write('request report\n');
      await vi.waitFor(() => expect(firstOutput.capturedText()).toContain('send not completed (status=cancelled)'), { timeout: 8_000 });
    } finally {
      firstInput.end();
      await firstRun;
    }
    const retryInput = createInteractiveInput();
    const retryOutput = createOutput();
    const acknowledged = new Promise<void>((resolve) => { watchPollHarness.onAcknowledged = resolve; });
    const retryAgent = createFakeAgent({ send: async () => ({ runId: 'replay', status: 'finished', result: 'done' }) });
    const retryRun = runOperatorAgent({ repoRoot: fixture.repoRoot }, {
      stdin: retryInput, stdout: retryOutput,
      agentFactory: { create: async () => { throw new Error('expected resume'); }, resume: async () => retryAgent },
    });
    try {
      await waitForNotification(acknowledged, 'replay acknowledgement', 10_000);
    } finally {
      watchPollHarness.onAcknowledged = undefined;
      retryInput.end();
      await retryRun;
    }
    const path = join(fixture.repoRoot, '.ensemble', 'operator-agents', 'smoke', 'scheduling-events.jsonl');
    const events = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string; batchId?: string; deliveryKind?: string; status?: string; schedulingInstanceId?: string; focusState?: string });
    const sent = events.filter((event) => event.type === 'batch.sent');
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ deliveryKind: 'initial', status: 'cancelled' });
    expect(sent[1]).toMatchObject({ deliveryKind: 'frozen_replay', status: 'finished', batchId: sent[0]!.batchId });
    expect(sent[0]!.schedulingInstanceId).toEqual(expect.any(String));
    expect(sent[1]!.schedulingInstanceId).toEqual(expect.any(String));
    expect(sent[1]!.schedulingInstanceId).not.toBe(sent[0]!.schedulingInstanceId);
    expect(sent.map((event) => event.focusState)).toEqual(['off', 'off']);
    const stats = await readSchedulingStats({ root: join(fixture.repoRoot, '.ensemble'), profile: 'smoke' });
    expect(stats.latencyByFocus['idle_candidate/off']).toMatchObject({ count: 2 });
  }, 20_000);

  it.each([
    ['send', false], ['send', true], ['ack retry', false], ['ack retry', true],
  ])('retains a later request during %s (focus: %s)', async (phase, focus) => {
    const peer = await createOperatorWatchPool({
      repoRoot: fixture.repoRoot, userEnsembleRoot: join(fixture.repoRoot, '.ensemble'), profile: 'smoke',
      dispatchQueue: createOperatorDispatchQueue(),
    });
    const addReport = async (text: string) => peer.enqueueIdleCandidate!({
      conductorAgentId: 'conductor-one', text, kind: 'idle_phase',
      fingerprint: text, eligibleAt: Date.now(),
    });
    await addReport('first requested report');
    const input = createInteractiveInput();
    const output = createOutput();
    const prompts: string[] = [];
    let options: ConductorAgentCreateOptions | undefined;
    let lock: DatabaseSync | undefined;
    const request = async () => {
      const result = await options!.customTools!.request_session_reports!.execute({ conductorAgentId: 'conductor-one' });
      expect(result.structuredContent).toMatchObject({ accepted: true });
    };
    const agent = createFakeAgent({
      send: async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          if (focus) await options!.customTools!.set_session_focus!.execute({ conductorAgentId: 'conductor-one' });
          await request();
        } else if (prompts.length === 2) {
          await addReport('later requested report');
          await vi.waitFor(async () => {
            const result = await options!.customTools!.list_pending_reports!.execute({});
            expect(result.structuredContent).toMatchObject({ sessions: [{ conductorAgentId: 'conductor-one', count: 1 }] });
          }, { timeout: 6_000 });
          if (phase === 'send') await request();
          else {
            lock = new DatabaseSync(join(fixture.repoRoot, '.ensemble', 'operator-agents', 'smoke', 'watch', 'watch-state-lock.sqlite'));
            lock.exec('BEGIN IMMEDIATE');
          }
        }
        return { runId: 'overlapping-request', status: 'finished', result: 'done' };
      },
    });
    let acknowledgements = 0;
    const reportsAcknowledged = new Promise<void>((resolve) => {
      watchPollHarness.onAcknowledged = () => { if (++acknowledgements === 2) resolve(); };
    });
    const run = runOperatorAgent({ repoRoot: fixture.repoRoot, newSession: true }, {
      stdin: input, stdout: output,
      agentFactory: { create: async (value) => { options = value; return agent; }, resume: async () => agent },
    });
    try {
      await vi.waitFor(() => expect(output.capturedText()).toContain('user>'));
      input.write('request first report\n');
      if (phase === 'ack retry') {
        await vi.waitFor(() => expect(output.capturedText()).toContain('ack だけを再試行'), { timeout: 10_000 });
        await request();
        lock!.exec('ROLLBACK');
        lock!.close();
        lock = undefined;
      }
      await vi.waitFor(() => expect(prompts).toHaveLength(3), { timeout: 10_000 });
      expect(prompts[1]).toContain('first requested report');
      expect(prompts[1]).not.toContain('later requested report');
      expect(prompts[2]).toContain('later requested report');
      await reportsAcknowledged;
      const state = JSON.parse(await readFile(baseWatchStatePath(fixture.repoRoot), 'utf8')) as { pendingReports: unknown[] };
      expect(state.pendingReports).toHaveLength(0);
    } finally {
      if (lock) { lock.exec('ROLLBACK'); lock.close(); }
      peer.close();
      input.end();
      await run;
    }
  }, 20_000);

  it('replays a cancelled explicitly requested batch after restart with the same payload', async () => {
    const setupPool = await createOperatorWatchPool({
      repoRoot: fixture.repoRoot,
      userEnsembleRoot: join(fixture.repoRoot, '.ensemble'),
      profile: 'smoke',
      dispatchQueue: createOperatorDispatchQueue(),
    });
    try {
      await setupPool.enqueueIdleCandidate!({
        conductorAgentId: 'conductor-one', text: 'retry requested candidate',
        kind: 'idle_phase', fingerprint: 'request-retry-fixture', eligibleAt: Date.now(),
      });
    } finally {
      setupPool.close();
    }
    const input = createInteractiveInput();
    const output = createOutput();
    let options: ConductorAgentCreateOptions | undefined;
    const prompts: string[] = [];
    const agent = createFakeAgent({
      send: async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          await options!.customTools!.request_session_reports!.execute({ conductorAgentId: 'conductor-one' });
          return { runId: 'request', status: 'finished', result: 'requested' };
        }
        return { runId: 'cancelled', status: 'cancelled', result: 'cancelled' };
      },
    });
    const firstRun = runOperatorAgent({ repoRoot: fixture.repoRoot, newSession: true }, {
      stdin: input, stdout: output,
      agentFactory: { create: async (value) => { options = value; return agent; }, resume: async () => agent },
    });
    await vi.waitFor(() => expect(output.capturedText()).toContain('user>'));
    input.write('request report\n');
    await vi.waitFor(() => expect(output.capturedText()).toContain('send not completed'));
    input.end();
    await firstRun;
    const stored = JSON.parse(await readFile(baseWatchStatePath(fixture.repoRoot), 'utf8')) as {
      pendingReports: Array<{ reportId: string; frozenBatchId: string; frozenPayload: string }>;
    };
    expect(stored.pendingReports).toHaveLength(1);
    const frozen = stored.pendingReports[0]!;
    expect(frozen.frozenPayload).toContain('retry requested candidate');

    const resumedInput = createInteractiveInput();
    const resumedOutput = createOutput();
    const resumedPrompts: string[] = [];
    const resumedAgent = createFakeAgent({
      send: async (prompt) => {
        resumedPrompts.push(prompt);
        return { runId: 'retry', status: 'finished', result: 'done' };
      },
    });
    const retryAcknowledged = new Promise<void>((resolve) => {
      watchPollHarness.onAcknowledged = resolve;
    });
    const resumed = runOperatorAgent({ repoRoot: fixture.repoRoot }, {
      stdin: resumedInput, stdout: resumedOutput,
      agentFactory: { create: async () => resumedAgent, resume: async () => resumedAgent },
    });
    try {
      await retryAcknowledged;
      expect(resumedPrompts).toHaveLength(1);
      expect(resumedPrompts[0]).toBe(frozen.frozenPayload);
      const state = JSON.parse(await readFile(baseWatchStatePath(fixture.repoRoot), 'utf8')) as { pendingReports: unknown[] };
      expect(state.pendingReports).toHaveLength(0);
    } finally {
      resumedInput.end();
      await resumed;
    }
  }, 15_000);

  it('retries only ack after a requested report send completes', async () => {
    const setupPool = await createOperatorWatchPool({
      repoRoot: fixture.repoRoot, userEnsembleRoot: join(fixture.repoRoot, '.ensemble'), profile: 'smoke',
      dispatchQueue: createOperatorDispatchQueue(),
    });
    try {
      await setupPool.enqueueIdleCandidate!({
        conductorAgentId: 'conductor-one', text: 'requested ack retry',
        kind: 'idle_phase', fingerprint: 'requested-ack-fixture', eligibleAt: Date.now(),
      });
    } finally {
      setupPool.close();
    }
    const lockPath = join(fixture.repoRoot, '.ensemble', 'operator-agents', 'smoke', 'watch', 'watch-state-lock.sqlite');
    const input = createInteractiveInput();
    const output = createOutput();
    let options: ConductorAgentCreateOptions | undefined;
    let lock: DatabaseSync | undefined;
    const prompts: string[] = [];
    const agent = createFakeAgent({
      send: async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          await options!.customTools!.request_session_reports!.execute({ conductorAgentId: 'conductor-one' });
        } else {
          lock = new DatabaseSync(lockPath);
          lock.exec('BEGIN IMMEDIATE');
        }
        return { runId: 'ack-test', status: 'finished', result: 'done' };
      },
    });
    const run = runOperatorAgent({ repoRoot: fixture.repoRoot, newSession: true }, {
      stdin: input, stdout: output,
      agentFactory: { create: async (value) => { options = value; return agent; }, resume: async () => agent },
    });
    try {
      await vi.waitFor(() => expect(output.capturedText()).toContain('user>'));
      input.write('request the report\n');
      await vi.waitFor(() => expect(output.capturedText()).toContain('ack だけを再試行'), { timeout: 6_000 });
      expect(prompts).toHaveLength(2);
      lock!.exec('ROLLBACK');
      lock!.close();
      lock = undefined;
      await vi.waitFor(async () => {
        const state = JSON.parse(await readFile(baseWatchStatePath(fixture.repoRoot), 'utf8')) as { pendingReports: unknown[] };
        expect(state.pendingReports).toHaveLength(0);
      }, { timeout: 8_000 });
      expect(prompts).toHaveLength(2);
    } finally {
      if (lock) { lock.exec('ROLLBACK'); lock.close(); }
      input.end();
      await run;
    }
  }, 15_000);

  it('does not start a send when the durable batch freeze cannot be committed', async () => {
    const configPath = join(fixture.repoRoot, '.ensemble', 'operator-agents.config.yaml');
    const config = await readFile(configPath, 'utf8');
    await writeFile(configPath, config.replace('common:\n', 'common:\n  scheduling:\n    pushThreshold: 1\n'));
    const setupPool = await createOperatorWatchPool({
      repoRoot: fixture.repoRoot,
      userEnsembleRoot: join(fixture.repoRoot, '.ensemble'),
      profile: 'smoke',
      dispatchQueue: createOperatorDispatchQueue(),
    });
    try {
      await setupPool.enqueueIdleCandidate!({
        conductorAgentId: 'conductor-one',
        text: 'candidate waits for a durable batch commit',
        kind: 'idle_phase',
        fingerprint: 'durable-commit-fixture',
        eligibleAt: Date.now(),
      });
    } finally {
      setupPool.close();
    }

    const lockPath = join(
      fixture.repoRoot,
      '.ensemble',
      'operator-agents',
      'smoke',
      'watch',
      'watch-state-lock.sqlite',
    );
    const send = vi.fn(async () => ({
      runId: 'must-not-send',
      status: 'finished' as const,
      result: 'unexpected send',
    }));
    const input = createInteractiveInput();
    const output = createOutput();
    let stateLock: DatabaseSync | undefined;
    const fakeAgent = createFakeAgent({ send });
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot, newSession: true },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async () => {
            stateLock = new DatabaseSync(lockPath);
            stateLock.exec('BEGIN IMMEDIATE');
            return fakeAgent;
          },
          resume: async () => fakeAgent,
        },
      },
    );

    try {
      await vi.waitFor(() => expect(normalizeTtyText(output.capturedText()))
        .toContain('監視報告の送信準備は lock の競合で待機中'), { timeout: 6_000 });
      expect(send).not.toHaveBeenCalled();
      input.write('/exit\n');
      await run;
    } finally {
      stateLock?.exec('ROLLBACK');
      stateLock?.close();
      input.end();
      await run.catch(() => {});
    }

    expect(send).not.toHaveBeenCalled();
    const persisted = JSON.parse(
      await readFile(baseWatchStatePath(fixture.repoRoot), 'utf8'),
    ) as {
      pendingReports: Array<{
        reportId: string;
        frozenBatchId?: string;
        frozenPayload?: string;
      }>;
    };
    expect(persisted.pendingReports).toHaveLength(1);
    expect(persisted.pendingReports[0]).not.toHaveProperty('frozenBatchId');
    expect(persisted.pendingReports[0]).not.toHaveProperty('frozenPayload');
  });

  it.each([
    ['commit', 'exit'], ['commit', 'eof'], ['commit', 'interrupt'],
    ['retry', 'exit'], ['retry', 'eof'], ['retry', 'interrupt'],
  ] as const)('stops after %s lock acquisition races with %s', async (phase, stopKind) => {
    const previousExitCode = process.exitCode;
    let snapshot: SessionObservationSnapshot = { sequence: 1, openQuestions: [] };
    const server = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => snapshot,
      answerOpenQuestion: async () => { throw new Error('unused'); },
    });
    fixture.closeServers.push(() => server.close());
    const resumePath = canonicalBaseResumeStorePath(fixture.repoRoot);
    const resume = JSON.parse(await readFile(resumePath, 'utf8')) as Record<string, unknown>;
    await writeFile(resumePath, JSON.stringify({ ...resume, harnessSocketPath: server.socketPath }));
    const setup = await createOperatorWatchPool({
      repoRoot: fixture.repoRoot, userEnsembleRoot: join(fixture.repoRoot, '.ensemble'), profile: 'smoke',
      dispatchQueue: createOperatorDispatchQueue(),
    });
    try {
      await setup.register('conductor-one', { pollIntervalMs: 60_000, debounceMs: 0 });
      await setup.pollOnce('conductor-one');
      snapshot = { sequence: 2, openQuestions: [{
        id: 'inq-stop-race', question: 'Preserve this report?', responseType: 'yes_no',
        source: 'conductor', status: 'open', askedAt: 10,
      }] };
      expect(await setup.pollOnce('conductor-one')).toBe(1);
    } finally { setup.close(); }
    const statePath = baseWatchStatePath(fixture.repoRoot);
    const initial = JSON.parse(await readFile(statePath, 'utf8')) as {
      pendingReports: Array<{ reportId: string }>;
    };
    const reportId = initial.pendingReports[0]!.reportId;
    const workspace = await realpath(join(fixture.repoRoot, '.ensemble', 'operator-agents', 'smoke'));
    let release!: () => void;
    let held: Promise<void> | undefined;
    let sawContention = false;
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    const hold = async () => {
      let entered!: () => void;
      const acquired = new Promise<void>((resolve) => { entered = resolve; });
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      held = withOperatorWorkspaceLock(workspace, async () => { entered(); await barrier; });
      await acquired;
      const original = DatabaseSync.prototype.exec;
      spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
        try { return original.call(this, sql); }
        catch (error) {
          if (sql === 'BEGIN IMMEDIATE' && error instanceof Error && /locked|busy/iu.test(error.message)) sawContention = true;
          throw error;
        }
      });
    };
    const send = vi.fn(async (_prompt: string) => {
      if (phase === 'retry') await hold();
      return { runId: 'stop-race', status: 'cancelled' as const, result: 'cancelled' };
    });
    const input = createInteractiveInput();
    input.isTTY = true;
    const output = createOutput();
    const run = runOperatorAgent({ repoRoot: fixture.repoRoot, newSession: true }, {
      stdin: input, stdout: output, autoDiscoverSessions: false,
      agentFactory: {
        create: async () => { if (phase === 'commit') await hold(); return createFakeAgent({ send }); },
        resume: async () => { throw new Error('unused'); },
      },
    });
    try {
      await vi.waitFor(() => expect(sawContention).toBe(true), { timeout: 8_000, interval: 5 });
      spy?.mockRestore();
      spy = undefined;
      if (stopKind === 'exit') {
        input.write('/exit\n');
        await vi.waitFor(() => expect(normalizeTtyText(output.capturedText())).toContain('session ended.'), { timeout: 500 });
      } else if (stopKind === 'eof') {
        const ended = new Promise<void>((resolve) => input.once('end', resolve));
        input.end();
        await ended;
      } else {
        process.emit('SIGINT');
      }
      release();
      await held; held = undefined;
      await run;
      expect(send).toHaveBeenCalledTimes(phase === 'commit' ? 0 : 1);
      const saved = JSON.parse(await readFile(statePath, 'utf8')) as {
        pendingReports: Array<{ reportId: string; frozenBatchId?: string; retryReadyAt?: number }>;
      };
      expect(saved.pendingReports).toEqual([expect.objectContaining({ reportId, frozenBatchId: expect.any(String) })]);
      if (phase === 'retry') expect(saved.pendingReports[0]!.retryReadyAt).toEqual(expect.any(Number));
      process.exitCode = previousExitCode;
      const retryInput = createInteractiveInput();
      retryInput.isTTY = true;
      const retryOutput = createOutput();
      const retrySend = vi.fn(async (_prompt: string) => ({
        runId: 'restart-stop-race', status: 'finished' as const, result: 'done',
      }));
      const retryRun = runOperatorAgent({ repoRoot: fixture.repoRoot, newSession: true }, {
        stdin: retryInput, stdout: retryOutput, autoDiscoverSessions: false,
        agentFactory: {
          create: async () => createFakeAgent({ send: retrySend }),
          resume: async () => { throw new Error('unused'); },
        },
      });
      try {
        await vi.waitFor(async () => {
          expect(retrySend).toHaveBeenCalledTimes(1);
          const state = JSON.parse(await readFile(statePath, 'utf8')) as { pendingReports: unknown[] };
          expect(state.pendingReports).toEqual([]);
        }, { timeout: 10_000 });
        expect(retrySend.mock.calls[0]?.[0]).toContain('Preserve this report?');
        retryInput.write('/exit\n');
        await retryRun;
      } finally {
        retryInput.end();
        await retryRun.catch(() => {});
      }
    } finally {
      spy?.mockRestore();
      if (held) { release(); await held; }
      input.end();
      process.exitCode = previousExitCode;
      await run.catch(() => {});
    }
  }, 20_000);

  it.each([false, true])('keeps pending reports through lock contention (restart=%s)', async (restart) => {
    let snapshot: SessionObservationSnapshot = { sequence: 1, openQuestions: [] };
    const server = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => snapshot,
      answerOpenQuestion: async () => { throw new Error('unused'); },
    });
    fixture.closeServers.push(() => server.close());
    const resumePath = canonicalBaseResumeStorePath(fixture.repoRoot);
    const resume = JSON.parse(await readFile(resumePath, 'utf8')) as Record<string, unknown>;
    await writeFile(resumePath, JSON.stringify({ ...resume, harnessSocketPath: server.socketPath }));
    const setup = await createOperatorWatchPool({
      repoRoot: fixture.repoRoot, userEnsembleRoot: join(fixture.repoRoot, '.ensemble'), profile: 'smoke',
      dispatchQueue: createOperatorDispatchQueue(),
    });
    try {
      await setup.register('conductor-one', { pollIntervalMs: 60_000, debounceMs: 0 });
      await setup.pollOnce('conductor-one');
      snapshot = { sequence: 2, openQuestions: [{
        id: 'inq-lock-retry', question: 'Retry after contention?', responseType: 'yes_no',
        source: 'conductor', status: 'open', askedAt: 10,
      }] };
      expect(await setup.pollOnce('conductor-one')).toBe(1);
    } finally { setup.close(); }
    const statePath = baseWatchStatePath(fixture.repoRoot);
    const initial = JSON.parse(await readFile(statePath, 'utf8')) as {
      pendingReports: Array<{ reportId: string }>;
    };
    const reportId = initial.pendingReports[0]!.reportId;
    const workspace = await realpath(join(fixture.repoRoot, '.ensemble', 'operator-agents', 'smoke'));
    let release!: () => void;
    let held: Promise<void> | undefined;
    const hold = async () => {
      let entered!: () => void;
      const acquired = new Promise<void>((resolve) => { entered = resolve; });
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      held = withOperatorWorkspaceLock(workspace, async () => { entered(); await barrier; });
      await acquired;
    };
    const send = vi.fn(async () => {
      if (send.mock.calls.length === 1) {
        await hold();
        return { runId: 'failed-report', status: 'cancelled' as const, result: 'cancelled' };
      }
      return { runId: 'retried-report', status: 'finished' as const, result: 'done' };
    });
    const input = createInteractiveInput();
    input.isTTY = true;
    const output = createOutput();
    const run = runOperatorAgent({ repoRoot: fixture.repoRoot, newSession: true }, {
      stdin: input, stdout: output, autoDiscoverSessions: false,
      agentFactory: {
        create: async () => { await hold(); return createFakeAgent({ send }); },
        resume: async () => { throw new Error('unused'); },
      },
    });
    try {
      await vi.waitFor(() => expect(normalizeTtyText(output.capturedText()))
        .toContain('監視報告の送信準備は lock の競合で待機中'), { timeout: 10_000 });
      expect(send).not.toHaveBeenCalled();
      release(); await held; held = undefined;
      await vi.waitFor(() => expect(normalizeTtyText(output.capturedText()))
        .toContain('監視報告の再送時刻の保存は lock の競合で待機中'), { timeout: 10_000 });
      expect(send).toHaveBeenCalledTimes(1);
      const frozen = JSON.parse(await readFile(statePath, 'utf8')) as {
        pendingReports: Array<{ reportId: string; frozenBatchId?: string }>;
      };
      expect(frozen.pendingReports).toEqual([expect.objectContaining({ reportId, frozenBatchId: expect.any(String) })]);
      if (restart) {
        input.write('/exit\n');
        await run;
      }
      release(); await held; held = undefined;
      if (restart) {
        const retryInput = createInteractiveInput();
        retryInput.isTTY = true;
        const retryOutput = createOutput();
        const retrySend = vi.fn(async (_prompt: string) => ({
          runId: 'restart-report', status: 'finished' as const, result: 'done',
        }));
        const retryRun = runOperatorAgent({ repoRoot: fixture.repoRoot }, {
          stdin: retryInput, stdout: retryOutput, autoDiscoverSessions: false,
          agentFactory: {
            create: async () => createFakeAgent({ send: retrySend }),
            resume: async () => createFakeAgent({ send: retrySend }),
          },
        });
        try {
          await vi.waitFor(async () => {
            expect(retrySend).toHaveBeenCalledTimes(1);
            const state = JSON.parse(await readFile(statePath, 'utf8')) as { pendingReports: unknown[] };
            expect(state.pendingReports).toEqual([]);
          }, { timeout: 15_000 });
          expect(retrySend.mock.calls[0]?.[0]).toContain('Retry after contention?');
          retryInput.write('/exit\n');
          await retryRun;
        } finally {
          retryInput.end();
          await retryRun.catch(() => {});
        }
        return;
      }
      await vi.waitFor(async () => {
        expect(send).toHaveBeenCalledTimes(2);
        const state = JSON.parse(await readFile(statePath, 'utf8')) as { pendingReports: unknown[] };
        expect(state.pendingReports).toEqual([]);
      }, { timeout: 15_000 });
      input.write('/exit\n');
      await run;
    } finally {
      if (held) { release(); await held; }
      input.end();
      await run.catch(() => {});
    }
  }, 40_000);

  it('retries a completed report acknowledgement in the same runner without resending the turn', async () => {
    let liveSnapshot: SessionObservationSnapshot = {
      sequence: 1,
      openQuestions: [],
    };
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => liveSnapshot,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    fixture.closeServers.push(() => liveServer.close());

    const resumeStorePath = canonicalBaseResumeStorePath(fixture.repoRoot);
    const resumeStore = JSON.parse(await readFile(resumeStorePath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      resumeStorePath,
      JSON.stringify({ ...resumeStore, harnessSocketPath: liveServer.socketPath }),
    );

    const setupPool = await createOperatorWatchPool({
      repoRoot: fixture.repoRoot,
      userEnsembleRoot: join(fixture.repoRoot, '.ensemble'),
      profile: 'smoke',
      dispatchQueue: createOperatorDispatchQueue(),
    });
    try {
      await setupPool.register('conductor-one', {
        pollIntervalMs: 60_000,
        debounceMs: 0,
      });
      expect(await setupPool.pollOnce('conductor-one')).toBe(0);
      liveSnapshot = {
        sequence: 2,
        openQuestions: [
          {
            id: 'inq-ack-retry',
            question: 'Retry only the acknowledgement?',
            responseType: 'yes_no',
            source: 'conductor',
            status: 'open',
            askedAt: 10,
          },
        ],
      };
      expect(await setupPool.pollOnce('conductor-one')).toBe(1);
    } finally {
      setupPool.close();
    }

    const statePath = baseWatchStatePath(fixture.repoRoot);
    const reportIds = (
      JSON.parse(await readFile(statePath, 'utf8')) as {
        pendingReports: Array<{ reportId: string }>;
      }
    ).pendingReports.map((report) => report.reportId);
    expect(reportIds).toHaveLength(1);

    const lockPath = join(
      fixture.repoRoot,
      '.ensemble',
      'operator-agents',
      'smoke',
      'watch',
      'watch-state-lock.sqlite',
    );
    let stateLock: DatabaseSync | undefined;
    const send = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('Retry only the acknowledgement?');
      stateLock = new DatabaseSync(lockPath);
      stateLock.exec('BEGIN IMMEDIATE');
      return {
        runId: 'completed-watch-report',
        status: 'finished',
        result: 'The report was handled.',
      };
    });
    const input = createInteractiveInput();
    input.isTTY = true;
    const output = createOutput();
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot, newSession: true },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async () => createFakeAgent({ send }),
          resume: async () => {
            throw new Error('not used');
          },
        },
      },
    );
    let runSettled = false;
    void run.then(
      () => {
        runSettled = true;
      },
      () => {
        runSettled = true;
      },
    );

    try {
      await vi.waitFor(() =>
        expect(normalizeTtyText(output.capturedText())).toContain(
          `5 秒後に ack だけを再試行します（1/${OPERATOR_WATCH_ACK_MAX_RETRIES}）`,
        ),
        { timeout: 6_000, interval: 25 },
      );
      expect(runSettled).toBe(false);
      expect(send).toHaveBeenCalledOnce();
      expect(
        (
          JSON.parse(await readFile(statePath, 'utf8')) as {
            pendingReports: Array<{ reportId: string }>;
          }
        ).pendingReports.map((report) => report.reportId),
      ).toEqual(reportIds);

      const firstFailureAt = Date.now();
      stateLock.exec('ROLLBACK');
      stateLock.close();
      stateLock = undefined;

      await vi.waitFor(async () => {
        const state = JSON.parse(await readFile(statePath, 'utf8')) as {
          pendingReports: Array<{ reportId: string }>;
        };
        expect(state.pendingReports).toEqual([]);
      }, { timeout: 12_000, interval: 50 });
      expect(Date.now() - firstFailureAt).toBeGreaterThanOrEqual(
        OPERATOR_WATCH_ACK_RETRY_DELAY_MS - 100,
      );
      expect(send).toHaveBeenCalledOnce();
      expect(runSettled).toBe(false);

      input.write('/exit\n');
      await run;
    } finally {
      if (stateLock) {
        stateLock.exec('ROLLBACK');
        stateLock.close();
      }
      if (!runSettled) input.write('/exit\n');
      input.end();
      await run.catch(() => {});
    }
  }, 20_000);

  it('stops explicitly after bounded ack retries and preserves the pending report', async () => {
    const previousExitCode = process.exitCode;
    let liveSnapshot: SessionObservationSnapshot = {
      sequence: 1,
      openQuestions: [],
    };
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => liveSnapshot,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    fixture.closeServers.push(() => liveServer.close());

    const resumeStorePath = canonicalBaseResumeStorePath(fixture.repoRoot);
    const resumeStore = JSON.parse(await readFile(resumeStorePath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      resumeStorePath,
      JSON.stringify({ ...resumeStore, harnessSocketPath: liveServer.socketPath }),
    );

    const setupPool = await createOperatorWatchPool({
      repoRoot: fixture.repoRoot,
      userEnsembleRoot: join(fixture.repoRoot, '.ensemble'),
      profile: 'smoke',
      dispatchQueue: createOperatorDispatchQueue(),
    });
    try {
      await setupPool.register('conductor-one', {
        pollIntervalMs: 60_000,
        debounceMs: 0,
      });
      expect(await setupPool.pollOnce('conductor-one')).toBe(0);
      liveSnapshot = {
        sequence: 2,
        openQuestions: [
          {
            id: 'inq-ack-exhausted',
            question: 'Keep the report when acknowledgement is unavailable?',
            responseType: 'yes_no',
            source: 'conductor',
            status: 'open',
            askedAt: 11,
          },
        ],
      };
      expect(await setupPool.pollOnce('conductor-one')).toBe(1);
    } finally {
      setupPool.close();
    }

    const statePath = baseWatchStatePath(fixture.repoRoot);
    const reportIds = (
      JSON.parse(await readFile(statePath, 'utf8')) as {
        pendingReports: Array<{ reportId: string }>;
      }
    ).pendingReports.map((report) => report.reportId);
    expect(reportIds).toHaveLength(1);

    let stateLock: DatabaseSync | undefined;
    const send = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('Keep the report when acknowledgement is unavailable?');
      stateLock = new DatabaseSync(
        join(
          fixture.repoRoot,
          '.ensemble',
          'operator-agents',
          'smoke',
          'watch',
          'watch-state-lock.sqlite',
        ),
      );
      stateLock.exec('BEGIN IMMEDIATE');
      return {
        runId: 'completed-but-unacknowledged',
        status: 'finished',
        result: 'The report was handled.',
      };
    });
    const input = createInteractiveInput();
    input.isTTY = true;
    const output = createOutput();
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot, newSession: true },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async () => createFakeAgent({ send }),
          resume: async () => {
            throw new Error('not used');
          },
        },
      },
    );

    try {
      await expect(run).rejects.toThrow(
        `Operator watch report acknowledgement failed after ${OPERATOR_WATCH_ACK_MAX_RETRIES} retries`,
      );
      expect(send).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
      expect(normalizeTtyText(output.capturedText())).toContain(
        'pending state は保持されています。重複 turn を避けるため runner を停止します。',
      );
      expect(
        normalizeTtyText(output.capturedText())
          .match(/5 秒後に ack だけを再試行します/gu),
      ).toHaveLength(OPERATOR_WATCH_ACK_MAX_RETRIES);
      expect(
        (
          JSON.parse(await readFile(statePath, 'utf8')) as {
            pendingReports: Array<{ reportId: string }>;
          }
        ).pendingReports.map((report) => report.reportId),
      ).toEqual(reportIds);
    } finally {
      if (stateLock) {
        stateLock.exec('ROLLBACK');
        stateLock.close();
      }
      input.end();
      process.exitCode = previousExitCode;
      await run.catch(() => {});
    }
  }, 30_000);

  it.each(['normal', 'missing-output', 'missing-ack', 'assertion', 'held-send'] as const)(
    'retains a cancelled watch report across restart and acknowledges it only after a completed retry: %s', async (scenario) => {
    let releaseInitialPoll!: () => void;
    const initialPollCompleted = new Promise<void>((resolve) => {
      releaseInitialPoll = resolve;
      watchPollHarness.onCompleted = (id) => {
        if (id === 'conductor-one') resolve();
      };
    });
    let liveSnapshot: SessionObservationSnapshot = {
      sequence: 0,
      openQuestions: [],
    };
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => liveSnapshot,
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    fixture.closeServers.push(() => liveServer.close());

    const resumeStorePath = canonicalBaseResumeStorePath(fixture.repoRoot);
    const resumeStore = JSON.parse(await readFile(resumeStorePath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      resumeStorePath,
      JSON.stringify({ ...resumeStore, harnessSocketPath: liveServer.socketPath }),
    );

    const statePath = baseWatchStatePath(fixture.repoRoot);
    const firstInput = createInteractiveInput();
    firstInput.isTTY = true;
    const firstOutput = createOutput();
    let firstAgentOptions: ConductorAgentCreateOptions | undefined;
    const firstPrompts: string[] = [];
    let releaseHeldSend!: () => void;
    let signalHeldSend!: () => void;
    const heldSend = new Promise<void>((resolve) => { releaseHeldSend = resolve; });
    const heldSendStarted = new Promise<void>((resolve) => { signalHeldSend = resolve; });
    const firstAgent = createFakeAgent({
      send: async (prompt) => {
        firstPrompts.push(prompt);
        if (firstPrompts.length === 1) {
          await firstAgentOptions!.customTools!.register_session_watch!.execute({
            conductorAgentId: 'conductor-one',
            pollIntervalMs: 250,
            debounceMs: 0,
          });
          await initialPollCompleted;
          if (scenario === 'held-send') {
            signalHeldSend();
            await heldSend;
          }
          liveSnapshot = {
            sequence: 1,
            openQuestions: [
              {
                id: 'inq-cancelled',
                question: 'Should this report be retried?',
                responseType: 'text',
                source: 'conductor',
                status: 'open',
                askedAt: 10,
              },
            ],
          };
          return {
            runId: 'first-user-send',
            status: 'completed',
            result: 'watch registered',
          };
        }
        const saved = JSON.parse(await readFile(statePath, 'utf8')) as {
          pendingReports: Array<{ reportId: string }>;
        };
        expect(saved.pendingReports).toHaveLength(1);
        return {
          runId: 'cancelled-report-send',
          status: 'cancelled',
          result: 'partial; cancelled',
        };
      },
    });
    const firstRun = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: firstInput,
        stdout: firstOutput,
        agentFactory: {
          create: async (options) => {
            firstAgentOptions = options;
            return firstAgent;
          },
          resume: async () => {
            throw new Error('not used');
          },
        },
      },
    );

    let firstFailure: unknown;
    try {
      await vi.waitFor(() =>
        expect(firstOutput.capturedText()).toContain('user>'),
      );
      firstInput.write('watch this session\n');
      if (scenario === 'held-send') await waitForNotification(heldSendStarted, 'held send', 5_000);
      await waitForOutput(
        firstOutput,
        scenario === 'missing-output' || scenario === 'held-send' ? 'injected missing output' : 'send not completed (status=cancelled); watched reports retained for retry.',
        scenario === 'missing-output' || scenario === 'held-send' ? AbortSignal.timeout(100) : undefined,
      );
      firstInput.end();
      await waitForNotification(firstRun.then(() => {}), 'first runner shutdown', 5_000);
    } catch (error) {
      if (scenario !== 'missing-output' && scenario !== 'held-send') throw error;
      firstFailure = error;
    } finally {
      releaseInitialPoll();
      releaseHeldSend();
      watchPollHarness.onCompleted = undefined;
      firstInput.end();
      try {
        await waitForNotification(firstRun.then(() => {}, () => {}), 'first runner shutdown', 5_000);
      } catch (error) {
        fixture.preserveFixture = true;
        throw new Error(`fixture preserved at ${fixture.repoRoot}; ${String(error)}`);
      }
    }
    if (scenario === 'missing-output' || scenario === 'held-send') {
      expect(firstFailure).toBeInstanceOf(Error);
      expect(firstOutput.listenerCount('data')).toBe(1);
      return;
    }

    const afterCancelledSend = JSON.parse(
      await readFile(statePath, 'utf8'),
    ) as {
      pendingReports: Array<{ reportId: string; retryReadyAt?: number }>;
    };
    expect(afterCancelledSend.pendingReports).toHaveLength(1);
    expect(afterCancelledSend.pendingReports[0]?.retryReadyAt).toBeGreaterThan(
      Date.now(),
    );
    expect(normalizeTtyText(firstOutput.capturedText())).toContain(
      'send not completed (status=cancelled); watched reports retained for retry.',
    );

    const retryInput = createInteractiveInput();
    retryInput.isTTY = true;
    const retryOutput = createOutput();
    const retryPrompts: string[] = [];
    const retryAgent = createFakeAgent({
      send: async (prompt) => {
        retryPrompts.push(prompt);
        return {
          runId: 'completed-report-retry',
          status: 'finished',
          result: 'report handled',
        };
      },
    });
    const retryAcknowledged = new Promise<void>((resolve) => {
      watchPollHarness.onAcknowledged = resolve;
    });
    const retryRun = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: retryInput,
        stdout: retryOutput,
        agentFactory: {
          create: async () => {
            throw new Error('saved operator-agent state should resume');
          },
          resume: async () => retryAgent,
        },
      },
    );

    let retryFailure: unknown;
    try {
      if (scenario === 'missing-ack') {
        await waitForNotification(new Promise<void>(() => {}), 'retry acknowledgement', 100);
      } else if (scenario === 'assertion') {
        expect(false, 'injected retry assertion failure').toBe(true);
      } else {
        await waitForNotification(retryAcknowledged, 'retry acknowledgement', 8_000);
      }
      expect(retryPrompts).toHaveLength(1);
      expect(retryPrompts[0]).toContain('Should this report be retried?');
      const saved = JSON.parse(await readFile(statePath, 'utf8')) as {
        pendingReports: Array<{ reportId: string }>;
      };
      expect(saved.pendingReports).toHaveLength(0);
      retryInput.write('/exit\n');
      await waitForNotification(retryRun.then(() => {}), 'retry runner shutdown', 5_000);
    } catch (error) {
      if (scenario === 'normal') throw error;
      retryFailure = error;
    } finally {
      watchPollHarness.onAcknowledged = undefined;
      retryInput.end();
      try {
        await waitForNotification(retryRun.then(() => {}, () => {}), 'retry runner shutdown', 5_000);
      } catch (error) {
        fixture.preserveFixture = true;
        throw new Error(`fixture preserved at ${fixture.repoRoot}; ${String(error)}`);
      }
    }
    if (scenario !== 'normal') expect(retryFailure).toBeInstanceOf(Error);
  }, 15_000);
});


function createInput(text: string, isTTY = true): OperatorAgentInput {
  const input = createInteractiveInput();
  input.isTTY = isTTY;
  input.write(text.replace(/\n/g, '\r'));
  input.endWhenReady();
  return input;
}

function normalizeTtyText(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}


function waitForOutput(
  output: ReturnType<typeof createOutput>,
  text: string,
  signal: AbortSignal = AbortSignal.timeout(5_000),
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      output.off('data', check);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(new Error(`output did not contain: ${text}`));
    };
    const check = () => {
      if (!normalizeTtyText(output.capturedText()).includes(text)) return;
      cleanup();
      resolve();
    };
    output.on('data', check);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    check();
  });
}


// Exercise the real Pi conductor event and send handling with a deterministic
// AgentSession boundary; no provider or network is needed.
function createScriptedPiAgent(
  options: ConductorAgentCreateOptions,
  prompt: (emit: (event: any) => void, text: string) => Promise<{ error?: string; text?: string }>,
) {
  let listener: (event: any) => void = () => {};
  const messages: any[] = [];
  const branch: any[] = [];
  const results: Awaited<ReturnType<ConductorAgent['send']>>[] = [];
  const session = {
    state: { messages },
    sessionManager: { getBranch: () => branch, appendCustomEntry: () => {} },
    subscribe: (next: typeof listener) => { listener = next; return () => {}; },
    prompt: async (text: string) => {
      const outcome = await prompt((event) => listener(event), text);
      const message = {
        role: 'assistant', content: outcome.text ? [{ type: 'text', text: outcome.text }] : [],
        stopReason: outcome.error ? 'error' : 'stop', errorMessage: outcome.error,
        model: 'smoke-model', usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0 },
      };
      messages.push(message);
      branch.push({ type: 'message', id: 'user', message: { role: 'user', content: text } });
      branch.push({ type: 'message', id: 'assistant', message });
      listener({ type: 'agent_end', messages: [message] });
    },
    abort: async () => {}, dispose: () => {},
  };
  const agent = new PiConductorAgent(
    session as never, {} as never, {} as never, {} as never, { value: '' },
    'operator-agent-id', 'smoke-model', {}, { enabled: false }, { active: false },
    false, false, undefined, undefined, options.onRetryEvent, options.onCompactionEvent,
  );
  const send = agent.send.bind(agent);
  agent.send = async (...args) => {
    const result = await send(...args);
    results.push(result);
    return result;
  };
  return { agent, results, emit: (event: any) => listener(event) };
}


function canonicalBaseResumeStorePath(repoRoot: string): string {
  return resolveEnsemblePaths({ repoRoot }).canonicalSessionResumeStorePath(
    'https://github.com/example/project/issues/12',
    'conductor-one',
  );
}

function baseWatchStatePath(repoRoot: string): string {
  return operatorWatchStatePath(
    join(repoRoot, '.ensemble'),
    'smoke',
    'https://github.com/example/project/issues/12',
  );
}


async function writeUserMcpConfig(
  repoRoot: string,
  servers: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    join(repoRoot, '.ensemble', MCP_CONFIG_FILE),
    JSON.stringify({ mcpServers: servers }),
  );
}
