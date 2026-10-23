import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startOpenQuestionControlServer,
  type SessionObservationSnapshot,
} from '@agents-ensemble/core';
import type {
  ConductorAgent,
  ConductorAgentCreateOptions,
  ConductorAgentFactory,
  EnsembleConfig,
  ResolvedProfile,
} from '@agents-ensemble/core/operator-runtime';
import { loadEnsembleConfig } from '@agents-ensemble/core/operator-runtime';
import {
  runOperatorAgent,
  type OperatorAgentInput,
  type OperatorAgentOutput,
} from './run-operator-agent.js';
import { operatorWatchStatePath } from './operator-watch-pool.js';
import { operatorAgentStatePath } from './operator-agent-state.js';

describe('runOperatorAgent', () => {
  let repoRoot = '';
  let closeServers: Array<() => Promise<void>> = [];
  let originalModelEnv: string | undefined;
  let originalProfileEnv: string | undefined;
  let originalNoColorEnv: string | undefined;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-agent-'));
    vi.stubEnv('HOME', repoRoot);
    originalModelEnv = process.env.CONDUCTOR_MODEL_ID;
    originalProfileEnv = process.env.ENSEMBLE_DEFAULT_PROFILE;
    originalNoColorEnv = process.env.NO_COLOR;
    delete process.env.CONDUCTOR_MODEL_ID;
    delete process.env.ENSEMBLE_DEFAULT_PROFILE;
    delete process.env.NO_COLOR;
    await mkdir(join(repoRoot, '.ensemble', 'teams', 'smoke'), { recursive: true });
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    await writeFile(
      join(repoRoot, '.ensemble', 'config.yaml'),
      [
        'profile:',
        '  default: smoke',
        'conductor:',
        '  backend: pi',
        '  model: smoke-model',
        '  pi:',
        '    agentDir: .ensemble/pi-user',
        '    projectDir: .ensemble/pi-project',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(repoRoot, '.ensemble', 'teams', 'smoke', 'profile.yaml'),
      [
        'meta:',
        '  title: Operator smoke profile',
        'agents:',
        '  operator:',
        '    prompt:',
        '      instructions:',
        '        - Profile operator guidance.',
        'workers:',
        '  - name: implementer',
        '    kind: implementer',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(repoRoot, '.ensemble', 'sessions', 'conductor-one.json'),
      JSON.stringify({
        version: 1,
        conductorAgentId: 'conductor-one',
        conductorBackend: 'pi',
        issueUrl: 'https://github.com/example/project/issues/12',
        repoRoot,
        profile: { workers: [], agents: {} },
        openQuestions: [
          {
            id: 'inq-1',
            question: 'Approve this operation?',
            responseType: 'yes_no',
            source: 'conductor',
            status: 'open',
            askedAt: 1,
            relatedPermissionId: 'permission-1',
          },
        ],
        sequence: 1,
        workers: { implementer: { acpSessionId: 'worker-one' } },
        updatedAt: 100,
      }),
    );
  });

  afterEach(async () => {
    for (const close of closeServers) await close();
    closeServers = [];
    if (originalModelEnv === undefined) {
      delete process.env.CONDUCTOR_MODEL_ID;
    } else {
      process.env.CONDUCTOR_MODEL_ID = originalModelEnv;
    }
    if (originalProfileEnv === undefined) {
      delete process.env.ENSEMBLE_DEFAULT_PROFILE;
    } else {
      process.env.ENSEMBLE_DEFAULT_PROFILE = originalProfileEnv;
    }
    if (originalNoColorEnv === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColorEnv;
    }
    await rm(repoRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('requires both terminal streams before loading config or starting an agent', async () => {
    const loadConfig = vi.fn();
    const input = createInput('hello\n', false);
    const output = createOutput(false);

    await expect(
      runOperatorAgent(
        { repoRoot },
        { stdin: input, stdout: output, loadConfig },
      ),
    ).rejects.toThrow('requires an interactive TTY');
    expect(loadConfig).not.toHaveBeenCalled();
    expect(output.capturedText()).not.toContain('\u001b[');
  });

  it('loads an explicitly selected config file', async () => {
    const userEnsembleRoot = join(repoRoot, '.test-user-ensemble');
    await mkdir(userEnsembleRoot, { recursive: true });
    await writeFile(
      join(userEnsembleRoot, 'config.yaml'),
      [
        'config:',
        '  loadProjectConfig: false',
        'conductor:',
        '  model: standard-user-model',
        'github:',
        '  auth:',
        '    allowGhAuthTokenFallback: false',
        'acp:',
        '  env:',
        '    USER_ONLY: user',
        '',
      ].join('\n'),
    );
    const configPath = join(repoRoot, 'alternate.config.yaml');
    await writeFile(
      configPath,
      [
        'conductor:',
        '  model: alternate-model',
        'tui:',
        '  layout: pane',
        '',
      ].join('\n'),
    );
    let loadedConfig: EnsembleConfig | undefined;
    let agentOptions: ConductorAgentCreateOptions | undefined;
    const fakeAgent = createFakeAgent({
      send: async () => ({
        runId: 'unused',
        status: 'completed',
        result: '',
      }),
    });
    const agentFactory: ConductorAgentFactory = {
      create: async (options) => {
        agentOptions = options;
        return fakeAgent;
      },
      resume: async (_agentId, options) => {
        agentOptions = options;
        return fakeAgent;
      },
    };

    await runOperatorAgent(
      { repoRoot, configPath, newSession: true },
      {
        stdin: createInput('/exit\n'),
        stdout: createOutput(),
        agentFactory,
        loadConfig: async (root, options) => {
          loadedConfig = await loadEnsembleConfig(root, {
            ...options,
            userEnsembleRoot,
          });
          return loadedConfig;
        },
      },
    );

    expect(loadedConfig).toMatchObject({
      conductor: { model: 'smoke-model', backend: 'pi' },
      github: { auth: { allowGhAuthTokenFallback: true } },
      tui: { layout: 'pane' },
    });
    expect(loadedConfig?.acp.env ?? {}).not.toHaveProperty('USER_ONLY');
    expect(agentOptions?.modelId).toBe('smoke-model');
    expect(agentOptions?.pi?.agentDir).toBe(join(repoRoot, '.ensemble/pi-user'));
  });

  it('runs a Pi-backed TTY conversation with profile prompt and saved session summaries', async () => {
    const input = createInput('状況を教えて\n/exit\n');
    const output = createOutput();
    let agentOptions: ConductorAgentCreateOptions | undefined;
    const sentPrompts: string[] = [];
    const fakeAgent = createFakeAgent({
      send: async (prompt) => {
        sentPrompts.push(prompt);
        const tool = agentOptions?.customTools?.list_operator_sessions;
        expect(tool).toBeDefined();
        const toolResult = await tool!.execute({ limit: 1 });
        expect(toolResult.content[0]?.text).toContain(
          'https://github.com/example/project/issues/12',
        );
        expect(toolResult.content[0]?.text).toContain('permission-1');
        return {
          runId: 'run-1',
          status: 'completed',
          result:
            '保存済み SessionResumeStore から implementer のセッション情報を確認できます。\n\n\n\nライブ open question も確認できます。',
        };
      },
    });
    const agentFactory: ConductorAgentFactory = {
      create: async (options) => {
        agentOptions = options;
        return fakeAgent;
      },
      resume: async () => fakeAgent,
    };

    await runOperatorAgent({ repoRoot }, { stdin: input, stdout: output, agentFactory });

    const transcript = output.capturedText();
    expect(sentPrompts).toEqual(['状況を教えて']);
    expect(transcript).toContain(
      '\u001b[2moperator-agent\u001b[0m (pi) ready — enter /exit to start a fresh session next time.\n\n',
    );
    expect(transcript).toContain('\u001b[2muser>\u001b[0m');
    expect(transcript).toContain(
      '\u001b[36moperator>\u001b[0m\n保存済み SessionResumeStore から implementer のセッション情報を確認できます。\n\nライブ open question も確認できます。\n\n',
    );
    expect(transcript).toContain('会話 hold を解除しました');
    expect(transcript).toContain(
      '\u001b[2moperator-agent\u001b[0m session ended.\n\n',
    );
    expect(agentOptions).toMatchObject({
      cwd: repoRoot,
      modelId: 'smoke-model',
      builtinTools: false,
      pi: {
        agentDir: join(repoRoot, '.ensemble', 'pi-user'),
        projectDir: join(repoRoot, '.ensemble', 'pi-project'),
      },
      piExtensions: false,
    });
    expect(agentOptions?.systemPrompt).toContain('operator ロール');
    expect(agentOptions?.systemPrompt).toContain('Profile operator guidance.');
    expect(agentOptions?.systemPrompt).toContain('answer_live_open_question');
    expect(agentOptions?.systemPrompt).toContain('自動解決はしません');
    expect(agentOptions?.systemPrompt).toContain('get_last_conductor_message');
    expect(agentOptions?.systemPrompt).toContain('list_conductor_messages');
    expect(agentOptions?.systemPrompt).toContain('register_conductor_message_listen');
    expect(agentOptions?.customTools).not.toHaveProperty('prompt_worker');
    expect(
      Object.keys(agentOptions?.customTools ?? {}).filter(
        (toolName) => toolName === 'send_operator_message',
      ),
    ).toHaveLength(1);
    expect(Object.keys(agentOptions?.customTools ?? {})).toEqual([
      'list_operator_sessions',
      'list_live_open_questions',
      'answer_live_open_question',
      'get_last_conductor_message',
      'list_conductor_messages',
      'register_session_watch',
      'unregister_session_watch',
      'register_conductor_message_listen',
      'unregister_conductor_message_listen',
      'set_report_hold',
      'release_reports',
      'send_operator_message',
    ]);
    await expect(
      readFile(operatorAgentStatePath(repoRoot)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the conversation hold through consecutive user turns', async () => {
    const input = new PassThrough() as PassThrough & OperatorAgentInput;
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
      { repoRoot },
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
      expect(output.capturedText()).toContain('\u001b[2muser>\u001b[0m '),
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
    expect(output.capturedText()).toContain('監視報告保留中（会話・手動 / 0 件）');
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
    closeServers.push(() => liveServer.close());

    const resumeStorePath = join(
      repoRoot,
      '.ensemble',
      'sessions',
      'conductor-one.json',
    );
    const resumeStore = JSON.parse(await readFile(resumeStorePath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      resumeStorePath,
      JSON.stringify({ ...resumeStore, harnessSocketPath: liveServer.socketPath }),
    );

    const input = new PassThrough() as PassThrough & OperatorAgentInput;
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
    const fakeAgent = createFakeAgent({
      send: async (prompt) => {
        sentPrompts.push(prompt);
        if (sentPrompts.length === 1) {
          await agentOptions!.customTools!.register_session_watch!.execute({
            conductorAgentId: 'conductor-one',
            pollIntervalMs: 250,
            debounceMs: 0,
          });
          userTurnStarted();
          await userTurnGate;
        } else {
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
      { repoRoot },
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
        expect(output.capturedText()).toContain('\u001b[2muser>\u001b[0m '),
      );
      input.write('summarize the live update\n');
      await userStarted;
      await vi.waitFor(async () => {
        const state = JSON.parse(
          await readFile(operatorWatchStatePath(repoRoot), 'utf8'),
        ) as {
          cursors: Record<string, { sequence: number }>;
        };
        expect(state.cursors['conductor-one']?.sequence).toBe(0);
      });

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
      await vi.waitFor(async () => {
        const state = JSON.parse(
          await readFile(operatorWatchStatePath(repoRoot), 'utf8'),
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
      });

      expect(sentPrompts).toHaveLength(1);
      expect(sentPrompts[0]).toBe('summarize the live update');

      finishUserTurn();
      await reportStarted;
      expect(sentPrompts).toHaveLength(2);
      expect(sentPrompts[1]).toContain(
        'Should the operator review this live report?',
      );
      expect(output.capturedText()).toContain(
        '会話 hold を解除しました（手動 hold: 解除、保留報告 1 件を dispatch queue に戻しました）。',
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
    closeServers.push(() => liveServer.close());

    const resumeStorePath = join(
      repoRoot,
      '.ensemble',
      'sessions',
      'conductor-one.json',
    );
    const resumeStore = JSON.parse(await readFile(resumeStorePath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      resumeStorePath,
      JSON.stringify({ ...resumeStore, harnessSocketPath: liveServer.socketPath }),
    );

    const input = new PassThrough() as PassThrough & OperatorAgentInput;
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
      { repoRoot },
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
        expect(output.capturedText()).toContain('\u001b[2muser>\u001b[0m '),
      );
      input.write('start the discussion\n');
      await firstStarted;
      await vi.waitFor(async () => {
        const state = JSON.parse(
          await readFile(operatorWatchStatePath(repoRoot), 'utf8'),
        ) as {
          cursors: Record<string, { sequence: number }>;
        };
        expect(state.cursors['conductor-one']?.sequence).toBe(0);
      });
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
      await vi.waitFor(async () => {
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
      });

      input.write('/resume-watch\n');
      await vi.waitFor(() =>
        expect(output.capturedText()).toContain(
          '会話 hold を解除しました（手動 hold: 継続、監視保留: 1 件、dispatch queue に戻した報告: 0 件）。',
        ),
      );
      expect(sentPrompts).toHaveLength(1);
      finishFirstTurn();
      await vi.waitFor(() =>
        expect(output.capturedText()).toContain('監視報告保留中（手動 / 1 件）'),
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
    expect(output.capturedText()).toContain('監視報告保留中（手動 / 1 件）');
  });

  it('polls an offline watched session and refreshes the held-report count in the TTY', async () => {
    const input = new PassThrough() as PassThrough & OperatorAgentInput;
    input.isTTY = true;
    const output = createOutput();
    let agentOptions: ConductorAgentCreateOptions | undefined;
    const fakeAgent = createFakeAgent({
      send: async () => {
        await agentOptions!.customTools!.set_report_hold!.execute({ hold: true });
        await agentOptions!.customTools!.register_session_watch!.execute({
          conductorAgentId: 'conductor-one',
          pollIntervalMs: 250,
          debounceMs: 0,
        });
        setTimeout(() => {
          void (async () => {
            const sessionDir = join(
              repoRoot,
              '.ensemble',
              'sessions',
              'conductor-one',
            );
            await mkdir(sessionDir, { recursive: true });
            await writeFile(
              join(sessionDir, 'open-questions.yaml'),
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
          })();
        }, 350);
        return { runId: 'run-1', status: 'completed', result: 'watch started' };
      },
    });
    const run = runOperatorAgent(
      { repoRoot },
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
      expect(output.capturedText()).toContain('\u001b[2muser>\u001b[0m '),
    );
    input.write('監視を開始\n');
    setTimeout(() => input.write('/exit\n'), 750);
    await run;

    expect(output.capturedText()).toContain('監視報告保留中（手動 / 1 件）');
  });

  it('sends multiple same-source watch reports in one operator-agent dispatch', async () => {
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
    closeServers.push(() => liveServer.close());

    const resumeStorePath = join(
      repoRoot,
      '.ensemble',
      'sessions',
      'conductor-one.json',
    );
    const resumeStore = JSON.parse(await readFile(resumeStorePath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      resumeStorePath,
      JSON.stringify({ ...resumeStore, harnessSocketPath: liveServer.socketPath }),
    );

    const input = new PassThrough() as PassThrough & OperatorAgentInput;
    input.isTTY = true;
    const output = createOutput();
    let agentOptions: ConductorAgentCreateOptions | undefined;
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
          setTimeout(() => {
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
            };
          }, 350);
        }
        return {
          runId: `run-${sentPrompts.length}`,
          status: 'completed',
          result: 'received',
        };
      },
    });
    const run = runOperatorAgent(
      { repoRoot },
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
        expect(output.capturedText()).toContain('\u001b[2muser>\u001b[0m '),
      );
      input.write('start watching\n');
      await vi.waitFor(() => expect(sentPrompts).toHaveLength(2));
      input.write('/exit\n');
      await run;
    } finally {
      input.end();
    }

    expect(sentPrompts).toHaveLength(2);
    expect(sentPrompts[1]).toContain('## Open Question 追加（2 件）');
    expect(sentPrompts[1]).toContain('Review the implementation?');
    expect(sentPrompts[1]).toContain('Confirm the test result?');
  });

  it('retains a cancelled watch report across restart and acknowledges it only after a completed retry', async () => {
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
    closeServers.push(() => liveServer.close());

    const resumeStorePath = join(
      repoRoot,
      '.ensemble',
      'sessions',
      'conductor-one.json',
    );
    const resumeStore = JSON.parse(await readFile(resumeStorePath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      resumeStorePath,
      JSON.stringify({ ...resumeStore, harnessSocketPath: liveServer.socketPath }),
    );

    const statePath = operatorWatchStatePath(repoRoot);
    const firstInput = new PassThrough() as PassThrough & OperatorAgentInput;
    firstInput.isTTY = true;
    const firstOutput = createOutput();
    let firstAgentOptions: ConductorAgentCreateOptions | undefined;
    const firstPrompts: string[] = [];
    const firstAgent = createFakeAgent({
      send: async (prompt) => {
        firstPrompts.push(prompt);
        if (firstPrompts.length === 1) {
          await firstAgentOptions!.customTools!.register_session_watch!.execute({
            conductorAgentId: 'conductor-one',
            pollIntervalMs: 250,
            debounceMs: 0,
          });
          setTimeout(() => {
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
          }, 350);
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
      { repoRoot },
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

    await vi.waitFor(() =>
      expect(firstOutput.capturedText()).toContain('\u001b[2muser>\u001b[0m '),
    );
    firstInput.write('watch this session\n');
    await vi.waitFor(() => expect(firstPrompts).toHaveLength(2));
    firstInput.end();
    await firstRun;

    const afterCancelledSend = JSON.parse(
      await readFile(statePath, 'utf8'),
    ) as { pendingReports: Array<{ reportId: string }> };
    expect(afterCancelledSend.pendingReports).toHaveLength(1);
    expect(firstOutput.capturedText()).toContain(
      'status=cancelled; watched reports retained for retry.',
    );

    const retryInput = new PassThrough() as PassThrough & OperatorAgentInput;
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
    const retryRun = runOperatorAgent(
      { repoRoot },
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

    await vi.waitFor(() => expect(retryPrompts).toHaveLength(1));
    expect(retryPrompts[0]).toContain('Should this report be retried?');
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(statePath, 'utf8')) as {
        pendingReports: Array<{ reportId: string }>;
      };
      expect(saved.pendingReports).toHaveLength(0);
    });
    retryInput.write('/exit\n');
    await retryRun;
  });

  it('keeps the TTY transcript free of ANSI escapes when NO_COLOR is set', async () => {
    process.env.NO_COLOR = '1';
    const output = createOutput();

    await runOperatorAgent(
      { repoRoot },
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
    expect(transcript).not.toContain('\u001b[');
    expect(transcript).toContain('user> ');
    expect(transcript).toContain('operator>\nPlain response.\n\n');
    expect(transcript).toContain('operator-agent session ended.\n\n');
  });

  it('gives error rows matching spacing and a colored error label', async () => {
    const output = createOutput();

    await runOperatorAgent(
      { repoRoot },
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

    expect(output.capturedText()).toContain(
      '\n\u001b[31moperator-agent error:\u001b[0m Request failed.\n\n',
    );
  });

  it('resumes the default session after ordinary TTY termination and lets exit clear it', async () => {
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
      { repoRoot },
      {
        stdin: createInput('hello\n'),
        stdout: createOutput(),
        agentFactory,
      },
    );
    const statePath = operatorAgentStatePath(repoRoot);
    const savedState = JSON.parse(await readFile(statePath, 'utf8')) as {
      version: number;
      agentId: string;
      backend: string;
      repoRoot: string;
    };
    expect(savedState).toMatchObject({
      version: 1,
      agentId: 'operator-agent-id',
      backend: 'pi',
      repoRoot,
    });

    await runOperatorAgent(
      { repoRoot },
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
      expect.objectContaining({ cwd: repoRoot }),
    );
    await expect(readFile(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('closes the agent and keeps its identity when the process receives SIGTERM', async () => {
    const previousExitCode = process.exitCode;
    const input = new PassThrough() as PassThrough & OperatorAgentInput;
    input.isTTY = true;
    const output = createOutput();
    const agent = createFakeAgent({ send: async () => ({ runId: '', status: 'completed' }) });
    const close = vi.spyOn(agent, 'close');
    const run = runOperatorAgent(
      { repoRoot },
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
      readFile(operatorAgentStatePath(repoRoot), 'utf8'),
    ).resolves.toContain('operator-agent-id');
  });

  it('starts fresh with --new and replaces the saved session identity', async () => {
    const statePath = operatorAgentStatePath(repoRoot);
    const legacyStatePath = join(
      repoRoot,
      '.ensemble',
      'operator-agent',
      'session.json',
    );
    await mkdir(dirname(legacyStatePath), { recursive: true });
    await writeFile(
      legacyStatePath,
      JSON.stringify({
        version: 1,
        agentId: 'old-operator-agent-id',
        backend: 'pi',
        repoRoot,
      }),
    );
    const create = vi.fn(async () =>
      createFakeAgent({ send: async () => ({ runId: 'run-1', status: 'completed' }) }),
    );
    const resume = vi.fn();

    await runOperatorAgent(
      { repoRoot, newSession: true },
      {
        stdin: createInput('hello\n'),
        stdout: createOutput(),
        agentFactory: { create, resume },
      },
    );

    expect(create).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
    await expect(readFile(statePath, 'utf8')).resolves.toContain(
      'operator-agent-id',
    );
    await expect(readFile(legacyStatePath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('adds the operator prompt to the first Cursor SDK turn', async () => {
    const input = createInput('hello\n/exit\n');
    const output = createOutput();
    const config: EnsembleConfig = {
      profile: { default: 'unused' },
      conductor: { backend: 'cursor', model: 'cursor-model' },
    } as EnsembleConfig;
    const profile: ResolvedProfile = {
      workers: [],
      agents: {},
    };
    const sentPrompts: string[] = [];
    const fakeAgent = createFakeAgent({
      send: async (prompt) => {
        sentPrompts.push(prompt);
        return { runId: 'run-1', status: 'completed', result: 'Hello from operator.' };
      },
    });

    await runOperatorAgent(
      { repoRoot },
      {
        stdin: input,
        stdout: output,
        loadConfig: async () => config,
        loadProfile: async () => ({ profile, profilePath: 'test-profile' }),
        agentFactory: {
          create: async () => fakeAgent,
          resume: async () => {
            throw new Error('not used');
          },
        },
      },
    );

    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain('agents-ensemble の operator ロール');
    expect(sentPrompts[0]).toContain('## User message');
    expect(sentPrompts[0]).toContain('hello');
  });
});

function createInput(
  text: string,
  isTTY = true,
): OperatorAgentInput {
  const input = new PassThrough() as PassThrough & OperatorAgentInput;
  input.isTTY = isTTY;
  input.end(text);
  return input;
}

function createOutput(
  isTTY = true,
): OperatorAgentOutput & { capturedText: () => string } {
  const output = new PassThrough() as PassThrough &
    OperatorAgentOutput & { capturedText: () => string };
  const chunks: string[] = [];
  output.on('data', (chunk) => chunks.push(String(chunk)));
  output.capturedText = () => chunks.join('');
  output.isTTY = isTTY;
  return output;
}

function createFakeAgent(overrides: {
  send: ConductorAgent['send'];
}): ConductorAgent {
  return {
    agentId: 'operator-agent-id',
    send: overrides.send,
    reload: async () => {},
    getUsage: async () => ({}),
    setSystemPrompt: async () => {},
    close: async () => {},
  };
}
