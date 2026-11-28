import { setupRunnerSuite } from '../../test/support/runner-suite.js';
import { readSchedulingStats } from '../../../cli/src/session-scheduling-stats.js';
import { createFakeAgent, createOutput, writeOperatorSettings } from '../../test/support/operator-fixtures.js';
import { waitForNotification } from '../../test/support/wait.js';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, join } from 'node:path';
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
import {
  operatorAgentProfileDirectory,
  resolveOperatorAgentConfigScope,
} from '../config/operator-agent-config.js';

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


  it('requires both terminal streams before loading config or starting an agent', async () => {
    const loadConfig = vi.fn();
    const input = createInput('hello\n', false);
    const output = createOutput(false);

    await expect(
      runOperatorAgent(
        { repoRoot: fixture.repoRoot },
        { stdin: input, stdout: output, loadConfig },
      ),
    ).rejects.toThrow('requires an interactive TTY');
    expect(loadConfig).not.toHaveBeenCalled();
    expect(output.capturedText()).not.toContain('\u001b[');
  });

  it('uses an explicit default config in the legacy workspace and ignores generic project config', async () => {
    await writeFile(
      join(fixture.repoRoot, '.ensemble', 'config.yaml'),
      'conductor:\n  backend: cursor\n  model: project-only-model\n',
    );
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
      {
        configPath: join(
          fixture.repoRoot,
          '.ensemble',
          'operator-agents.config.yaml',
        ),
        newSession: true,
      },
      {
        stdin: createInput('/exit\n'),
        stdout: createOutput(),
        agentFactory,
      },
    );

    expect(agentOptions?.modelId).toBe('smoke-model');
    expect(agentOptions?.cwd).toBe(
      join(fixture.repoRoot, '.ensemble', 'operator-agents', 'smoke'),
    );
    expect(agentOptions?.pi).toEqual({
      agentDir: join(fixture.repoRoot, '.ensemble', 'pi-user'),
      projectDir: join(
        fixture.repoRoot,
        '.ensemble',
        'operator-agents',
        'smoke',
        'pi-project',
      ),
    });
  });

  it('uses the selected config workspace and Pi project root while retaining the shared Pi user root', async () => {
    await writeOperatorSettings(fixture.repoRoot, 'pi');
    const userRoot = join(fixture.repoRoot, '.ensemble');
    const configPath = join(fixture.repoRoot, 'alternate-operator-agents.yaml');
    await writeFile(
      configPath,
      [
        'version: 1',
        'defaultProfile: smoke',
        'common:',
        '  conductor:',
        '    backend: pi',
        '    model: alternate-model',
        '  pi:',
        '    agentDir: pi-user',
        'profiles:',
        '  smoke:',
        '    pi:',
        '      projectDir: pi-project',
        '',
      ].join('\n'),
    );
    const configScope = await resolveOperatorAgentConfigScope(
      userRoot,
      configPath,
    );
    const workspace = operatorAgentProfileDirectory(
      userRoot,
      'smoke',
      configScope,
    );
    let agentOptions: ConductorAgentCreateOptions | undefined;
    const fakeAgent = createFakeAgent({
      send: async () => ({
        runId: 'unused',
        status: 'completed',
        result: '',
      }),
    });
    const input = createInteractiveInput();
    const output = createOutput();
    const running = runOperatorAgent(
      { configPath, newSession: true },
      {
        userEnsembleRoot: userRoot,
        autoDiscoverSessions: false,
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
    await vi.waitFor(() =>
      expect(output.capturedText()).toContain('operatorAgentId='),
    );
    const [state] = await listOperatorAgentStates(userRoot);

    expect(agentOptions?.cwd).toBe(workspace);
    expect(agentOptions?.pi).toEqual({
      agentDir: join(userRoot, 'pi-user'),
      projectDir: join(workspace, 'pi-project'),
    });
    expect(state).toMatchObject({
      configScope,
      workspace,
      piResourceRoots: {
        agentDir: join(userRoot, 'pi-user'),
        projectDir: join(workspace, 'pi-project'),
      },
    });
    expect(agentOptions?.sessionDir).toContain(
      join(userRoot, 'operator-agents', 'conversations'),
    );
    expect(agentOptions?.sessionDir).not.toContain('.config-scopes');
    expect(
      basename(dirname(agentOptions!.sessionDir!)),
    ).toMatch(/^operator-/u);
    input.write('/exit\n');
    input.endWhenReady();
    await running;
  });

  it('limits implicit conversation selection to the config and keeps explicit IDs global', async () => {
    await writeOperatorSettings(fixture.repoRoot, 'cursor');
    const userRoot = join(fixture.repoRoot, '.ensemble');
    const configPath = join(fixture.repoRoot, 'alternate-operator-agents.yaml');
    await writeFile(
      configPath,
      'version: 1\ndefaultProfile: smoke\ncommon:\n  conductor:\n    backend: cursor\nprofiles:\n  smoke: {}\n',
    );
    const configScope = await resolveOperatorAgentConfigScope(
      userRoot,
      configPath,
    );
    const defaultWorkspace = operatorAgentProfileDirectory(userRoot, 'smoke');
    const alternateWorkspace = operatorAgentProfileDirectory(
      userRoot,
      'smoke',
      configScope,
    );
    for (const [operatorAgentId, providerSessionId, workspace, scope] of [
      ['default-conversation', 'provider-default', defaultWorkspace, undefined],
      ['alternate-conversation', 'provider-alternate', alternateWorkspace, configScope],
    ] as const) {
      await saveOperatorAgentState(userRoot, {
        version: 2,
        operatorAgentId,
        providerSessionId,
        backend: 'cursor',
        profile: 'smoke',
        workspace,
        ...(scope ? { configScope: scope } : {}),
        createdAt: 1,
        updatedAt: 1,
      });
    }
    const resumed: string[] = [];
    const factory: ConductorAgentFactory = {
      create: async () => {
        throw new Error('saved conversation should resume');
      },
      resume: async (providerSessionId) => {
        resumed.push(providerSessionId);
        return {
          ...createFakeAgent({
            send: async () => ({
              runId: 'unused',
              status: 'completed',
              result: '',
            }),
          }),
          agentId: providerSessionId,
        };
      },
    };
    const run = (options: Parameters<typeof runOperatorAgent>[0]) =>
      runOperatorAgent(options, {
        userEnsembleRoot: userRoot,
        autoDiscoverSessions: false,
        stdin: createInput('/exit\n'),
        stdout: createOutput(),
        agentFactory: factory,
      });

    await run({});
    await run({ configPath });
    await saveOperatorAgentState(userRoot, {
      version: 2,
      operatorAgentId: 'default-conversation',
      providerSessionId: 'provider-default',
      backend: 'cursor',
      profile: 'smoke',
      workspace: defaultWorkspace,
      createdAt: 1,
      updatedAt: 1,
    });
    await run({ configPath, resumeId: 'default-conversation' });

    expect(resumed).toEqual([
      'provider-default',
      'provider-alternate',
      'provider-default',
    ]);
    expect(resumed).toHaveLength(3);
  });

  it('honors CLI profile and dedicated environment precedence independently of launch cwd', async () => {
    const configPath = join(
      fixture.repoRoot,
      '.ensemble',
      'operator-agents.config.yaml',
    );
    await writeFile(
      configPath,
      [
        'version: 1',
        'defaultProfile: first',
        'common:',
        '  conductor:',
        '    backend: pi',
        '    model: common-model',
        '    reasoning: low',
        'profiles:',
        '  first:',
        '    conductor:',
        '      model: first-model',
        '  second:',
        '    conductor:',
        '      model: second-model',
        '      reasoning: medium',
        '',
      ].join('\n'),
    );
    process.env.ENSEMBLE_OPERATOR_AGENT_PROFILE = 'second';
    process.env.ENSEMBLE_OPERATOR_AGENT_BACKEND = 'cursor';
    process.env.ENSEMBLE_OPERATOR_AGENT_MODEL = 'environment-model';
    process.env.ENSEMBLE_OPERATOR_AGENT_REASONING = 'high';
    process.env.CONDUCTOR_MODEL_ID = 'generic-model';
    process.env.CONDUCTOR_REASONING = 'generic-reasoning';
    const unrelatedLaunchDirectory = join(fixture.repoRoot, 'unrelated-launch-directory');
    await mkdir(unrelatedLaunchDirectory);
    const originalCwd = process.cwd();
    process.chdir(unrelatedLaunchDirectory);
    const createdOptions: ConductorAgentCreateOptions[] = [];
    try {
      await runOperatorAgent(
        { profile: 'first', newSession: true },
        {
          stdin: createInput('/exit\n'),
          stdout: createOutput(),
          agentFactory: {
            create: async (options) => {
              createdOptions.push(options);
              return createFakeAgent({
                send: async () => ({
                  runId: 'unused',
                  status: 'completed',
                  result: '',
                }),
              });
            },
            resume: async () => {
              throw new Error('not used');
            },
          },
        },
      );
    } finally {
      process.chdir(originalCwd);
    }
    await runOperatorAgent(
      { newSession: true },
      {
        stdin: createInput('/exit\n'),
        stdout: createOutput(),
        agentFactory: {
          create: async (options) => {
            createdOptions.push(options);
            return createFakeAgent({
              send: async () => ({
                runId: 'unused',
                status: 'completed',
                result: '',
              }),
            });
          },
          resume: async () => {
            throw new Error('not used');
          },
        },
      },
    );

    expect(createdOptions[0]).toMatchObject({
      cwd: join(fixture.repoRoot, '.ensemble', 'operator-agents', 'first'),
      modelId: 'environment-model',
      reasoning: 'high',
    });
    expect(createdOptions[0]).not.toHaveProperty('pi');
    expect(createdOptions[1]).toMatchObject({
      cwd: join(fixture.repoRoot, '.ensemble', 'operator-agents', 'second'),
      modelId: 'environment-model',
      reasoning: 'high',
    });
    expect(createdOptions[1]).not.toHaveProperty('pi');
  });

  it.each(['pi', 'cursor'] as const)(
    'loads only workspace instructions for %s create and resume',
    async (backend) => {
      await writeOperatorSettings(fixture.repoRoot, backend);
      const userRoot = join(fixture.repoRoot, '.ensemble');
      const workspace = join(userRoot, 'operator-agents', 'smoke');
      await mkdir(workspace, { recursive: true });
      await writeFile(join(userRoot, 'AGENTS.md'), 'GLOBAL SECRET');
      await writeFile(join(fixture.repoRoot, 'AGENTS.md'), 'REPOSITORY SECRET');
      await writeFile(join(workspace, 'AGENTS.md'), 'first workspace guidance');
      const prompts: string[] = [];
      const fakeAgent = createFakeAgent({ send: async () => ({ runId: 'unused', status: 'completed', result: '' }) });
      const factory: ConductorAgentFactory = {
        create: async (options) => { prompts.push(options.systemPrompt); return fakeAgent; },
        resume: async (_id, options) => { prompts.push(options.systemPrompt); return fakeAgent; },
      };
      await runOperatorAgent({ newSession: true }, { stdin: createInput('/exit\n'), stdout: createOutput(), agentFactory: factory });
      await writeFile(join(workspace, 'AGENTS.md'), 'updated workspace guidance');
      const statePath = operatorAgentStatePath(userRoot, 'saved-operator');
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, JSON.stringify({
        version: 2, operatorAgentId: 'saved-operator', providerSessionId: 'operator-agent-id',
        backend, profile: 'smoke', workspace, createdAt: 1, updatedAt: 1,
        ...(backend === 'pi' ? { piResourceRoots: { agentDir: join(userRoot, 'pi-user'), projectDir: join(workspace, 'pi-project') } } : {}),
      }));
      await runOperatorAgent({ resumeId: 'saved-operator' }, { stdin: createInput('/exit\n'), stdout: createOutput(), agentFactory: factory });
      expect(prompts[0]).toContain('first workspace guidance');
      expect(prompts[1]).toContain('updated workspace guidance');
      expect(prompts[1]).not.toContain('first workspace guidance');
      for (const prompt of prompts) {
        expect(prompt).not.toContain('GLOBAL SECRET');
        expect(prompt).not.toContain('REPOSITORY SECRET');
        expect(prompt.indexOf('Profile operator guidance.')).toBeGreaterThanOrEqual(0);
        expect(prompt.indexOf('Profile operator guidance.')).toBeLessThan(prompt.indexOf('Profile workspace instructions'));
      }
    },
  );

  it('ignores absent or blank workspace instructions and rejects unreadable or invalid UTF-8', async () => {
    const workspace = join(fixture.repoRoot, '.ensemble', 'operator-agents', 'smoke');
    await mkdir(workspace, { recursive: true });
    const path = join(workspace, 'AGENTS.md');
    const prompts: string[] = [];
    const factory: ConductorAgentFactory = {
      create: async (options) => { prompts.push(options.systemPrompt); return createFakeAgent({ send: async () => ({ runId: 'unused', status: 'completed', result: '' }) }); },
      resume: async () => { throw new Error('not used'); },
    };
    const run = () => runOperatorAgent({ newSession: true }, { stdin: createInput('/exit\n'), stdout: createOutput(), agentFactory: factory });
    await run();
    await writeFile(path, '  \n');
    await run();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe(prompts[1]);
    await writeFile(path, Buffer.from([0xff]));
    await expect(run()).rejects.toThrow('Failed to read profile workspace instructions');
    await rm(path);
    await mkdir(path);
    await expect(run()).rejects.toThrow('Failed to read profile workspace instructions');
  });

  it('rejects workspace instructions symlinks before starting an agent', async () => {
    const userRoot = join(fixture.repoRoot, '.ensemble');
    const workspace = join(userRoot, 'operator-agents', 'smoke');
    await mkdir(workspace, { recursive: true });
    const path = join(workspace, 'AGENTS.md');
    const factory: ConductorAgentFactory = {
      create: async () => { throw new Error('agent must not start'); },
      resume: async () => { throw new Error('agent must not start'); },
    };
    const run = () => runOperatorAgent({ newSession: true }, {
      stdin: createInput('/exit\n'), stdout: createOutput(), agentFactory: factory,
    });
    for (const target of [join(fixture.repoRoot, 'AGENTS.md'), join(userRoot, 'AGENTS.md'), join(workspace, 'inside.md'), join(fixture.repoRoot, 'missing.md')]) {
      if (!target.endsWith('missing.md')) await writeFile(target, 'must not be read');
      await symlink(target, path);
      await expect(run()).rejects.toThrow(/Failed to read profile workspace instructions.*symbolic link/u);
      await rm(path);
    }
  });

  it('keeps the startup snapshot during a Cursor run and sends refreshed instructions on resume', async () => {
    await writeOperatorSettings(fixture.repoRoot, 'cursor');
    const userRoot = join(fixture.repoRoot, '.ensemble');
    const workspace = join(userRoot, 'operator-agents', 'smoke');
    await mkdir(workspace, { recursive: true });
    const path = join(workspace, 'AGENTS.md');
    await writeFile(path, 'initial workspace instruction');
    const sent: string[] = [];
    const agent = createFakeAgent({ send: async (prompt) => {
      sent.push(prompt);
      return { runId: 'run-1', status: 'completed', result: 'done' };
    } });
    const factory: ConductorAgentFactory = {
      create: async () => agent,
      resume: async () => agent,
    };
    const input = createInteractiveInput();
    input.isTTY = true;
    const output = createOutput();
    const firstRun = runOperatorAgent({ newSession: true }, { stdin: input, stdout: output, agentFactory: factory });
    await vi.waitFor(() => expect(output.capturedText()).toContain('user>'));
    await writeFile(path, 'updated workspace instruction');
    input.write('first message\n');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toContain('initial workspace instruction');
    expect(sent[0]).not.toContain('updated workspace instruction');
    await vi.waitFor(() => expect(output.capturedText()).toContain('done'));
    input.write('/exit\n');
    await firstRun;

    const statePath = operatorAgentStatePath(userRoot, 'saved-operator');
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      version: 2, operatorAgentId: 'saved-operator', providerSessionId: 'operator-agent-id',
      backend: 'cursor', profile: 'smoke', workspace, createdAt: 1, updatedAt: 1,
    }));
    await runOperatorAgent({ resumeId: 'saved-operator' }, {
      stdin: createInput('resumed message\n/exit\n'), stdout: createOutput(), agentFactory: factory,
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('updated workspace instruction');
    expect(sent[1]).not.toContain('initial workspace instruction');
    expect(sent[1].indexOf('updated workspace instruction')).toBeLessThan(sent[1].indexOf('## User message'));
    expect(sent[1]).toContain('resumed message');
  });

  it('prompts for an operator profile when no default or unique profile exists', async () => {
    await writeFile(
      join(fixture.repoRoot, '.ensemble', 'operator-agents.config.yaml'),
      [
        'version: 1',
        'profiles:',
        '  first:',
        '    conductor:',
        '      model: first-model',
        '  second:',
        '    conductor:',
        '      model: second-model',
        '',
      ].join('\n'),
    );
    const input = createInteractiveInput();
    input.isTTY = true;
    const output = createOutput();
    let agentOptions: ConductorAgentCreateOptions | undefined;
    const run = runOperatorAgent(
      { newSession: true },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async (options) => {
            agentOptions = options;
            return createFakeAgent({
              send: async () => ({
                runId: 'unused',
                status: 'completed',
                result: '',
              }),
            });
          },
          resume: async () => {
            throw new Error('not used');
          },
        },
      },
    );
    await vi.waitFor(() =>
      expect(output.capturedText()).toContain('1) first'),
    );
    input.write('2\n');
    await vi.waitFor(() =>
      expect(output.capturedText()).toContain('user>'),
    );
    input.write('/exit\n');
    await run;
    expect(agentOptions?.cwd).toBe(
      join(fixture.repoRoot, '.ensemble', 'operator-agents', 'second'),
    );
    expect(agentOptions?.modelId).toBe('second-model');
  });

  it('passes only selected MCP servers to create while retaining operator restrictions and tools', async () => {
    await writeOperatorSettings(fixture.repoRoot, 'pi', undefined, {
      common: ['shared'],
      profile: ['github-read-only'],
    });
    await writeUserMcpConfig(fixture.repoRoot, {
      'github-read-only': {
        type: 'stdio',
        command: 'docker',
        args: ['run', '-i'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${env:GITHUB_PERSONAL_ACCESS_TOKEN}' },
      },
      shared: { type: 'stdio', command: 'shared-server' },
      unselected: { type: 'stdio', command: 'unselected-server' },
    });

    let agentOptions: ConductorAgentCreateOptions | undefined;
    await runOperatorAgent(
      { newSession: true },
      {
        stdin: createInput('/exit\n'),
        stdout: createOutput(),
        agentFactory: {
          create: async (options) => {
            agentOptions = options;
            return createFakeAgent({
              send: async () => ({
                runId: 'unused',
                status: 'completed',
                result: '',
              }),
            });
          },
          resume: async () => {
            throw new Error('not used');
          },
        },
      },
    );

    expect(agentOptions?.mcpServers).toEqual({
      'github-read-only': {
        type: 'stdio',
        command: 'docker',
        args: ['run', '-i'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${env:GITHUB_PERSONAL_ACCESS_TOKEN}' },
      },
    });
    expect(agentOptions).toMatchObject({
      builtinTools: false,
      piExtensions: false,
      operatorPiMcpMode: 'direct',
    });
    expect(agentOptions).not.toHaveProperty('disableCursorAmbientSettings');
    expect(agentOptions?.customTools).toHaveProperty('read_operator_workspace_file');
    expect(agentOptions?.customTools).toHaveProperty('write_operator_workspace_file');
  });

  it('disables Cursor ambient settings for operator-agent while passing selected MCP', async () => {
    await writeOperatorSettings(fixture.repoRoot, 'cursor', undefined, {
      profile: ['cursor-selected'],
    });
    await writeUserMcpConfig(fixture.repoRoot, {
      'cursor-selected': { type: 'http', url: 'https://mcp.example.test/mcp' },
      unselected: { type: 'stdio', command: 'unselected-server' },
    });

    let agentOptions: ConductorAgentCreateOptions | undefined;
    await runOperatorAgent(
      { newSession: true },
      {
        stdin: createInput('/exit\n'),
        stdout: createOutput(),
        agentFactory: {
          create: async (options) => {
            agentOptions = options;
            return createFakeAgent({
              send: async () => ({
                runId: 'unused',
                status: 'completed',
                result: '',
              }),
            });
          },
          resume: async () => {
            throw new Error('not used');
          },
        },
      },
    );

    expect(agentOptions).toMatchObject({
      builtinTools: false,
      disableCursorAmbientSettings: true,
      mcpServers: {
        'cursor-selected': {
          type: 'http',
          url: 'https://mcp.example.test/mcp',
        },
      },
    });
    expect(agentOptions).not.toHaveProperty('operatorPiMcpMode');
  });

  it('reports configured MCP server names and the cause when conductor startup fails', async () => {
    await writeOperatorSettings(fixture.repoRoot, 'pi', undefined, {
      profile: ['fixture-server'],
    });
    await writeUserMcpConfig(fixture.repoRoot, {
      'fixture-server': { type: 'stdio', command: 'fixture-mcp' },
    });

    await expect(
      runOperatorAgent(
        { newSession: true },
        {
          stdin: createInput('/exit\n'),
          stdout: createOutput(),
          agentFactory: {
            create: async () => {
              throw new Error('fixture connection refused');
            },
            resume: async () => {
              throw new Error('not used');
            },
          },
        },
      ),
    ).rejects.toThrow(
      'Operator-agent conductor startup failed with MCP server(s) [fixture-server]: fixture connection refused',
    );
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
      await writeOperatorSettings(fixture.repoRoot, backend, configReasoning);
      if (envReasoning === undefined) {
        delete process.env.ENSEMBLE_OPERATOR_AGENT_REASONING;
      } else {
        process.env.ENSEMBLE_OPERATOR_AGENT_REASONING = envReasoning;
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
        { repoRoot: fixture.repoRoot, newSession: true },
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
      await writeOperatorSettings(fixture.repoRoot, backend, configReasoning, {
        profile: ['resume-server'],
      });
      await writeUserMcpConfig(fixture.repoRoot, {
        'resume-server': { type: 'stdio', command: 'resume-mcp' },
      });
      if (envReasoning !== undefined) {
        process.env.ENSEMBLE_OPERATOR_AGENT_REASONING = envReasoning;
      }
      const userRoot = join(fixture.repoRoot, '.ensemble');
      const statePath = operatorAgentStatePath(userRoot, 'saved-operator');
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(
        statePath,
        JSON.stringify({
          version: 2,
          operatorAgentId: 'saved-operator',
          providerSessionId: 'operator-agent-id',
          backend,
          profile: 'smoke',
          workspace: join(userRoot, 'operator-agents', 'smoke'),
          ...(backend === 'pi'
            ? {
                piResourceRoots: {
                  agentDir: join(userRoot, 'pi-user'),
                  projectDir: join(
                    userRoot,
                    'operator-agents',
                    'smoke',
                    'pi-project',
                  ),
                },
              }
            : {}),
          createdAt: 1,
          updatedAt: 1,
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
        { repoRoot: fixture.repoRoot },
        {
          stdin: createInput('/exit\n'),
          stdout: createOutput(),
          agentFactory,
        },
      );

      expect(resumedOptions).toMatchObject({
        modelId: backend === 'pi' ? 'smoke-model' : 'cursor-model',
        reasoning: expectedReasoning,
        ...(backend === 'pi'
          ? {
              operatorPiMcpMode: 'direct',
              builtinTools: false,
              piExtensions: false,
            }
          : {}),
        mcpServers: {
          'resume-server': { type: 'stdio', command: 'resume-mcp' },
        },
      });
      if (backend === 'cursor') {
        expect(resumedOptions).not.toHaveProperty('operatorPiMcpMode');
      }
    },
  );

  it.each(['pi', 'cursor'] as const)(
    'leaves %s reasoning unset when config and environment omit it',
    async (backend) => {
      await writeOperatorSettings(fixture.repoRoot, backend);
      let agentOptions: ConductorAgentCreateOptions | undefined;
      const fakeAgent = createFakeAgent({
        send: async () => ({
          runId: 'unused',
          status: 'completed',
          result: '',
        }),
      });

      await runOperatorAgent(
        { repoRoot: fixture.repoRoot, newSession: true },
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
