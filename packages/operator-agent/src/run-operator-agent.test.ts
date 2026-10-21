import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOpenQuestionControlServer } from '@agents-ensemble/core';
import type {
  ConductorAgent,
  ConductorAgentCreateOptions,
  ConductorAgentFactory,
  EnsembleConfig,
  ResolvedProfile,
} from '@agents-ensemble/core/operator-runtime';
import {
  runOperatorAgent,
  type OperatorAgentInput,
  type OperatorAgentOutput,
} from './run-operator-agent.js';
import { operatorWatchStatePath } from './operator-watch-pool.js';

describe('runOperatorAgent', () => {
  let repoRoot = '';
  let closeServers: Array<() => Promise<void>> = [];
  let originalModelEnv: string | undefined;
  let originalProfileEnv: string | undefined;
  let originalNoColorEnv: string | undefined;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-agent-'));
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
            '保存済み sidecar では implementer のセッションが確認できます。\n\n\n\nライブ open question も確認できます。',
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
      '\u001b[36moperator>\u001b[0m\n保存済み sidecar では implementer のセッションが確認できます。\n\nライブ open question も確認できます。\n\n',
    );
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
      'register_session_watch',
      'unregister_session_watch',
      'set_report_hold',
      'release_reports',
      'send_operator_message',
    ]);
    await expect(
      readFile(join(repoRoot, '.ensemble', 'operator-agent', 'session.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
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

    expect(output.capturedText()).toContain('報告保留中（1 件）');
  });

  it('sends multiple same-source watch reports in one operator-agent dispatch', async () => {
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => ({
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
      }),
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());

    const sidecarPath = join(
      repoRoot,
      '.ensemble',
      'sessions',
      'conductor-one.json',
    );
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      sidecarPath,
      JSON.stringify({ ...sidecar, harnessSocketPath: liveServer.socketPath }),
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
    expect(sentPrompts[1]).toContain('## Open Question の更新（2 件）');
    expect(sentPrompts[1]).toContain('Review the implementation?');
    expect(sentPrompts[1]).toContain('Confirm the test result?');
  });

  it('retains a cancelled watch report across restart and acknowledges it only after a completed retry', async () => {
    const liveServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => ({
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
      }),
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => liveServer.close());

    const sidecarPath = join(
      repoRoot,
      '.ensemble',
      'sessions',
      'conductor-one.json',
    );
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      sidecarPath,
      JSON.stringify({ ...sidecar, harnessSocketPath: liveServer.socketPath }),
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
    const statePath = join(repoRoot, '.ensemble', 'operator-agent', 'session.json');
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
      readFile(join(repoRoot, '.ensemble', 'operator-agent', 'session.json'), 'utf8'),
    ).resolves.toContain('operator-agent-id');
  });

  it('starts fresh with --new and replaces the saved session identity', async () => {
    const statePath = join(repoRoot, '.ensemble', 'operator-agent', 'session.json');
    await mkdir(join(repoRoot, '.ensemble', 'operator-agent'), { recursive: true });
    await writeFile(
      statePath,
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
