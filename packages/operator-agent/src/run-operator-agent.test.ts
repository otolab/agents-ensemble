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
  let originalReasoningEnv: string | undefined;
  let originalProfileEnv: string | undefined;
  let originalNoColorEnv: string | undefined;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-agent-'));
    vi.stubEnv('HOME', repoRoot);
    originalModelEnv = process.env.CONDUCTOR_MODEL_ID;
    originalReasoningEnv = process.env.CONDUCTOR_REASONING;
    originalProfileEnv = process.env.ENSEMBLE_DEFAULT_PROFILE;
    originalNoColorEnv = process.env.NO_COLOR;
    delete process.env.CONDUCTOR_MODEL_ID;
    delete process.env.CONDUCTOR_REASONING;
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
    if (originalReasoningEnv === undefined) {
      delete process.env.CONDUCTOR_REASONING;
    } else {
      process.env.CONDUCTOR_REASONING = originalReasoningEnv;
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

  it.each([
    {
      backend: 'pi' as const,
      configReasoning: 'high',
      envReasoning: undefined,
      expectedReasoning: 'high',
    },
    {
      backend: 'cursor' as const,
      configReasoning: 'low',
      envReasoning: 'high',
      expectedReasoning: 'high',
    },
  ])(
    'resolves config / environment reasoning for $backend before agent creation',
    async ({ backend, configReasoning, envReasoning, expectedReasoning }) => {
      await writeFile(
        join(repoRoot, '.ensemble', 'config.yaml'),
        [
          'conductor:',
          `  backend: ${backend}`,
          `  model: ${backend === 'pi' ? 'smoke-model' : 'cursor-model'}`,
          `  reasoning: ${configReasoning}`,
          '',
        ].join('\n'),
      );
      if (envReasoning === undefined) {
        delete process.env.CONDUCTOR_REASONING;
      } else {
        process.env.CONDUCTOR_REASONING = envReasoning;
      }

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
        resume: async () => {
          throw new Error('not used');
        },
      };

      await runOperatorAgent(
        { repoRoot, newSession: true },
        {
          stdin: createInput('/exit\n'),
          stdout: createOutput(),
          agentFactory,
        },
      );

      expect(agentOptions).toMatchObject({
        modelId: backend === 'pi' ? 'smoke-model' : 'cursor-model',
        reasoning: expectedReasoning,
      });
      if (backend === 'pi') {
        expect(agentOptions?.pi).toBeDefined();
      } else {
        expect(agentOptions).not.toHaveProperty('pi');
      }
    },
  );

  it.each([
    {
      backend: 'pi' as const,
      configReasoning: 'low',
      envReasoning: 'medium',
      expectedReasoning: 'medium',
    },
    {
      backend: 'cursor' as const,
      configReasoning: 'high',
      envReasoning: undefined,
      expectedReasoning: 'high',
    },
  ])(
    'passes the resolved $backend reasoning to the resume factory',
    async ({ backend, configReasoning, envReasoning, expectedReasoning }) => {
      await writeFile(
        join(repoRoot, '.ensemble', 'config.yaml'),
        [
          'conductor:',
          `  backend: ${backend}`,
          `  model: ${backend === 'pi' ? 'smoke-model' : 'cursor-model'}`,
          `  reasoning: ${configReasoning}`,
          '',
        ].join('\n'),
      );
      if (envReasoning !== undefined) {
        process.env.CONDUCTOR_REASONING = envReasoning;
      }
      const statePath = operatorAgentStatePath(repoRoot);
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(
        statePath,
        JSON.stringify({
          version: 1,
          agentId: 'saved-operator-agent',
          backend,
          repoRoot,
        }),
      );

      let resumedOptions: ConductorAgentCreateOptions | undefined;
      const fakeAgent = createFakeAgent({
        send: async () => ({
          runId: 'unused',
          status: 'completed',
          result: '',
        }),
      });
      const agentFactory: ConductorAgentFactory = {
        create: async () => {
          throw new Error('saved operator-agent state should resume');
        },
        resume: async (_agentId, options) => {
          resumedOptions = options;
          return fakeAgent;
        },
      };

      await runOperatorAgent(
        { repoRoot },
        {
          stdin: createInput('/exit\n'),
          stdout: createOutput(),
          agentFactory,
        },
      );

      expect(resumedOptions).toMatchObject({
        modelId: backend === 'pi' ? 'smoke-model' : 'cursor-model',
        reasoning: expectedReasoning,
      });
    },
  );

  it.each(['pi', 'cursor'] as const)(
    'leaves %s reasoning unset when config and environment omit it',
    async (backend) => {
      await writeFile(
        join(repoRoot, '.ensemble', 'config.yaml'),
        [
          'conductor:',
          `  backend: ${backend}`,
          `  model: ${backend === 'pi' ? 'smoke-model' : 'cursor-model'}`,
          '',
        ].join('\n'),
      );
      let agentOptions: ConductorAgentCreateOptions | undefined;
      const fakeAgent = createFakeAgent({
        send: async () => ({
          runId: 'unused',
          status: 'completed',
          result: '',
        }),
      });

      await runOperatorAgent(
        { repoRoot, newSession: true },
        {
          stdin: createInput('/exit\n'),
          stdout: createOutput(),
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

      expect(agentOptions).not.toHaveProperty('reasoning');
    },
  );

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
      '\u001b[2m[observation]\u001b[0m (pi) ready — enter /exit to start a fresh session next time.',
    );
    expect(transcript).toContain('\u001b[2muser>\u001b[0m');
    expect(transcript).toContain(
      '\u001b[36moperator>\u001b[0m\n保存済み SessionResumeStore から implementer のセッション情報を確認できます。\n\nライブ open question も確認できます。\n\n',
    );
    expect(transcript).toContain(
      '\u001b[2m[harness]\u001b[0m 監視報告: 保留（理由: 会話、保留件数: 0 件）',
    );
    expect(transcript).toContain(
      '\u001b[2m[harness]\u001b[0m 監視報告: 解除（理由: なし、保留件数: 0 件）',
    );
    expect(transcript).toContain(
      '\u001b[2m[observation]\u001b[0m session ended.',
    );
    expect(transcript).not.toMatch(/(?:^|\n)> /);
    expect(transcript).not.toContain('operator-agent 会話 hold');
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
    expect(agentOptions).not.toHaveProperty('reasoning');
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

  it('shows send and tool activity while preserving the TTY prompt', async () => {
    const input = new PassThrough() as PassThrough & OperatorAgentInput;
    input.isTTY = true;
    const output = createOutput();
    let finishSend:
      | ((result: Awaited<ReturnType<ConductorAgent['send']>>) => void)
      | undefined;
    const fakeAgent = createFakeAgent({
      send: async (_prompt, callbacks) => {
        callbacks?.onToolCallStarted?.({
          runId: 'run-1',
          tool: 'list_operator_sessions',
          callId: 'call-1',
        });
        return await new Promise<
          Awaited<ReturnType<ConductorAgent['send']>>
        >((resolve) => {
          finishSend = resolve;
        });
      },
    });
    const run = runOperatorAgent(
      { repoRoot },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async () => fakeAgent,
          resume: async () => fakeAgent,
        },
      },
    );

    input.write('hello\n');
    await vi.waitFor(() => expect(finishSend).toBeTypeOf('function'));

    const pendingTranscript = output.capturedText();
    expect(pendingTranscript).toContain(
      '\u001b[2m[harness]\u001b[0m operator: 処理中',
    );
    expect(pendingTranscript).toContain(
      '\u001b[2m[harness]\u001b[0m operator: calling list_operator_sessions',
    );
    expect(pendingTranscript.lastIndexOf('user>')).toBeGreaterThan(
      pendingTranscript.indexOf('operator: calling list_operator_sessions'),
    );
    expect(pendingTranscript).not.toContain('operator>\n');

    finishSend!({
      runId: 'run-1',
      status: 'completed',
      result: 'Done.',
    });
    await vi.waitFor(() => {
      const transcript = output.capturedText();
      const responseLabel = transcript.indexOf('\u001b[36moperator>\u001b[0m');
      const responseBody = transcript.indexOf('Done.');
      expect(responseLabel).toBeGreaterThan(-1);
      expect(responseBody).toBeGreaterThan(responseLabel);
    });
    input.write('/exit\n');
    input.end();
    await run;
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

    expect(output.capturedText()).toContain(
      '監視報告: 保留（理由: 手動、保留件数: 1 件）',
    );
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
      'send not completed (status=cancelled); watched reports retained for retry.',
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
    expect(transcript).not.toMatch(/\u001b\[(?:2|31|36)m/);
    expect(transcript).toContain('user> ');
    expect(transcript).toContain('[harness] operator: 処理中');
    expect(transcript).not.toMatch(/(?:^|\n)> /);
    expect(transcript).toContain('operator>\nPlain response.\n\n');
    expect(transcript).toContain('[observation] session ended.');
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
      '\u001b[31m[harness]\u001b[0m Request failed.',
    );
  });

  it('escapes backend status controls in operator-agent failure notices', async () => {
    const input = new PassThrough() as PassThrough & OperatorAgentInput;
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
      { repoRoot },
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
        expect(stdout.capturedText()).toContain('\u001b[2muser>\u001b[0m '),
      );
      input.write('inspect current state\n');
      await vi.waitFor(() => {
        const output = stdout.capturedText();
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
        ...stdout
          .capturedText()
          .matchAll(
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
    const input = new PassThrough() as PassThrough & OperatorAgentInput;
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
      { repoRoot },
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
        expect(stdout.capturedText()).toContain('\u001b[2muser>\u001b[0m '),
      );
      input.write(`${authoredInput}\n`);
      await vi.waitFor(() => {
        expect(resume).toHaveBeenCalledOnce();
        expect(stdout.capturedText()).toContain(
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
      await run;
      exited = true;
    } finally {
      if (!exited) input.write('/exit\n');
      input.end();
      await run.catch(() => {});
    }
  });

  it('does not close the old conductor again when finalization follows failed resume', async () => {
    const input = new PassThrough() as PassThrough & OperatorAgentInput;
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
      { repoRoot },
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
      expect(stdout.capturedText()).toContain(
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
    const resumeStore = JSON.parse(
      await readFile(resumeStorePath, 'utf8'),
    ) as Record<string, unknown>;
    await writeFile(
      resumeStorePath,
      JSON.stringify({ ...resumeStore, harnessSocketPath: liveServer.socketPath }),
    );

    const input = new PassThrough() as PassThrough & OperatorAgentInput;
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
    const firstSend = vi.fn(async (prompt: string) => {
      sentPrompts.push(prompt);
      await agentOptions!.customTools!.register_session_watch!.execute({
        conductorAgentId: 'conductor-one',
        pollIntervalMs: 250,
        debounceMs: 0,
      });
      setTimeout(() => {
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
      }, 350);
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
      { repoRoot },
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
        expect(stdout.capturedText()).toContain('\u001b[2muser>\u001b[0m '),
      );
      input.write(`${failedInput}\n`);
      await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
      expect(firstSend).toHaveBeenCalledOnce();
      expect(sentPrompts[0]).toContain(failedInput);
      expect(resumedSend).not.toHaveBeenCalled();

      input.write(`${followupInput}\n`);
      const watchStatePath = operatorWatchStatePath(repoRoot);
      await vi.waitFor(async () => {
        const saved = JSON.parse(
          await readFile(watchStatePath, 'utf8'),
        ) as { pendingReports: Array<{ reportId: string }> };
        expect(saved.pendingReports).toHaveLength(1);
      });
      expect(firstSend).toHaveBeenCalledOnce();
      expect(resumedSend).not.toHaveBeenCalled();
      rejectAutomaticResume(new Error('automatic resume unavailable'));
      await vi.waitFor(() =>
        expect(stdout.capturedText()).toContain(
          'operator send が未完了です (status=error, failure=auth)',
        ),
      );

      input.write('/reconnect\n');
      await vi.waitFor(() => {
        expect(resume).toHaveBeenCalledTimes(2);
        expect(stdout.capturedText()).toContain(
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

      input.write('/recovery continue\n');
      await vi.waitFor(() => expect(resumedSend).toHaveBeenCalledTimes(2));
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
      await vi.waitFor(async () => {
        const saved = JSON.parse(
          await readFile(watchStatePath, 'utf8'),
        ) as { pendingReports: Array<{ reportId: string }> };
        expect(saved.pendingReports).toHaveLength(0);
      });

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
    const input = new PassThrough() as PassThrough & OperatorAgentInput;
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
      { repoRoot },
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
        expect(stdout.capturedText()).toContain('\u001b[2muser>\u001b[0m '),
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

  it('treats a rejected send as unknown until reconnect and explicit confirmation', async () => {
    const input = new PassThrough() as PassThrough & OperatorAgentInput;
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
    const authoredInput = 'possibly completed task';
    const followupInput = 'inspect current state and continue unfinished work';
    const rawError = 'ambiguous provider rejection with secret-token';
    const rejectedSend = vi
      .fn()
      .mockRejectedValue(new Error(rawError));
    const followupSend = vi.fn(async (message: string) => {
      expect(message).toContain(followupInput);
      expect(message).not.toContain(authoredInput);
      return {
        runId: 'run-followup',
        status: 'completed',
        result: 'Follow-up handled.',
      };
    });
    const resume = vi.fn(async () =>
      createFakeAgent({ send: followupSend }),
    );

    const run = runOperatorAgent(
      { repoRoot },
      {
        stdin: input,
        stdout,
        stderr,
        loadConfig: async () => config,
        loadProfile: async () => ({ profile, profilePath: 'test-profile' }),
        agentFactory: {
          create: async () => createFakeAgent({ send: rejectedSend }),
          resume,
        },
      },
    );

    let exited = false;
    try {
      await vi.waitFor(() =>
        expect(stdout.capturedText()).toContain('\u001b[2muser>\u001b[0m '),
      );
      input.write(`${authoredInput}\n`);
      await vi.waitFor(() => {
        expect(stdout.capturedText()).toContain(
          'operator send が未完了です (status=send_rejected, failure=send_rejected)',
        );
        expect(stdout.capturedText()).toContain(
          '明示的に /reconnect するまで conductor への送信を停止します。',
        );
      });

      expect(rejectedSend).toHaveBeenCalledOnce();
      expect(resume).not.toHaveBeenCalled();
      expect(stdout.capturedText()).not.toContain(rawError);
      expect(stderr.capturedText()).not.toContain(rawError);

      input.write(`${followupInput}\n`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(followupSend).not.toHaveBeenCalled();

      input.write('/reconnect\n');
      await vi.waitFor(() => {
        expect(resume).toHaveBeenCalledOnce();
        expect(stdout.capturedText()).toContain(
          'source=manual failure=send_rejected',
        );
      });
      expect(followupSend).not.toHaveBeenCalled();

      input.write('/recovery continue\n');
      await vi.waitFor(() => expect(followupSend).toHaveBeenCalledOnce());
      expect(stdout.capturedText()).toContain('Follow-up handled.');

      input.write('/exit\n');
      await run;
      exited = true;
    } finally {
      if (!exited) input.write('/exit\n');
      input.end();
      await run.catch(() => {});
    }
  });

  it('intercepts reconnect commands and reports each resume result without sending them', async () => {
    const stdout = createOutput();
    const stdin = new PassThrough() as PassThrough & OperatorAgentInput;
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
    const resume = vi
      .fn()
      .mockResolvedValueOnce(resumedAgents[0])
      .mockRejectedValueOnce(new Error('resume unavailable'));

    const run = runOperatorAgent(
      { repoRoot },
      {
        stdin,
        stdout,
        agentFactory: {
          create: async () => initialAgent,
          resume,
        },
      },
    );

    await vi.waitFor(() =>
      expect(stdout.capturedText()).toContain('\u001b[0m (pi) ready'),
    );
    stdin.write('/reconnect\n');
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    stdin.write('reconnect\n');
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(2));
    stdin.write('/exit\n');
    await run;

    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenNthCalledWith(
      1,
      'operator-agent-id',
      expect.objectContaining({ cwd: repoRoot, modelId: 'smoke-model' }),
    );
    expect(resume).toHaveBeenNthCalledWith(
      2,
      'operator-agent-id',
      expect.objectContaining({ cwd: repoRoot, modelId: 'smoke-model' }),
    );
    expect(send).not.toHaveBeenCalled();
    expect(stdout.capturedText()).toContain('conductor に再接続しました。');
    expect(stdout.capturedText()).toContain('conductor の再接続に失敗しました。');
  });

  it('does not replay a failed operator-agent prompt after manual reconnect', async () => {
    const stdout = createOutput();
    const stderr = createOutput();
    const stdin = new PassThrough() as PassThrough & OperatorAgentInput;
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
    const firstSend = vi.fn(async (message: string) => {
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
      { repoRoot },
      {
        stdin,
        stdout,
        stderr,
        agentFactory: {
          create: async () => createFakeAgent({ send: firstSend }),
          resume,
        },
      },
    );

    await vi.waitFor(() =>
      expect(stdout.capturedText()).toContain('\u001b[2muser>\u001b[0m '),
    );
    stdin.write(`${prompt}\n`);
    await vi.waitFor(() => expect(stderr.capturedText()).toContain('[auth] Pi 認証エラー'));
    expect(firstSend).toHaveBeenCalledOnce();
    expect(automaticRetrySend).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledOnce();
    expect(stdout.capturedText()).toContain('operator send が未完了です');

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

  it('prints Pi auth recovery steps to stderr after reconnect when the send still fails', async () => {
    const projectDir = join(repoRoot, '.ensemble', 'pi-project');
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
      { repoRoot },
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
