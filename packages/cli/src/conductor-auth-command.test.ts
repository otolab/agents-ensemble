import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveConductorCommandContext,
  runConductorLogin,
  runConductorAuthStatus,
  runConductorLogout,
} from './conductor-auth-command.js';

describe('conductor auth CLI wiring', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves Pi backend and configured resource roots from the ensemble config', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-auth-'));
    const agentDir = join(repoRoot, 'user-pi');
    const projectDir = join(repoRoot, 'project-pi');
    await mkdir(join(repoRoot, '.ensemble'), { recursive: true });
    await writeFile(
      join(repoRoot, '.ensemble', 'config.yaml'),
      `conductor:\n  backend: pi\n  model: anthropic/claude-test\n  pi:\n    agentDir: ./user-pi\n    projectDir: ./project-pi\n`,
    );

    const context = await resolveConductorCommandContext({ repoRoot });

    expect(context.auth.backend).toBe('pi');
    expect(context.auth.pi).toMatchObject({
      cwd: repoRoot,
      pi: { agentDir, projectDir },
    });
    expect(context.auth.modelId).toBe('anthropic/claude-test');
  });

  it('shows Pi status without leaking the credential and removes only the user credential', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-auth-'));
    const agentDir = join(repoRoot, 'user-pi');
    const projectDir = join(repoRoot, 'project-pi');
    await mkdir(join(repoRoot, '.ensemble'), { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(repoRoot, '.ensemble', 'config.yaml'),
      `conductor:\n  backend: pi\n  pi:\n    agentDir: ./user-pi\n    projectDir: ./project-pi\n`,
    );
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'local' }),
    );
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, 'auth.json'),
      JSON.stringify({ local: { type: 'api_key', key: 'cli-secret' } }),
    );

    const status = await runConductorAuthStatus({ repoRoot });
    expect(status).toMatchObject({
      backend: 'pi',
      authPath: join(agentDir, 'auth.json'),
      providers: [
        expect.objectContaining({
          provider: 'local',
          configured: true,
          source: 'stored',
          mode: 'api_key',
        }),
      ],
    });
    expect(JSON.stringify(status)).not.toContain('cli-secret');

    await expect(runConductorLogout({ repoRoot, provider: 'local' })).resolves.toMatchObject({
      backend: 'pi',
      provider: 'local',
    });
    await expect(readFile(join(agentDir, 'auth.json'), 'utf8')).resolves.not.toContain(
      'cli-secret',
    );
  });

  it('lets setup log in to its selected backend while preserving project precedence', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-auth-setup-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-auth-setup-user-'));
    const agentDir = join(userRoot, 'pi');
    vi.stubEnv('ENSEMBLE_USER_ROOT', userRoot);
    await mkdir(join(repoRoot, '.ensemble'), { recursive: true });
    await writeFile(
      join(userRoot, 'config.yaml'),
      `config:\n  loadProjectConfig: true\nconductor:\n  backend: pi\n  pi:\n    agentDir: ${agentDir}\n`,
    );
    await writeFile(
      join(repoRoot, '.ensemble', 'config.yaml'),
      'conductor:\n  backend: cursor\n',
    );

    const context = await resolveConductorCommandContext({
      repoRoot,
      backend: 'pi',
      piAgentDir: agentDir,
    });

    expect(context.config.conductor.backend).toBe('cursor');
    expect(context.auth.backend).toBe('pi');
    expect(context.auth.pi?.pi?.agentDir).toBe(agentDir);
  });

  it('accepts an explicit OpenAI API key without echoing it to terminal output', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-auth-key-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-auth-key-user-'));
    const agentDir = join(userRoot, 'pi');
    const authPath = join(agentDir, 'auth.json');
    const secret = 'test-openai-secret-value';
    await mkdir(join(repoRoot, '.ensemble'), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(userRoot, 'config.yaml'),
      `config:\n  loadProjectConfig: true\nconductor:\n  backend: pi\n  pi:\n    agentDir: ${agentDir}\n`,
    );
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-6.1-sol' }),
    );
    vi.stubEnv('ENSEMBLE_USER_ROOT', userRoot);

    const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    const originalStderr = Object.getOwnPropertyDescriptor(process, 'stderr');
    const originalStdout = Object.getOwnPropertyDescriptor(process, 'stdout');
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    let stderrText = '';
    let stdoutText = '';
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        const text = String(chunk);
        stderrText += text;
        if (text.includes('Pi API key for openai: ')) {
          setImmediate(() => input.end(`${secret}\n`));
        }
        callback();
      },
    });
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += String(chunk);
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
    Object.defineProperty(process, 'stdout', {
      configurable: true,
      enumerable: true,
      value: stdout,
    });

    try {
      const result = await runConductorLogin({
        repoRoot,
        backend: 'pi',
        piAgentDir: agentDir,
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
        apiKeyPrompt: true,
      });

      expect(result).toMatchObject({
        backend: 'pi',
        provider: 'openai',
        method: 'api_key',
        authPath,
      });
      expect(stderrText).toContain('Pi API key for openai: ');
      expect(stderrText).not.toContain(secret);
      expect(stdoutText).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
      await expect(readFile(authPath, 'utf8')).resolves.toContain(secret);
    } finally {
      if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
      if (originalStderr) Object.defineProperty(process, 'stderr', originalStderr);
      if (originalStdout) Object.defineProperty(process, 'stdout', originalStdout);
      input.destroy();
      stderr.destroy();
      stdout.destroy();
    }
  });

  it('reads an API key from non-TTY stdin and keeps OpenAI OAuth as the default', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-auth-stdin-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-auth-stdin-user-'));
    const agentDir = join(userRoot, 'pi');
    const authPath = join(agentDir, 'auth.json');
    const secret = 'test-stdin-openai-secret';
    await mkdir(join(repoRoot, '.ensemble'), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(repoRoot, '.ensemble', 'config.yaml'),
      `conductor:\n  backend: pi\n  pi:\n    agentDir: ${agentDir}\n    projectDir: ${join(repoRoot, 'project-pi')}\n`,
    );
    await mkdir(join(repoRoot, 'project-pi'), { recursive: true });
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-6.1-sol' }),
    );

    const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    const originalStderr = Object.getOwnPropertyDescriptor(process, 'stderr');
    const originalStdout = Object.getOwnPropertyDescriptor(process, 'stdout');
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = false;
    input.end(`${secret}\n`);
    let stderrText = '';
    let stdoutText = '';
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrText += String(chunk);
        callback();
      },
    });
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += String(chunk);
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
    Object.defineProperty(process, 'stdout', {
      configurable: true,
      enumerable: true,
      value: stdout,
    });
    vi.stubEnv('ENSEMBLE_USER_ROOT', userRoot);

    try {
      const result = await runConductorLogin({
        repoRoot,
        apiKeyStdin: true,
      });

      expect(result).toMatchObject({
        backend: 'pi',
        provider: 'openai',
        method: 'api_key',
        authPath,
      });
      expect(stderrText).not.toContain(secret);
      expect(stdoutText).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
      await expect(readFile(authPath, 'utf8')).resolves.toContain(secret);
    } finally {
      if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
      if (originalStderr) Object.defineProperty(process, 'stderr', originalStderr);
      if (originalStdout) Object.defineProperty(process, 'stdout', originalStdout);
      input.destroy();
      stderr.destroy();
      stdout.destroy();
    }
  });

  it('does not prompt on non-TTY API-key login and names the supported input route', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-auth-no-tty-'));
    await mkdir(join(repoRoot, '.ensemble'), { recursive: true });
    await writeFile(
      join(repoRoot, '.ensemble', 'config.yaml'),
      'conductor:\n  backend: pi\n',
    );
    const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = false;
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      enumerable: true,
      value: input,
    });

    try {
      await expect(
        runConductorLogin({ repoRoot, provider: 'anthropic' }),
      ).rejects.toThrow(/requires a TTY.*--api-key-stdin/);
      expect(input.readableLength).toBe(0);
    } finally {
      if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
      input.destroy();
    }
  });

  it('requires the explicit API-key prompt selector to use a TTY', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-cli-auth-prompt-no-tty-'));
    await mkdir(join(repoRoot, '.ensemble'), { recursive: true });
    await writeFile(
      join(repoRoot, '.ensemble', 'config.yaml'),
      'conductor:\n  backend: pi\n',
    );
    const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = false;
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      enumerable: true,
      value: input,
    });

    try {
      await expect(
        runConductorLogin({
          repoRoot,
          provider: 'openai',
          apiKeyPrompt: true,
        }),
      ).rejects.toThrow(/--api-key-prompt requires a TTY.*--api-key-stdin/);
      expect(input.readableLength).toBe(0);
    } finally {
      if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
      input.destroy();
    }
  });
});
