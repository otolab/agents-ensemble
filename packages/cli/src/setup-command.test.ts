import { PassThrough, Writable } from 'node:stream';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
      message: expect.stringContaining('requires an interactive TTY'),
    });
    expect(error).toMatchObject({
      message: expect.stringContaining('~/.ensemble/config.yaml'),
    });
    expect(error).toMatchObject({
      message: expect.stringContaining('ensemble auth login'),
    });
    expect(writeFiles).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    input.destroy();
  });
});
