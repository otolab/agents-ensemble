import { PassThrough, Writable } from 'node:stream';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '@agents-ensemble/core';
import type {
  ConductorLoginResult,
  ConductorSetupFiles,
  EnsembleConfig,
  ResolvedProfile,
} from '@agents-ensemble/core';
import type { ConductorCommandOptions } from './conductor-auth-command.js';
import type { ResolvedConductorCommandContext } from './conductor-auth-command.js';
import { runSetupCommand } from './setup-command.js';

function createInput(answers: string[]) {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  let nextAnswer = 0;
  let promptOutputText = '';
  const promptOutput = new Writable({
    write(chunk, _encoding, callback) {
      const text = String(chunk);
      promptOutputText += text;
      if (text.includes('選択 [')) {
        const answer = answers[nextAnswer++];
        if (answer !== undefined) {
          setImmediate(() => input.write(`${answer}\n`));
        }
      }
      callback();
    },
  });
  const stdoutLines: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      stdoutLines.push(String(chunk));
      callback();
    },
  });
  return {
    input,
    promptOutput,
    stdout,
    get promptOutputText() {
      return promptOutputText;
    },
    get stdoutText() {
      return stdoutLines.join('');
    },
  };
}

function createProcessTerminal(secret?: string) {
  const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const originalStderr = Object.getOwnPropertyDescriptor(process, 'stderr');
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  let stderrText = '';
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      const text = String(chunk);
      stderrText += text;
      if (secret !== undefined && text.includes('Pi API key for openai: ')) {
        setImmediate(() => input.end(`${secret}\n`));
      }
      callback();
    },
  });

  Object.defineProperty(process, 'stdin', {
    configurable: true,
    enumerable: true,
    value: input,
  });
  Object.defineProperty(process, 'stderr', {
    configurable: true,
    enumerable: true,
    value: stderr,
  });

  return {
    get stderrText() {
      return stderrText;
    },
    restore() {
      if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
      if (originalStderr) Object.defineProperty(process, 'stderr', originalStderr);
      input.destroy();
      stderr.destroy();
    },
  };
}

function createContext(
  repoRoot: string,
  backend: 'cursor' | 'pi',
  agentDir?: string,
): ResolvedConductorCommandContext {
  const config = {
    conductor: {
      backend,
      model: 'default',
      pi: agentDir ? { agentDir } : {},
    },
  } as EnsembleConfig;
  return {
    repoRoot,
    config,
    profile: {} as ResolvedProfile,
    auth: {
      backend,
      config,
      profile: {} as ResolvedProfile,
      ...(backend === 'pi'
        ? {
            pi: {
              cwd: repoRoot,
              pi: {
                ...(agentDir ? { agentDir } : {}),
                projectDir: join(repoRoot, '.ensemble', 'pi'),
              },
            },
          }
        : {}),
    },
  };
}

describe('runSetupCommand', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('runs Pi API-key setup through the real writer and login without exposing the key', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-vertical-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-vertical-user-'));
    const agentDir = join(userRoot, 'pi');
    const projectPiDir = join(repoRoot, '.ensemble', 'pi');
    const userConfigPath = join(userRoot, 'config.yaml');
    const projectConfigPath = join(repoRoot, '.ensemble', 'config.yaml');
    const projectSettingsPath = join(projectPiDir, 'settings.json');
    const projectAuthPath = join(projectPiDir, 'auth.json');
    const secret = 'setup-api-key-secret';
    vi.stubEnv('ENSEMBLE_USER_ROOT', userRoot);
    vi.stubEnv('PI_CODING_AGENT_DIR', '');
    vi.stubEnv('CONDUCTOR_MODEL_ID', '');

    await mkdir(projectPiDir, { recursive: true });
    await writeFile(
      userConfigPath,
      [
        '# preserve user config',
        'conductor:',
        '  model: existing-model',
        `  pi:\n    agentDir: ${agentDir}`,
        'session:',
        '  worktree: isolated',
        '',
      ].join('\n'),
    );
    await writeFile(projectConfigPath, 'conductor:\n  backend: cursor\n');
    const projectSettings = JSON.stringify({
      defaultProvider: 'anthropic',
      defaultModel: 'claude-project',
      custom: true,
    });
    const projectAuth = JSON.stringify({
      openai: { type: 'api_key', key: 'project-auth-secret' },
    });
    await writeFile(projectSettingsPath, projectSettings);
    await writeFile(projectAuthPath, projectAuth);

    const terminal = createInput(['1', '2']);
    const processTerminal = createProcessTerminal(secret);
    try {
      const result = await runSetupCommand({
        repoRoot,
        input: terminal.input,
        promptOutput: terminal.promptOutput,
        stdout: terminal.stdout,
      });

      const savedAuthPath = join(agentDir, 'auth.json');
      const savedSettingsPath = join(agentDir, 'settings.json');
      expect(result).toMatchObject({
        backend: 'pi',
        authMethod: 'api_key',
        login: {
          backend: 'pi',
          provider: 'openai',
          method: 'api_key',
          authPath: savedAuthPath,
        },
      });
      expect(await readFile(userConfigPath, 'utf8')).toContain('# preserve user config');
      expect(await readFile(userConfigPath, 'utf8')).toContain('model: existing-model');
      expect(await readFile(userConfigPath, 'utf8')).toContain('backend: pi');
      expect(await readFile(userConfigPath, 'utf8')).toContain('worktree: isolated');
      expect(JSON.parse(await readFile(savedSettingsPath, 'utf8'))).toMatchObject({
        defaultProvider: 'openai',
        defaultModel: 'gpt-6.1-sol',
      });
      expect(JSON.parse(await readFile(savedAuthPath, 'utf8'))).toMatchObject({
        openai: { type: 'api_key', key: secret },
      });
      expect((await stat(savedAuthPath)).mode & 0o777).toBe(0o600);
      expect(terminal.stdoutText).not.toContain(secret);
      expect(terminal.promptOutputText).not.toContain(secret);
      expect(processTerminal.stderrText).not.toContain(secret);
      expect(await readFile(projectConfigPath, 'utf8')).toBe(
        'conductor:\n  backend: cursor\n',
      );
      expect(await readFile(projectSettingsPath, 'utf8')).toBe(projectSettings);
      expect(await readFile(projectAuthPath, 'utf8')).toBe(projectAuth);
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally {
      processTerminal.restore();
      terminal.input.destroy();
    }
  });

  it('saves Pi OAuth setup and forwards the choice through the real login dispatch', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-oauth-dispatch-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-oauth-dispatch-user-'));
    const agentDir = join(userRoot, 'pi');
    vi.stubEnv('ENSEMBLE_USER_ROOT', userRoot);
    vi.stubEnv('PI_CODING_AGENT_DIR', '');
    vi.stubEnv('CONDUCTOR_MODEL_ID', '');
    await writeFile(
      join(userRoot, 'config.yaml'),
      `conductor:\n  pi:\n    agentDir: ${agentDir}\n`,
    );

    const terminal = createInput(['1', '1']);
    const processTerminal = createProcessTerminal();
    const loginResult: ConductorLoginResult = {
      backend: 'pi',
      provider: 'openai',
      method: 'oauth',
      authPath: join(agentDir, 'auth.json'),
    };
    const login = vi
      .spyOn(core, 'loginConductor')
      .mockResolvedValue(loginResult);
    try {
      const result = await runSetupCommand({
        repoRoot,
        input: terminal.input,
        promptOutput: terminal.promptOutput,
        stdout: terminal.stdout,
      });

      expect(result).toMatchObject({
        backend: 'pi',
        authMethod: 'oauth',
        login: loginResult,
      });
      expect(login).toHaveBeenCalledOnce();
      expect(login).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: 'pi',
          provider: 'openai',
          modelId: 'gpt-6.1-sol',
          oauthCallbacks: expect.any(Object),
        }),
      );
      expect(await readFile(join(userRoot, 'config.yaml'), 'utf8')).toContain('backend: pi');
      expect(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))).toMatchObject({
        defaultProvider: 'openai',
        defaultModel: 'gpt-6.1-sol',
      });
    } finally {
      processTerminal.restore();
      terminal.input.destroy();
    }
  });

  it('saves Cursor setup and forwards it through the real login dispatch', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-cursor-dispatch-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-cursor-dispatch-user-'));
    vi.stubEnv('ENSEMBLE_USER_ROOT', userRoot);
    vi.stubEnv('PI_CODING_AGENT_DIR', '');
    const terminal = createInput(['2']);
    const loginResult: ConductorLoginResult = {
      email: 'operator@example.test',
      apiKeyExpiresAtMs: 1234,
    };
    const login = vi
      .spyOn(core, 'loginConductor')
      .mockResolvedValue(loginResult);

    const result = await runSetupCommand({
      repoRoot,
      input: terminal.input,
      promptOutput: terminal.promptOutput,
      stdout: terminal.stdout,
    });

    expect(result).toMatchObject({ backend: 'cursor', login: loginResult });
    expect(login).toHaveBeenCalledOnce();
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'cursor' }),
    );
    expect(await readFile(join(userRoot, 'config.yaml'), 'utf8')).toContain('backend: cursor');
    expect(terminal.stdoutText).toContain('ログイン済み: Cursor / operator@example.test');
    terminal.input.destroy();
  });

  it('writes Pi/OpenAI user settings and delegates the chosen auth method', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-cli-'));
    const terminal = createInput(['1', '2']);
    const files: ConductorSetupFiles = {
      configPath: '/tmp/ensemble-user/config.yaml',
      backend: 'pi',
      pi: {
        agentDir: '/tmp/ensemble-user/pi',
        settingsPath: '/tmp/ensemble-user/pi/settings.json',
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
      },
    };
    const loginResult: ConductorLoginResult = {
      backend: 'pi',
      provider: 'openai',
      method: 'api_key',
      authPath: '/tmp/ensemble-user/pi/auth.json',
    };
    const writeFiles = vi.fn(async () => files);
    const login = vi.fn(async () => loginResult);
    const resolveContext = vi.fn(
      async (options?: ConductorCommandOptions) =>
        createContext(repoRoot, options?.backend ?? 'pi', files.pi?.agentDir),
    );

    const result = await runSetupCommand({
      repoRoot,
      input: terminal.input,
      promptOutput: terminal.promptOutput,
      stdout: terminal.stdout,
      writeFiles,
      login,
      resolveContext,
    });

    expect(writeFiles).toHaveBeenCalledWith({
      repoRoot,
      backend: 'pi',
      pi: { provider: 'openai', modelId: 'gpt-6.1-sol' },
      readonlyProjectPiDir: join(repoRoot, '.ensemble', 'pi'),
    });
    expect(login).toHaveBeenCalledWith({
      repoRoot,
      backend: 'pi',
      piAgentDir: files.pi?.agentDir,
      provider: 'openai',
      modelId: 'gpt-6.1-sol',
      authMethod: 'api_key',
    });
    expect(result).toMatchObject({
      backend: 'pi',
      authMethod: 'api_key',
      login: loginResult,
      warnings: [],
    });
    expect(terminal.promptOutputText).toContain('OAuth（ChatGPT アカウント）');
    expect(terminal.promptOutputText).toContain('API key（OpenAI API）');
    expect(terminal.stdoutText).toContain('Pi / openai (api_key)');
    expect(terminal.stdoutText).not.toContain('secret');
    terminal.input.destroy();
  });

  it('delegates an OAuth selection to the existing login flow', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-oauth-cli-'));
    const terminal = createInput(['1', '1']);
    const files: ConductorSetupFiles = {
      configPath: '/tmp/ensemble-user/config.yaml',
      backend: 'pi',
      pi: {
        agentDir: '/tmp/ensemble-user/pi',
        settingsPath: '/tmp/ensemble-user/pi/settings.json',
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
      },
    };
    const loginResult: ConductorLoginResult = {
      backend: 'pi',
      provider: 'openai',
      method: 'oauth',
      authPath: '/tmp/ensemble-user/pi/auth.json',
    };
    const login = vi.fn(async () => loginResult);

    const result = await runSetupCommand({
      repoRoot,
      input: terminal.input,
      promptOutput: terminal.promptOutput,
      stdout: terminal.stdout,
      writeFiles: vi.fn(async () => files),
      login,
      resolveContext: async (options) =>
        createContext(repoRoot, options?.backend ?? 'pi', files.pi?.agentDir),
    });

    expect(login).toHaveBeenCalledWith({
      repoRoot,
      backend: 'pi',
      piAgentDir: files.pi?.agentDir,
      provider: 'openai',
      modelId: 'gpt-6.1-sol',
      authMethod: 'oauth',
    });
    expect(result).toMatchObject({ backend: 'pi', authMethod: 'oauth', login: loginResult });
    terminal.input.destroy();
  });

  it('keeps Cursor selection on the existing Cursor login path', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-cursor-cli-'));
    const terminal = createInput(['2']);
    const files: ConductorSetupFiles = {
      configPath: '/tmp/ensemble-user/config.yaml',
      backend: 'cursor',
    };
    const loginResult = {
      email: 'operator@example.test',
      apiKeyExpiresAtMs: 1234,
    } as ConductorLoginResult;
    const writeFiles = vi.fn(async () => files);
    const login = vi.fn(async () => loginResult);
    const resolveContext = vi.fn(async () =>
      createContext(repoRoot, 'cursor'),
    );

    const result = await runSetupCommand({
      repoRoot,
      input: terminal.input,
      promptOutput: terminal.promptOutput,
      stdout: terminal.stdout,
      writeFiles,
      login,
      resolveContext,
    });

    expect(writeFiles).toHaveBeenCalledWith({ repoRoot, backend: 'cursor' });
    expect(login).toHaveBeenCalledWith({ repoRoot, backend: 'cursor' });
    expect(result).toMatchObject({ backend: 'cursor', warnings: [] });
    expect(terminal.stdoutText).toContain('ログイン済み: Cursor / operator@example.test');
    terminal.input.destroy();
  });

  it('warns when project Pi settings or credentials take precedence', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-project-override-'));
    const agentDir = join(repoRoot, 'user-pi');
    const projectDir = join(repoRoot, '.ensemble', 'pi');
    const terminal = createInput(['1', '1']);
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-test' }),
    );
    await writeFile(
      join(projectDir, 'auth.json'),
      JSON.stringify({ openai: { type: 'oauth', access: 'project-token' } }),
    );

    const config = {
      conductor: {
        backend: 'pi',
        model: 'default',
        pi: { agentDir, projectDir },
      },
    } as EnsembleConfig;
    const profile = {} as ResolvedProfile;
    const context: ResolvedConductorCommandContext = {
      repoRoot,
      config,
      profile,
      auth: {
        backend: 'pi',
        config,
        profile,
        pi: { cwd: repoRoot, pi: { agentDir, projectDir } },
      },
    };
    const files: ConductorSetupFiles = {
      configPath: '/tmp/ensemble-user/config.yaml',
      backend: 'pi',
      pi: {
        agentDir,
        settingsPath: join(agentDir, 'settings.json'),
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
      },
    };
    const writeFiles = vi.fn(async () => files);
    const login = vi.fn(async () => ({
      backend: 'pi',
      provider: 'openai',
      method: 'oauth',
      authPath: join(agentDir, 'auth.json'),
    } as ConductorLoginResult));

    const result = await runSetupCommand({
      repoRoot,
      input: terminal.input,
      promptOutput: terminal.promptOutput,
      stdout: terminal.stdout,
      writeFiles,
      login,
      resolveContext: async () => context,
    });

    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join('\n')).toContain('project Pi settings');
    expect(result.warnings.join('\n')).toContain('project Pi auth.json');
    expect(terminal.promptOutputText).toContain('project credential');
    expect(terminal.promptOutputText).not.toContain('project-token');
    terminal.input.destroy();
  });

  it('warns when CONDUCTOR_MODEL_ID overrides the Pi setup model', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-model-env-'));
    vi.stubEnv('CONDUCTOR_MODEL_ID', 'openai/other-model');
    const terminal = createInput(['1', '1']);
    const files: ConductorSetupFiles = {
      configPath: '/tmp/ensemble-user/config.yaml',
      backend: 'pi',
      pi: {
        agentDir: '/tmp/ensemble-user/pi',
        settingsPath: '/tmp/ensemble-user/pi/settings.json',
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
      },
    };
    const result = await runSetupCommand({
      repoRoot,
      input: terminal.input,
      promptOutput: terminal.promptOutput,
      stdout: terminal.stdout,
      writeFiles: vi.fn(async () => files),
      login: vi.fn(async () => ({
        backend: 'pi',
        provider: 'openai',
        method: 'oauth',
        authPath: '/tmp/ensemble-user/pi/auth.json',
      })),
      resolveContext: async (options) =>
        createContext(repoRoot, options?.backend ?? 'pi', files.pi?.agentDir),
    });

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('CONDUCTOR_MODEL_ID=openai/other-model'),
      ]),
    );
    terminal.input.destroy();
  });

  it('does not start the wizard or write files without a TTY', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-nontty-'));
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = false;
    const writeFiles = vi.fn();
    const login = vi.fn();

    const error = await runSetupCommand({
      repoRoot,
      input,
      writeFiles,
      login,
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({
      message: expect.stringContaining('対話端末（TTY）'),
    });
    expect(error).toMatchObject({
      message: expect.stringContaining('~/.ensemble/config.yaml'),
    });
    expect(error).toMatchObject({
      message: expect.stringContaining('CURSOR_API_KEY'),
    });
    expect(error).toMatchObject({
      message: expect.stringContaining('login にも TTY が必要'),
    });
    expect(writeFiles).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    input.destroy();
  });
});
