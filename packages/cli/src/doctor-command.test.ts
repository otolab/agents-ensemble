import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConductorAgent,
  ConductorAgentCreateOptions,
  ConductorAgentFactory,
  ResolvedAcpSpawn,
} from '@agents-ensemble/core';
import { loadEnsembleConfig } from '@agents-ensemble/core';
import type { ResolvedConductorCommandContext } from './conductor-auth-command.js';
import { runDoctorCommand } from './doctor-command.js';

interface TerminalFixture {
  input: PassThrough & { isTTY: boolean };
  promptOutput: Writable & { isTTY: boolean };
  stdout: Writable;
  get promptText(): string;
  get stdoutText(): string;
}

function createTerminal(
  responses: Array<{ prompt: string; answer: string }>,
): TerminalFixture {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  let promptText = '';
  let stdoutText = '';
  let nextResponse = 0;
  const promptOutput = new Writable({
    write(chunk, _encoding, callback) {
      promptText += String(chunk);
      const response = responses[nextResponse];
      if (response && promptText.includes(response.prompt)) {
        nextResponse += 1;
        setImmediate(() => input.write(`${response.answer}\n`));
      }
      callback();
    },
  }) as Writable & { isTTY: boolean };
  promptOutput.isTTY = true;
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      stdoutText += String(chunk);
      callback();
    },
  });
  return {
    input,
    promptOutput,
    stdout,
    get promptText() {
      return promptText;
    },
    get stdoutText() {
      return stdoutText;
    },
  };
}

async function createContext(
  repoRoot: string,
  userRoot: string,
): Promise<ResolvedConductorCommandContext> {
  const config = await loadEnsembleConfig(repoRoot);
  return {
    repoRoot,
    config,
    profile: { workers: [] },
    auth: {
      backend: 'pi',
      config,
      profile: { workers: [] },
      pi: {
        cwd: repoRoot,
        pi: {
          agentDir: join(userRoot, 'pi'),
          projectDir: join(repoRoot, '.ensemble', 'pi'),
        },
      },
    },
  } as unknown as ResolvedConductorCommandContext;
}

async function runDoctorFixture(options: {
  project?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ensemble-doctor-command-'));
  const repoRoot = join(root, 'repo');
  const userRoot = join(root, 'user');
  await mkdir(join(repoRoot, '.ensemble'), { recursive: true });
  await mkdir(userRoot, { recursive: true });
  await writeFile(
    join(userRoot, 'config.yaml'),
    'config:\n  loadProjectConfig: true\n',
  );
  vi.stubEnv('ENSEMBLE_USER_ROOT', userRoot);
  const context = await createContext(repoRoot, userRoot);
  const terminal = createTerminal([
    { prompt: 'この変更を保存しますか？ [y/N] ', answer: 'y' },
    { prompt: 'Doctor> ', answer: 'exit' },
  ]);
  const customTools: Array<string[]> = [];
  const agentOptionsList: ConductorAgentCreateOptions[] = [];
  const readResults: string[] = [];
  const agent = {
    agentId: 'doctor-agent',
    send: vi.fn(async () => {
      if (customTools.length === 0) {
        const tools = agentOptionsList[0]?.customTools;
        customTools.push(Object.keys(tools ?? {}));
        const readResult = await tools?.doctor_read_config?.execute({});
        readResults.push(JSON.stringify(readResult));
        await tools?.doctor_write_config?.execute({
          key: 'session.lazyWorkers',
          value: true,
        });
        return {
          runId: 'doctor-run-1',
          status: 'finished',
          result: 'Lazy worker attach can be enabled.',
        };
      }
      return {
        runId: 'doctor-run-2',
        status: 'finished',
        result: 'Doctor session finished.',
      };
    }),
    close: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    getUsage: vi.fn().mockResolvedValue({}),
    setSystemPrompt: vi.fn().mockResolvedValue(undefined),
  } satisfies ConductorAgent;
  const factory: ConductorAgentFactory = {
    create: vi.fn(async (agentOptions) => {
      agentOptionsList.push(agentOptions);
      await mkdir(agentOptions.sessionDir!, { recursive: true });
      await writeFile(
        join(agentOptions.sessionDir!, 'transcript.jsonl'),
        'temporary doctor transcript',
      );
      return agent;
    }),
    resume: vi.fn(),
  };
  const spawn: ResolvedAcpSpawn = {
    preset: 'cursor',
    command: 'agent',
    args: [],
  };

  try {
    await runDoctorCommand({
      repoRoot,
      project: options.project,
      input: terminal.input,
      promptOutput: terminal.promptOutput,
      stdout: terminal.stdout,
      resolveContext: vi.fn().mockResolvedValue(context),
      authCheck: vi.fn().mockReturnValue(true),
      createAgentFactory: vi.fn(() => factory),
      resolveWorkerSpawn: vi.fn().mockReturnValue(spawn),
      validateWorkerSpawn: vi.fn(),
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    throw error;
  }

  const optionsUsed = agentOptionsList[0]!;
  const transcriptDir = optionsUsed.sessionDir!;
  const userConfigPath = join(userRoot, 'config.yaml');
  const projectConfigPath = join(repoRoot, '.ensemble', 'config.yaml');
  const userConfig = await readFile(userConfigPath, 'utf8');
  const projectConfig = await readFile(projectConfigPath, 'utf8').catch(
    () => undefined,
  );
  const result = {
    root,
    terminal,
    agent,
    factory,
    optionsUsed,
    customTools,
    readResults,
    transcriptDir,
    userConfig,
    projectConfig,
  };
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  return result;
}

describe('runDoctorCommand', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses only allowlisted tools, disables Pi tools/extensions, and removes the temporary transcript', async () => {
    const result = await runDoctorFixture();

    expect(result.customTools).toEqual([
      ['doctor_read_config', 'doctor_write_config'],
    ]);
    expect(result.optionsUsed).toMatchObject({
      builtinTools: false,
      piSkills: false,
      piExtensions: false,
      piInternalExtensions: false,
      legacySessionDirs: [],
    });
    expect(result.optionsUsed).not.toHaveProperty('mcpServers');
    expect(result.optionsUsed.sessionDir).toContain('ensemble-doctor-pi-session-');
    expect(result.optionsUsed.sessionDir).not.toContain('/repo/.ensemble/pi/sessions');
    expect(existsSync(result.transcriptDir)).toBe(false);
    expect(result.agent.close).toHaveBeenCalledOnce();
    expect(result.readResults[0]).toContain('github.auth.allowGhAuthTokenFallback');
    expect(result.terminal.stdoutText).toContain('Conductor');
    expect(result.terminal.stdoutText).toContain('Worker spawn 前提');
    expect(result.terminal.stdoutText).toContain('Configuration');
    expect(result.userConfig).toContain('lazyWorkers: true');
    expect(result.projectConfig).toBeUndefined();
    expect(result.terminal.promptText).toContain('保存先: user config');
  });

  it('targets project config only when explicitly opted in', async () => {
    const result = await runDoctorFixture({ project: true });

    expect(result.projectConfig).toContain('lazyWorkers: true');
    expect(result.userConfig).not.toContain('lazyWorkers: true');
    expect(result.terminal.promptText).toContain('保存先: project config');
  });

  it('reports missing conductor auth with setup/auth next actions before starting an agent', async () => {
    const repoRoot = '/tmp/doctor-no-auth-repo';
    const createAgentFactory = vi.fn();
    const resolveContext = vi.fn().mockResolvedValue({
      auth: { backend: 'pi' },
    });

    const error = await runDoctorCommand({
      repoRoot,
      authCheck: () => false,
      resolveContext,
      createAgentFactory,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      message: expect.stringContaining('ensemble setup'),
    });
    expect(error).toMatchObject({
      message: expect.stringContaining('ensemble auth login'),
    });
    expect(createAgentFactory).not.toHaveBeenCalled();
  });

  it('requires a TTY after confirming conductor auth', async () => {
    const resolveContext = vi.fn().mockResolvedValue({
      auth: { backend: 'pi' },
    });
    const createAgentFactory = vi.fn();

    await expect(
      runDoctorCommand({
        repoRoot: '/tmp/doctor-tty-repo',
        input: Object.assign(new PassThrough(), { isTTY: false }),
        promptOutput: Object.assign(new Writable({ write: (_c, _e, cb) => cb() }), {
          isTTY: false,
        }),
        authCheck: () => true,
        resolveContext,
        createAgentFactory,
      }),
    ).rejects.toThrow('requires an interactive TTY');
    expect(createAgentFactory).not.toHaveBeenCalled();
  });
});
