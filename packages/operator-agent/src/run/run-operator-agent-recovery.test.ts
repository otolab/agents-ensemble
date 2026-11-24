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


  it('keeps the TTY transcript free of ANSI escapes when NO_COLOR is set', async () => {
    process.env.NO_COLOR = '1';
    const output = createOutput();

    await runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: createInput('hello\n/exit\n'),
        stdout: output,
        agentFactory: {
          create: async () =>
            createFakeAgent({
              send: async () => ({
                runId: 'run-1',
                status: 'completed',
                result: 'Plain response.',
              }),
            }),
          resume: async () => {
            throw new Error('not used');
          },
        },
      },
    );

    const transcript = output.capturedText();
    expect(transcript).not.toMatch(/\u001b\[(?:2|31|36)m/);
    expect(transcript).toContain('user> ');
    expect(transcript).toContain('[harness] operator: 処理中');
    expect(transcript).not.toMatch(/(?:^|\n)> /);
    expect(transcript).toContain('operator>\nPlain response.\n\n');
    expect(transcript).toContain('[observation] session ended.');
  });

  it('keeps error rows spaced and labeled', async () => {
    const output = createOutput();

    await runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: createInput('hello\n/exit\n'),
        stdout: output,
        agentFactory: {
          create: async () =>
            createFakeAgent({
              send: async () => ({
                runId: 'run-1',
                status: 'error',
                error: new Error('Request failed.'),
              }),
            }),
          resume: async () => {
            throw new Error('not used');
          },
        },
      },
    );

    expect(output.capturedText()).toContain('[harness] Request failed.');
  });

  it('escapes backend status controls in operator-agent failure notices', async () => {
    const input = createInteractiveInput();
    input.isTTY = true;
    const stdout = createOutput();
    const stderr = createOutput();
    const config: EnsembleConfig = {
      profile: { default: 'unused' },
      conductor: { backend: 'cursor', model: 'cursor-model' },
    } as EnsembleConfig;
    const profile: ResolvedProfile = {
      workers: [],
      agents: {},
    };
    const backendStatus = 'error\u001b[2J\u202e\u2066\nspoof';
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout,
        stderr,
        loadConfig: async () => config,
        loadProfile: async () => ({ profile, profilePath: 'test-profile' }),
        agentFactory: {
          create: async () =>
            createFakeAgent({
              send: async () => ({
                runId: 'run-untrusted-status',
                status: backendStatus,
              }),
            }),
          resume: async () => {
            throw new Error('not used');
          },
        },
      },
    );
    let exited = false;
    try {
      await vi.waitFor(() =>
        expect(stdout.capturedText()).toContain('user>'),
      );
      input.write('inspect current state\n');
      await vi.waitFor(() => {
        const output = normalizeTtyText(stdout.capturedText());
        expect(output).toContain(
          'operator send が未完了です (status=error\\u001b[2J\\u202e\\u2066\\u000aspoof',
        );
        expect(output).toContain(
          'send not completed (status=error\\u001b[2J\\u202e\\u2066\\u000aspoof); watched reports retained for retry.',
        );
      });

      const escapedStatus =
        'error\\u001b[2J\\u202e\\u2066\\u000aspoof';
      const statuses = [
        ...normalizeTtyText(stdout.capturedText()).matchAll(
            /(?:operator send が未完了です \(status=|send not completed \(status=)(.*?)(?:, failure=|\);)/gu,
          ),
      ].map((match) => match[1]);
      expect(statuses).toEqual([escapedStatus, escapedStatus]);
      for (const status of statuses) {
        expect(status).not.toContain('\u001b');
        expect(status).not.toContain('\u202e');
        expect(status).not.toContain('\u2066');
        expect(status).not.toContain('\n');
      }

      input.write('/exit\n');
      await run;
      exited = true;
    } finally {
      if (!exited) input.write('/exit\n');
      input.end();
      await run.catch(() => {});
    }
  });

  it('keeps only authored input after a failed first Cursor send and waits for confirmation', async () => {
    await writeOperatorSettings(fixture.repoRoot, 'cursor');
    const input = createInteractiveInput();
    input.isTTY = true;
    const stdout = createOutput();
    const stderr = createOutput();
    const config: EnsembleConfig = {
      profile: { default: 'unused' },
      conductor: { backend: 'cursor', model: 'cursor-model' },
    } as EnsembleConfig;
    const profile: ResolvedProfile = {
      workers: [],
      agents: {},
    };
    const authoredInput = 'check status after reconnect';
    const followupInput = 'continue only the unfinished work';
    const sentPrompts: string[] = [];
    const initialSend = vi.fn(async (prompt: string) => {
      sentPrompts.push(prompt);
      return {
        runId: 'run-auth',
        status: 'error',
        error: {
          code: 'auth',
          message:
            'API key auth failed for provider cursor: authentication failed',
        },
      };
    });
    const automaticResumeSend = vi.fn(async (prompt: string) => {
      sentPrompts.push(prompt);
      return {
        runId: 'unexpected-retry',
        status: 'completed',
        result: 'unexpected replay',
      };
    });
    const manualResumeSend = vi.fn(async (prompt: string) => {
      sentPrompts.push(prompt);
      return {
        runId: 'run-followup',
        status: 'completed',
        result: 'Follow-up handled.',
      };
    });
    const resume = vi
      .fn()
      .mockResolvedValueOnce(
        createFakeAgent({ send: automaticResumeSend }),
      )
      .mockResolvedValueOnce(createFakeAgent({ send: manualResumeSend }));

    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout,
        stderr,
        loadConfig: async () => config,
        loadProfile: async () => ({ profile, profilePath: 'test-profile' }),
        agentFactory: {
          create: async () => createFakeAgent({ send: initialSend }),
          resume,
        },
      },
    );
    let exited = false;
    try {
      await vi.waitFor(() =>
        expect(stdout.capturedText()).toContain('user>'),
      );
      input.write(`${authoredInput}\n`);
      await vi.waitFor(() => {
        expect(resume).toHaveBeenCalledOnce();
        expect(normalizeTtyText(stdout.capturedText())).toContain(
          'operator send が未完了です (status=error, failure=auth)',
        );
      });

      expect(initialSend).toHaveBeenCalledOnce();
      expect(sentPrompts[0]).toContain(
        'agents-ensemble の operator ロール',
      );
      expect(sentPrompts[0]).toContain('## User message');
      expect(sentPrompts[0]).toContain(authoredInput);
      expect(automaticResumeSend).not.toHaveBeenCalled();
      expect(stdout.capturedText()).toContain(
        'source=automatic',
      );

      input.write('/recovery list\n');
      input.write('/recovery show conductor-recovery-1\n');
      await vi.waitFor(() =>
        expect(stdout.capturedText()).toContain(
          'Sensitive recovery content · conductor-recovery-1',
        ),
      );
      const showStart = stdout.capturedText().indexOf(
        'Sensitive recovery content · conductor-recovery-1',
      );
      const recoveryDisplay = stdout.capturedText().slice(showStart);
      expect(recoveryDisplay).toContain(authoredInput);
      expect(recoveryDisplay).not.toContain(
        'agents-ensemble の operator ロール',
      );
      expect(recoveryDisplay).not.toContain('Profile operator guidance.');

      input.write(`${followupInput}\n`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(manualResumeSend).not.toHaveBeenCalled();
      input.write('/reconnect\n');
      await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(2));
      expect(manualResumeSend).not.toHaveBeenCalled();
      expect(stdout.capturedText()).toContain(
        'source=manual failure=auth',
      );

      input.write('/recovery continue\n');
      await vi.waitFor(() => expect(manualResumeSend).toHaveBeenCalledOnce());
      expect(sentPrompts).toHaveLength(2);
      expect(sentPrompts[1]).toContain(followupInput);
      expect(sentPrompts[1]).toContain(
        'agents-ensemble の operator ロール',
      );
      expect(sentPrompts[1]).toContain('## User message');
      expect(sentPrompts[1]).not.toContain(authoredInput);
      expect(stdout.capturedText()).toContain('Follow-up handled.');

      input.write('/exit\n');
      await vi.waitFor(() =>
        expect(normalizeTtyText(stdout.capturedText())).toContain(
          'session ended.',
        ),
      );
      await run;
      exited = true;
    } finally {
      if (!exited) input.write('/exit\n');
      input.end();
      await run.catch(() => {});
    }
  });

  it('does not close the old conductor again when finalization follows failed resume', async () => {
    const input = createInteractiveInput();
    input.isTTY = true;
    const stdout = createOutput();
    const stderr = createOutput();
    const authFailure = {
      runId: 'run-auth',
      status: 'error',
      error: {
        code: 'auth',
        message:
          'API key auth failed for provider cursor: authentication failed',
      },
    };
    const oldClose = vi.fn().mockResolvedValue(undefined);
    const oldSend = vi.fn().mockResolvedValue(authFailure);
    const oldAgent = {
      ...createFakeAgent({ send: oldSend }),
      close: oldClose,
    };
    const resume = vi
      .fn()
      .mockRejectedValue(new Error('resume unavailable'));
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout,
        stderr,
        loadConfig: async () => ({
          profile: { default: 'unused' },
          conductor: { backend: 'cursor', model: 'cursor-model' },
        }) as EnsembleConfig,
        loadProfile: async () => ({
          profile: { workers: [], agents: {} } as ResolvedProfile,
          profilePath: 'test-profile',
        }),
        agentFactory: {
          create: async () => oldAgent,
          resume,
        },
      },
    );

    input.write('request whose result is unknown\n');
    await vi.waitFor(() => {
      expect(resume).toHaveBeenCalledOnce();
      expect(normalizeTtyText(stdout.capturedText())).toContain(
        'operator send が未完了です (status=error, failure=auth)',
      );
    });
    input.write('/exit\n');
    await run;

    expect(oldSend).toHaveBeenCalledOnce();
    expect(oldClose).toHaveBeenCalledOnce();
    input.end();
  });

  it('holds user input and watch reports that arrive during automatic resume, then dispatches them in order', async () => {
    await writeOperatorSettings(fixture.repoRoot, 'cursor');
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
    const resumeStore = JSON.parse(
      await readFile(resumeStorePath, 'utf8'),
    ) as Record<string, unknown>;
    await writeFile(
      resumeStorePath,
      JSON.stringify({ ...resumeStore, harnessSocketPath: liveServer.socketPath }),
    );

    const input = createInteractiveInput();
    input.isTTY = true;
    const stdout = createOutput();
    const stderr = createOutput();
    const config: EnsembleConfig = {
      profile: { default: 'unused' },
      conductor: { backend: 'cursor', model: 'cursor-model' },
    } as EnsembleConfig;
    const profile: ResolvedProfile = {
      workers: [],
      agents: {},
    };
    const failedInput = 'possibly completed operator request';
    const followupInput = 'inspect current state and continue unfinished work';
    const reportQuestion = 'Review the queued implementation after recovery?';
    const authFailure = {
      runId: 'run-auth',
      status: 'error',
      error: {
        code: 'auth',
        message:
          'API key auth failed for provider cursor: authentication failed',
      },
    };
    const sentPrompts: string[] = [];
    let agentOptions: ConductorAgentCreateOptions | undefined;
    const oldClose = vi.fn().mockResolvedValue(undefined);
    let reportPoll!: Promise<void>;
    const firstSend = vi.fn(async (prompt: string) => {
      const baselinePoll = nextWatchPoll();
      sentPrompts.push(prompt);
      await agentOptions!.customTools!.register_session_watch!.execute({
        conductorAgentId: 'conductor-one',
        pollIntervalMs: 250,
        debounceMs: 0,
      });
      await baselinePoll;
      reportPoll = nextWatchPoll(1);
      liveSnapshot = {
          sequence: 1,
          openQuestions: [
            {
              id: 'inq-after-failure',
              question: reportQuestion,
              responseType: 'text',
              source: 'conductor',
              status: 'open',
              askedAt: 1,
            },
          ],
      };
      return authFailure;
    });
    const resumedSend = vi.fn(async (prompt: string) => {
      sentPrompts.push(prompt);
      return {
        runId: `run-resumed-${resumedSend.mock.calls.length}`,
        status: 'completed' as const,
        result: 'received',
      };
    });
    const resumedClose = vi.fn().mockResolvedValue(undefined);
    const resumedAgent = {
      ...createFakeAgent({ send: resumedSend }),
      close: resumedClose,
    };
    let rejectAutomaticResume!: (error: Error) => void;
    const pendingAutomaticResume = new Promise<ConductorAgent>((_resolve, reject) => {
      rejectAutomaticResume = reject;
    });
    const resume = vi
      .fn()
      .mockReturnValueOnce(pendingAutomaticResume)
      .mockRejectedValueOnce(new Error('manual resume unavailable'))
      .mockResolvedValueOnce(resumedAgent);
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout,
        stderr,
        loadConfig: async () => config,
        loadProfile: async () => ({ profile, profilePath: 'test-profile' }),
        agentFactory: {
          create: async (options) => {
            agentOptions = options;
            return {
              ...createFakeAgent({ send: firstSend }),
              close: oldClose,
            };
          },
          resume,
        },
      },
    );

    let exited = false;
    try {
      await vi.waitFor(() =>
        expect(stdout.capturedText()).toContain('user>'),
      );
      input.write(`${failedInput}\n`);
      await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
      expect(firstSend).toHaveBeenCalledOnce();
      expect(sentPrompts[0]).toContain(failedInput);
      expect(resumedSend).not.toHaveBeenCalled();

      input.write(`${followupInput}\n`);
      const watchStatePath = baseWatchStatePath(fixture.repoRoot);
      await reportPoll;
      const heldState = JSON.parse(
        await readFile(watchStatePath, 'utf8'),
      ) as { pendingReports: Array<{ reportId: string }> };
      expect(heldState.pendingReports).toHaveLength(1);
      expect(firstSend).toHaveBeenCalledOnce();
      expect(resumedSend).not.toHaveBeenCalled();
      rejectAutomaticResume(new Error('automatic resume unavailable'));
      await vi.waitFor(() =>
        expect(normalizeTtyText(stdout.capturedText())).toContain(
          'operator send が未完了です (status=error, failure=auth)',
        ),
      );

      input.write('/reconnect\n');
      await vi.waitFor(() => {
        expect(resume).toHaveBeenCalledTimes(2);
        expect(normalizeTtyText(stdout.capturedText())).toContain(
          'source=manual failure=auth',
        );
      });
      expect(resumedSend).not.toHaveBeenCalled();

      input.write('/reconnect\n');
      await vi.waitFor(() => {
        expect(resume).toHaveBeenCalledTimes(3);
        expect(stdout.capturedText()).toContain(
          'conductor に再接続しました。',
        );
      });
      expect(resumedSend).not.toHaveBeenCalled();

      const reportAcknowledged = new Promise<void>((resolve) => {
        watchPollHarness.onAcknowledged = resolve;
      });
      input.write('/recovery continue\n');
      await reportAcknowledged;
      expect(resumedSend).toHaveBeenCalledTimes(2);
      expect(sentPrompts).toHaveLength(3);
      expect(sentPrompts[1]).toContain(
        'agents-ensemble の operator ロール',
      );
      expect(sentPrompts[1]).toContain(followupInput);
      expect(sentPrompts[1]).not.toContain(failedInput);
      expect(sentPrompts[1]).not.toContain(reportQuestion);

      expect(sentPrompts[2]).toContain(reportQuestion);
      expect(sentPrompts[2]).not.toContain(followupInput);
      expect(sentPrompts[2]).not.toContain(
        'agents-ensemble の operator ロール',
      );
      const saved = JSON.parse(
        await readFile(watchStatePath, 'utf8'),
      ) as { pendingReports: Array<{ reportId: string }> };
      expect(saved.pendingReports).toHaveLength(0);

      input.write('/exit\n');
      await run;
      exited = true;
      expect(firstSend).toHaveBeenCalledOnce();
      expect(oldClose).toHaveBeenCalledOnce();
      expect(resumedClose).toHaveBeenCalledOnce();
    } finally {
      if (!exited) input.write('/exit\n');
      input.end();
      await run.catch(() => {});
    }
  });

  it('closes a late automatic resume after SIGTERM instead of installing it', async () => {
    const previousExitCode = process.exitCode;
    const input = createInteractiveInput();
    input.isTTY = true;
    const stdout = createOutput();
    const stderr = createOutput();
    const config: EnsembleConfig = {
      profile: { default: 'unused' },
      conductor: { backend: 'cursor', model: 'cursor-model' },
    } as EnsembleConfig;
    const profile: ResolvedProfile = {
      workers: [],
      agents: {},
    };
    const authFailure = {
      runId: 'run-auth',
      status: 'error',
      error: {
        code: 'auth',
        message:
          'API key auth failed for provider cursor: authentication failed',
      },
    };
    const oldClose = vi.fn().mockResolvedValue(undefined);
    const oldSend = vi.fn().mockResolvedValue(authFailure);
    const oldAgent = {
      ...createFakeAgent({ send: oldSend }),
      close: oldClose,
    };
    let resolveResume!: (agent: ConductorAgent) => void;
    const pendingResume = new Promise<ConductorAgent>((resolve) => {
      resolveResume = resolve;
    });
    const lateClose = vi.fn().mockResolvedValue(undefined);
    const lateSend = vi.fn();
    const lateAgent = {
      ...createFakeAgent({ send: lateSend }),
      close: lateClose,
    };
    const resume = vi.fn(() => pendingResume);
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout,
        stderr,
        loadConfig: async () => config,
        loadProfile: async () => ({ profile, profilePath: 'test-profile' }),
        agentFactory: {
          create: async () => oldAgent,
          resume,
        },
      },
    );

    let resumeResolved = false;
    let terminationSent = false;
    try {
      await vi.waitFor(() =>
        expect(stdout.capturedText()).toContain('user>'),
      );
      input.write('input that fails during Cursor bootstrap\n');
      await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());

      expect(process.emit('SIGTERM')).toBe(true);
      terminationSent = true;
      expect(process.exitCode).toBe(143);
      await run;

      resolveResume(lateAgent);
      resumeResolved = true;
      await vi.waitFor(() => expect(lateClose).toHaveBeenCalledOnce());
      expect(oldSend).toHaveBeenCalledOnce();
      expect(lateSend).not.toHaveBeenCalled();
      expect(stdout.capturedText()).not.toContain(
        'conductor に再接続しました。',
      );
    } finally {
      if (!resumeResolved) {
        if (!terminationSent) process.emit('SIGTERM');
        resolveResume(lateAgent);
        await vi.waitFor(() => expect(lateClose).toHaveBeenCalledOnce());
      }
      process.exitCode = previousExitCode;
      input.end();
      await run.catch(() => {});
    }
  });

  it('treats a rejected send as unknown without exposing provider details', async () => {
    const authoredInput = 'possibly completed task';
    const input = createInput(`${authoredInput}\n`);
    const stdout = createOutput();
    const stderr = createOutput();
    const rawError = 'ambiguous provider rejection with secret-token';
    const rejectedSend = vi
      .fn()
      .mockRejectedValue(new Error(rawError));
    const resume = vi.fn(async () =>
      createFakeAgent({ send: vi.fn() }),
    );

    await runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout,
        stderr,
        agentFactory: {
          create: async () => createFakeAgent({ send: rejectedSend }),
          resume,
        },
      },
    );

    const output = normalizeTtyText(stdout.capturedText());
    expect(rejectedSend).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
    expect(output).toContain(
      'operator send が未完了です (status=send_rejected, failure=send_rejected)',
    );
    expect(output).toContain(
      '明示的に /reconnect するまで conductor への送信を停止します。',
    );
    expect(output).toContain('operator: 待機中');
    expect(output).not.toContain(rawError);
    expect(stderr.capturedText()).not.toContain(rawError);
  });

  it('routes Pi retry events through send and queues reconnect until success', async () => {
    const stdin = createInteractiveInput();
    const stdout = createOutput();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    let pi!: ReturnType<typeof createScriptedPiAgent>;
    const resume = vi.fn(async (_id: string, options: ConductorAgentCreateOptions) =>
      createScriptedPiAgent(options, async () => ({ text: 'resumed' })).agent,
    );
    const run = runOperatorAgent({ repoRoot: fixture.repoRoot }, { stdin, stdout, agentFactory: {
      create: async (options) => {
        pi = createScriptedPiAgent(options, async (emit) => {
          emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 20, errorMessage: 'overloaded' });
          emit({ type: 'compaction_start', reason: 'threshold' });
          emit({ type: 'summarization_retry_scheduled', attempt: 1, maxAttempts: 2, delayMs: 10, errorMessage: 'timeout' });
          emit({ type: 'summarization_retry_attempt_start', source: 'compaction', reason: 'threshold' });
          emit({ type: 'summarization_retry_finished' });
          emit({ type: 'compaction_end', reason: 'threshold', result: { tokensBefore: 200 }, aborted: false, willRetry: false });
          await pending;
          emit({ type: 'auto_retry_end', success: true, attempt: 1 });
          return { text: 'done' };
        });
        return pi.agent;
      }, resume,
    } });
    try {
      await vi.waitFor(() => expect(stdout.capturedText()).toContain('(pi) ready'));
      stdin.write('hello\n');
      await vi.waitFor(() => expect(stdout.capturedText()).toContain('[pi retry] attempt 1/3 in 20ms error=overloaded'));
      stdin.write('/reconnect\n');
      await vi.waitFor(() => expect(stdout.capturedText()).toContain('user> /reconnect'));
      expect(resume).not.toHaveBeenCalled();
      finish();
      await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
      expect(pi.results).toMatchObject([{ status: 'finished', result: 'done' }]);
      expect(stdout.capturedText()).toContain('[pi retry] succeeded');
      expect(stdout.capturedText()).toContain('[pi summarization retry] attempt 1/2 in 10ms error=timeout');
      expect(normalizeTtyText(stdout.capturedText())).toContain('[pi summarization retry] attempt started source=compaction reason=threshold');
      expect(stdout.capturedText()).toContain('[pi summarization retry] finished');
      const transcript = normalizeTtyText(stdout.capturedText());
      const compactionStart = transcript.indexOf('compaction 開始（自動）');
      const retryStart = transcript.indexOf('[pi summarization retry] attempt 1/2');
      const retryEnd = transcript.indexOf('[pi summarization retry] finished');
      const compactionEnd = transcript.indexOf('compaction 成功（このプロセスで 1 回、圧縮前 200 tokens）');
      expect(compactionStart).toBeGreaterThanOrEqual(0);
      expect(retryStart).toBeGreaterThan(compactionStart);
      expect(retryEnd).toBeGreaterThan(retryStart);
      expect(compactionEnd).toBeGreaterThan(retryEnd);
    } finally {
      finish();
      stdin.write('/exit\n');
      await run;
    }
  });

  it('routes Pi retry exhaustion through send failure, reconnect and recovery', async () => {
    const stdin = createInteractiveInput();
    const stdout = createOutput();
    let pi!: ReturnType<typeof createScriptedPiAgent>;
    let recovered!: ReturnType<typeof createScriptedPiAgent>;
    const resume = vi.fn(async (_id: string, options: ConductorAgentCreateOptions) => {
      recovered = createScriptedPiAgent(options, async () => ({ text: 'followup complete' }));
      return recovered.agent;
    });
    const run = runOperatorAgent({ repoRoot: fixture.repoRoot }, { stdin, stdout, agentFactory: {
      create: async (options) => {
        pi = createScriptedPiAgent(options, async (emit) => {
          emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 1, delayMs: 10, errorMessage: 'connection reset' });
          emit({ type: 'auto_retry_end', success: false, attempt: 1, finalError: 'connection reset by peer' });
          return { error: 'connection reset by peer' };
        });
        return pi.agent;
      }, resume,
    } });
    try {
      await vi.waitFor(() => expect(stdout.capturedText()).toContain('(pi) ready'));
      stdin.write('first request\n');
      await vi.waitFor(() => expect(normalizeTtyText(stdout.capturedText())).toContain('operator send が未完了'));
      expect(pi.results).toMatchObject([{ status: 'error', error: { message: 'connection reset by peer' } }]);
      expect(stdout.capturedText()).toContain('[pi retry] failed attempt=1 error=connection reset by peer');
      expect(stdout.capturedText()).toContain('[transport] conductor reconnect');
      expect(resume).toHaveBeenCalledOnce();
      stdin.write('followup\n');
      stdin.write('/recovery continue\n');
      await vi.waitFor(() => expect(recovered.results).toMatchObject([{ status: 'finished', result: 'followup complete' }]));
    } finally {
      stdin.write('/exit\n');
      await run;
    }
  });

  it('intercepts reconnect commands and reports each resume result without sending them', async () => {
    await writeOperatorSettings(fixture.repoRoot, 'pi', undefined, {
      profile: ['reconnect-server'],
    });
    await writeUserMcpConfig(fixture.repoRoot, {
      'reconnect-server': { type: 'stdio', command: 'reconnect-mcp' },
    });
    const stdout = createOutput();
    const stdin = createInteractiveInput();
    stdin.isTTY = true;
    const send = vi.fn(async () => ({
      runId: 'run-1',
      status: 'completed',
      result: 'Ready.',
    }));
    const initialAgent = createFakeAgent({ send });
    const resumedAgents = [
      createFakeAgent({ send: async () => ({ runId: '', status: 'completed' }) }),
      createFakeAgent({ send: async () => ({ runId: '', status: 'completed' }) }),
    ];
    let finishReconnect!: () => void;
    const reconnectGate = new Promise<void>((resolve) => { finishReconnect = resolve; });
    const resume = vi
      .fn()
      .mockImplementationOnce(async () => { await reconnectGate; return resumedAgents[0]; })
      .mockRejectedValueOnce(new Error('resume unavailable'));
    let createdOptions: ConductorAgentCreateOptions | undefined;

    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin,
        stdout,
        agentFactory: {
          create: async (options) => {
            createdOptions = options;
            return initialAgent;
          },
          resume,
        },
      },
    );

    await vi.waitFor(() =>
      expect(stdout.capturedText()).toContain('(pi) ready'),
    );
    stdin.write('/reconnect\n');
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(stdout.capturedText()).toContain('operator: reconnecting'));
    finishReconnect();
    await vi.waitFor(() => expect(stdout.capturedText()).toContain('conductor に再接続しました。'));
    stdin.write('reconnect\n');
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(2));
    stdin.write('/exit\n');
    await run;

    expect(resume).toHaveBeenCalledTimes(2);
    expect(createdOptions?.mcpServers).toEqual({
      'reconnect-server': { type: 'stdio', command: 'reconnect-mcp' },
    });
    expect(createdOptions).toMatchObject({
      operatorPiMcpMode: 'direct',
      builtinTools: false,
      piExtensions: false,
    });
    expect(resume).toHaveBeenNthCalledWith(
      1,
      'operator-agent-id',
      expect.objectContaining({
        cwd: join(fixture.repoRoot, '.ensemble', 'operator-agents', 'smoke'),
        modelId: 'smoke-model',
        operatorPiMcpMode: 'direct',
        builtinTools: false,
        piExtensions: false,
        mcpServers: {
          'reconnect-server': { type: 'stdio', command: 'reconnect-mcp' },
        },
      }),
    );
    expect(resume).toHaveBeenNthCalledWith(
      2,
      'operator-agent-id',
      expect.objectContaining({
        cwd: join(fixture.repoRoot, '.ensemble', 'operator-agents', 'smoke'),
        modelId: 'smoke-model',
        operatorPiMcpMode: 'direct',
        builtinTools: false,
        piExtensions: false,
        mcpServers: {
          'reconnect-server': { type: 'stdio', command: 'reconnect-mcp' },
        },
      }),
    );
    expect(send).not.toHaveBeenCalled();
    expect(stdout.capturedText()).toContain('conductor に再接続しました。');
    expect(stdout.capturedText()).toContain('conductor の再接続に失敗しました。');
    expect(stdout.capturedText()).toContain('reconnect-server');
    expect(stdout.capturedText()).toContain('resume unavailable');
  });

  it('does not replay a failed operator-agent prompt after manual reconnect', async () => {
    const stdout = createOutput();
    const stderr = createOutput();
    const stdin = createInteractiveInput();
    stdin.isTTY = true;
    const prompt = 'check status after reconnect';
    const authFailure = {
      runId: 'run-auth',
      status: 'error',
      error: {
        code: 'auth',
        message:
          'API key auth failed for provider litellm: Failed to resolve API key for provider "litellm" from shell command: cached-auth.mjs',
      },
    };
    let retryOptions: ConductorAgentCreateOptions;
    const firstSend = vi.fn(async (message: string) => {
      retryOptions.onRetryEvent?.({ type: 'auto_retry_start', attempt: 1, maxAttempts: 1, delayMs: 10, errorMessage: 'auth failed' });
      retryOptions.onRetryEvent?.({ type: 'auto_retry_end', success: false, attempt: 1, finalError: 'auth failed' });
      expect(message).toContain(prompt);
      return authFailure;
    });
    const automaticRetrySend = vi.fn(async (message: string) => {
      expect(message).toContain(prompt);
      return authFailure;
    });
    const followup = 'continue only the unfinished work';
    const manualReconnectSend = vi.fn(async (message: string) => {
      expect(message).toContain(followup);
      expect(message).not.toContain(prompt);
      return {
        runId: 'run-followup',
        status: 'completed',
        result: 'Follow-up handled.',
      };
    });
    const resume = vi
      .fn()
      .mockResolvedValueOnce(createFakeAgent({ send: automaticRetrySend }))
      .mockResolvedValueOnce(createFakeAgent({ send: manualReconnectSend }));

    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin,
        stdout,
        stderr,
        agentFactory: {
          create: async (options) => { retryOptions = options; return createFakeAgent({ send: firstSend }); },
          resume,
        },
      },
    );

    await vi.waitFor(() =>
      expect(stdout.capturedText()).toContain('user>'),
    );
    stdin.write(`${prompt}\n`);
    await vi.waitFor(() => expect(stderr.capturedText()).toContain('[auth] Pi 認証エラー'));
    expect(stdout.capturedText()).toContain('[pi retry] failed');
    expect(stdout.capturedText()).toContain('[auth] conductor reconnect');
    expect(firstSend).toHaveBeenCalledOnce();
    expect(automaticRetrySend).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledOnce();
    expect(normalizeTtyText(stdout.capturedText())).toContain(
      'operator send が未完了です',
    );

    stdin.write('/reconnect\n');
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(2));
    expect(manualReconnectSend).not.toHaveBeenCalled();

    stdin.write('/recovery continue\n');
    stdin.write(`${followup}\n`);
    await vi.waitFor(() => expect(manualReconnectSend).toHaveBeenCalledOnce());

    stdin.write('/exit\n');
    await run;

    expect(firstSend).toHaveBeenCalledOnce();
    expect(automaticRetrySend).not.toHaveBeenCalled();
    expect(manualReconnectSend).toHaveBeenCalledOnce();
    expect(stderr.capturedText()).toContain('ensemble operator-agent');
  });

  it.each([false, true])('requires renewed selection between recoveries in the operator run loop (list=%s)', async (listFirst) => {
    const stdout = createOutput();
    const stderr = createOutput();
    const stdin = createInteractiveInput();
    stdin.isTTY = true;
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const send = vi.fn(async () => {
      if (send.mock.calls.length === 2) await secondGate;
      return {
        runId: 'failed', status: 'error' as const,
        error: { message: 'synthetic operator failure' },
      };
    });
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      { stdin, stdout, stderr, agentFactory: { create: async () => createFakeAgent({ send }) } },
    );
    try {
      await vi.waitFor(() => expect(stdout.capturedText()).toContain('user>'));
      stdin.write('first failure\n');
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(normalizeTtyText(stdout.capturedText())).toContain('operator send が未完了'));
      if (listFirst) {
        stdin.write('/recovery list\n');
        await vi.waitFor(() => expect(stdout.capturedText()).toContain('attempt 1 の結果確認後'));
      }
      stdin.write('/recovery continue\n');
      await vi.waitFor(() => expect(stdout.capturedText()).toContain('attempt 1 の確認'));
      stdin.write('/recovery continue\n');
      await vi.waitFor(() => expect(stdout.capturedText()).toContain('は確認できません'));
      stdin.write('second failure\n');
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      const whileSending = stdout.capturedText().length;
      stdin.write('/recovery continue 1\n');
      await vi.waitFor(() => expect(stdout.capturedText().slice(whileSending)).toContain('は確認できません'));
      releaseSecond();
      await vi.waitFor(() => expect(normalizeTtyText(stdout.capturedText()).match(/operator send が未完了/g)).toHaveLength(2));
      const before = stdout.capturedText().length;
      stdin.write('/recovery continue\n');
      await vi.waitFor(() => expect(stdout.capturedText().slice(before)).toContain('は確認できません'));
      stdin.write('/recovery continue 2\n');
      await vi.waitFor(() => expect(stdout.capturedText()).toContain('attempt 2 の確認'));
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      releaseSecond();
      stdin.write('/exit\n');
      stdin.end();
      await run;
    }
  });

  it('prints Pi auth recovery steps to stderr after reconnect when the send still fails', async () => {
    const projectDir = join(
      fixture.repoRoot,
      '.ensemble',
      'operator-agents',
      'smoke',
      'pi-project',
    );
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'litellm' }),
    );
    const stderr = createOutput();
    const authFailure = {
      runId: 'run-401',
      status: 'error',
      error: { message: 'litellm API error (401): Unauthorized' },
    };
    const agent = createFakeAgent({ send: async () => authFailure });
    const resume = vi.fn(async () => createFakeAgent({ send: async () => authFailure }));

    await runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: createInput('check status\n/exit\n'),
        stdout: createOutput(),
        stderr,
        agentFactory: { create: async () => agent, resume },
      },
    );

    expect(resume).toHaveBeenCalledOnce();
    expect(stderr.capturedText()).toContain('provider=litellm');
    expect(stderr.capturedText()).toContain(
      'ensemble auth login --provider litellm',
    );
    expect(stderr.capturedText()).toContain('LITELLM_API_KEY');
    expect(stderr.capturedText()).toContain('ensemble operator-agent');
    expect(stderr.capturedText()).not.toContain('ensemble issue');
  });

  it('resumes the sole global conversation after TTY termination and removes only its record on exit', async () => {
    const create = vi.fn(async () => createFakeAgent({ send: async () => ({
      runId: 'run-1',
      status: 'completed',
      result: 'Saved.',
    }) }));
    const resume = vi.fn(async () => createFakeAgent({ send: async () => ({
      runId: 'run-2',
      status: 'completed',
      result: 'Resumed.',
    }) }));
    const agentFactory: ConductorAgentFactory = { create, resume };

    await runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: createInput('hello\n'),
        stdout: createOutput(),
        agentFactory,
      },
    );
    const userRoot = join(fixture.repoRoot, '.ensemble');
    const [savedState] = await listOperatorAgentStates(userRoot);
    expect(savedState).toBeDefined();
    expect(savedState).toMatchObject({
      version: 2,
      operatorAgentId: expect.stringMatching(/^operator-/u),
      providerSessionId: 'operator-agent-id',
      backend: 'pi',
      profile: 'smoke',
      workspace: join(userRoot, 'operator-agents', 'smoke'),
    });

    await runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: createInput('hello again\nEXIT\n'),
        stdout: createOutput(),
        agentFactory,
      },
    );

    expect(create).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith(
      'operator-agent-id',
      expect.objectContaining({
        cwd: join(userRoot, 'operator-agents', 'smoke'),
      }),
    );
    await expect(listOperatorAgentStates(userRoot)).resolves.toEqual([]);
  });

  it('reports changed workspace and Pi resources, then preserves a record when backend resume fails', async () => {
    const userRoot = join(fixture.repoRoot, '.ensemble');
    const priorState: OperatorAgentState = {
      version: 2,
      operatorAgentId: 'operator-cannot-resume',
      providerSessionId: 'provider-cannot-resume',
      backend: 'pi',
      profile: 'smoke',
      workspace: '/previous/home/operator-agents/smoke',
      piResourceRoots: {
        agentDir: '/previous/home/pi',
        projectDir: '/previous/home/operator-agents/smoke/pi',
      },
      createdAt: 1,
      updatedAt: 2,
    };
    await saveOperatorAgentState(userRoot, priorState);
    const output = createOutput();
    const resume = vi.fn(async () => {
      throw new Error('provider session is unavailable');
    });

    await expect(
      runOperatorAgent(
        { resumeId: priorState.operatorAgentId },
        {
          stdin: createInput('/exit\n'),
          stdout: output,
          agentFactory: {
            create: async () => {
              throw new Error('not used');
            },
            resume,
          },
        },
      ),
    ).rejects.toThrow('provider session is unavailable');

    expect(resume).toHaveBeenCalledWith(
      priorState.providerSessionId,
      expect.objectContaining({
        cwd: join(userRoot, 'operator-agents', 'smoke'),
      }),
    );
    expect(output.capturedText()).toContain('workspace=');
    expect(output.capturedText()).toContain('Pi resource root');
    await expect(
      loadOperatorAgentState(userRoot, priorState.operatorAgentId),
    ).resolves.toEqual(priorState);
  });

  it('closes the agent and keeps its identity when the process receives SIGTERM', async () => {
    const previousExitCode = process.exitCode;
    const input = createInteractiveInput();
    input.isTTY = true;
    const output = createOutput();
    const agent = createFakeAgent({ send: async () => ({ runId: '', status: 'completed' }) });
    const close = vi.spyOn(agent, 'close');
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async () => agent,
          resume: async () => agent,
        },
      },
    );
    await new Promise<void>((resolve) => output.once('data', () => resolve()));

    process.emit('SIGTERM');
    try {
      await run;
      expect(process.exitCode).toBe(143);
    } finally {
      process.exitCode = previousExitCode;
    }

    expect(close).toHaveBeenCalledOnce();
    await expect(
      listOperatorAgentStates(join(fixture.repoRoot, '.ensemble')),
    ).resolves.toMatchObject([
      { providerSessionId: 'operator-agent-id' },
    ]);
  });

  it('starts a new global conversation without removing old conversation or transcript data', async () => {
    const userRoot = join(fixture.repoRoot, '.ensemble');
    const priorState: OperatorAgentState = {
      version: 2,
      operatorAgentId: 'operator-preserved',
      providerSessionId: 'provider-preserved',
      backend: 'pi',
      profile: 'smoke',
      workspace: join(userRoot, 'operator-agents', 'smoke'),
      piResourceRoots: {
        agentDir: join(userRoot, 'pi-user'),
        projectDir: join(userRoot, 'operator-agents', 'smoke', 'pi-project'),
      },
      createdAt: 1,
      updatedAt: 2,
    };
    await saveOperatorAgentState(userRoot, priorState);
    const oldTranscript = join(
      operatorPiSessionDirectory(userRoot, priorState.operatorAgentId),
      'transcript.jsonl',
    );
    await mkdir(dirname(oldTranscript), { recursive: true });
    await writeFile(oldTranscript, 'saved transcript');
    const legacyStatePath = join(
      fixture.repoRoot,
      '.ensemble',
      'operator-agent',
      'session.json',
    );
    await mkdir(dirname(legacyStatePath), { recursive: true });
    await writeFile(
      legacyStatePath,
      JSON.stringify({ version: 1, agentId: 'old-operator-agent-id' }),
    );
    const create = vi.fn(async () =>
      createFakeAgent({ send: async () => ({ runId: 'run-1', status: 'completed' }) }),
    );
    const resume = vi.fn();

    await runOperatorAgent(
      { repoRoot: fixture.repoRoot, newSession: true },
      {
        stdin: createInput('hello\n'),
        stdout: createOutput(),
        agentFactory: { create, resume },
      },
    );

    expect(create).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
    const states = await listOperatorAgentStates(userRoot);
    expect(states).toHaveLength(2);
    expect(states).toContainEqual(priorState);
    expect(states.find(({ operatorAgentId }) => operatorAgentId !== priorState.operatorAgentId))
      .toMatchObject({ providerSessionId: 'operator-agent-id' });
    await expect(readFile(oldTranscript, 'utf8')).resolves.toBe('saved transcript');
    await expect(readFile(legacyStatePath, 'utf8')).resolves.toContain(
      'old-operator-agent-id',
    );
  });

  it('adds the operator prompt to the first Cursor SDK turn', async () => {
    const input = createInput('hello\n/exit\n');
    const output = createOutput();
    await writeOperatorSettings(fixture.repoRoot, 'cursor');
    const workspace = join(fixture.repoRoot, '.ensemble', 'operator-agents', 'smoke');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'AGENTS.md'), 'Workspace first-turn guidance');
    const sentPrompts: string[] = [];
    let agentOptions: ConductorAgentCreateOptions | undefined;
    const fakeAgent = createFakeAgent({
      send: async (prompt) => {
        sentPrompts.push(prompt);
        return { runId: 'run-1', status: 'completed', result: 'Hello from operator.' };
      },
    });

    await runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async (options) => {
            agentOptions = options;
            return fakeAgent;
          },
          resume: async () => {
            throw new Error('not used');
          },
        },
      },
    );

    expect(sentPrompts).toHaveLength(1);
    expect(agentOptions).toMatchObject({
      cwd: join(fixture.repoRoot, '.ensemble', 'operator-agents', 'smoke'),
      modelId: 'cursor-model',
    });
    expect(agentOptions).not.toHaveProperty('pi');
    expect(sentPrompts[0]).toContain('agents-ensemble の operator ロール');
    expect(sentPrompts[0]).toContain('Workspace first-turn guidance');
    expect(sentPrompts[0]).toContain('## User message');
    expect(sentPrompts[0]).toContain('hello');
  });
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
