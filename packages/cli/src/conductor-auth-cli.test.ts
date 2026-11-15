import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

describe('ensemble auth login CLI', () => {
  const cliEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  let repoRoot: string | undefined;
  let userRoot: string | undefined;

  afterEach(async () => {
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    if (userRoot) await rm(userRoot, { recursive: true, force: true });
    repoRoot = undefined;
    userRoot = undefined;
  });

  it('stores stdin API keys without exposing them or emitting harness/session artifacts', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-auth-cli-project-'));
    userRoot = await mkdtemp(join(tmpdir(), 'ensemble-auth-cli-user-'));
    const agentDir = join(userRoot, 'pi');
    const projectDir = join(repoRoot, 'project-pi');
    const authPath = join(agentDir, 'auth.json');
    const secret = 'integration-stdin-api-key-secret';
    await Promise.all([
      mkdir(join(repoRoot, '.ensemble'), { recursive: true }),
      mkdir(agentDir, { recursive: true }),
      mkdir(projectDir, { recursive: true }),
    ]);
    await writeFile(
      join(repoRoot, '.ensemble', 'config.yaml'),
      [
        'conductor:',
        '  backend: pi',
        '  pi:',
        `    agentDir: ${JSON.stringify(agentDir)}`,
        `    projectDir: ${JSON.stringify(projectDir)}`,
        '',
      ].join('\n'),
    );

    const env = {
      ...process.env,
      HOME: userRoot,
      ENSEMBLE_USER_ROOT: userRoot,
    };
    const login = spawnSync(
      process.execPath,
      [
        cliEntry,
        'auth',
        'login',
        '--repo-root',
        repoRoot,
        '--provider',
        'openai',
        '--api-key-stdin',
      ],
      {
        encoding: 'utf8',
        env,
        input: `${secret}\n`,
        timeout: 30_000,
      },
    );

    expect(login.status).toBe(0);
    expect(login.stdout).toContain('Pi: logged in provider openai (api_key)');
    expect(login.stdout).not.toContain(secret);
    expect(login.stderr).not.toContain(secret);
    expect(JSON.stringify({ stdout: login.stdout, stderr: login.stderr })).not.toContain(secret);
    expect(() => JSON.parse(login.stdout)).toThrow();
    await expect(readFile(authPath, 'utf8')).resolves.toContain(secret);
    await expect(readdir(join(repoRoot, '.ensemble'))).resolves.toEqual(['config.yaml']);
    expect(existsSync(join(projectDir, 'auth.json'))).toBe(false);
    expect(existsSync(join(repoRoot, '.ensemble', 'sessions'))).toBe(false);
    expect(existsSync(join(userRoot, 'sessions'))).toBe(false);

    const status = spawnSync(
      process.execPath,
      [
        cliEntry,
        'auth',
        'status',
        '--repo-root',
        repoRoot,
        '--provider',
        'openai',
      ],
      { encoding: 'utf8', env, timeout: 30_000 },
    );
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('source=stored; mode=api_key');
    expect(status.stdout).not.toContain(secret);
    expect(status.stderr).not.toContain(secret);
    expect(existsSync(join(userRoot, 'sessions'))).toBe(false);
  });

  it('registers, reports, lists, and clears a Pi settings command without exposing or executing it', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-auth-command-project-'));
    userRoot = await mkdtemp(join(tmpdir(), 'ensemble-auth-command-user-'));
    const agentDir = join(userRoot, 'pi');
    const projectDir = join(repoRoot, 'project-pi');
    const settingsPath = join(agentDir, 'settings.json');
    const authPath = join(agentDir, 'auth.json');
    const markerPath = join(userRoot, 'command-ran');
    const command = `!printf cli-fixture-key; touch ${markerPath}`;
    await Promise.all([
      mkdir(join(repoRoot, '.ensemble'), { recursive: true }),
      mkdir(agentDir, { recursive: true }),
      mkdir(projectDir, { recursive: true }),
    ]);
    await writeFile(
      join(repoRoot, '.ensemble', 'config.yaml'),
      [
        'conductor:',
        '  backend: pi',
        '  pi:',
        `    agentDir: ${JSON.stringify(agentDir)}`,
        `    projectDir: ${JSON.stringify(projectDir)}`,
        '',
      ].join('\n'),
    );
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture-model' }),
    );
    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          fixture: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:11434/v1',
            models: [{ id: 'fixture-model', name: 'Fixture model' }],
          },
        },
      }),
    );
    await writeFile(
      settingsPath,
      JSON.stringify({ apiKeys: { unrelated: 'plain-key-sentinel' } }),
    );

    const env = {
      ...process.env,
      HOME: userRoot,
      ENSEMBLE_USER_ROOT: userRoot,
    };
    const runCli = (args: string[]) =>
      spawnSync(process.execPath, [cliEntry, ...args], {
        encoding: 'utf8',
        env,
        timeout: 30_000,
      });
    const set = runCli([
      'auth',
      'set-command',
      '--repo-root',
      repoRoot,
      '--provider',
      'fixture',
      '--',
      command,
    ]);
    expect(set.status).toBe(0);
    expect(set.stdout).toContain('command credential configured for fixture (user)');
    expect(set.stderr).toContain('Registration and auth status do not execute it.');
    expect(`${set.stdout}\n${set.stderr}`).not.toContain(command);
    expect(existsSync(markerPath)).toBe(false);
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({
      apiKeys: {
        unrelated: 'plain-key-sentinel',
        fixture: command,
      },
    });
    expect(existsSync(authPath)).toBe(false);

    const status = runCli([
      'auth',
      'status',
      '--repo-root',
      repoRoot,
    ]);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('source=settings_json; mode=command; scope=user');
    expect(status.stdout).toContain(`config=${settingsPath}`);
    expect(`${status.stdout}\n${status.stderr}`).not.toContain(command);
    expect(existsSync(markerPath)).toBe(false);

    const models = runCli([
      'models',
      'list',
      '--repo-root',
      repoRoot,
      '--provider',
      'fixture',
    ]);
    expect(models.status).toBe(0);
    expect(models.stdout).toContain('fixture/fixture-model');
    expect(`${models.stdout}\n${models.stderr}`).not.toContain(command);
    expect(existsSync(markerPath)).toBe(false);

    const clear = runCli([
      'auth',
      'clear-command',
      '--repo-root',
      repoRoot,
      '--provider',
      'fixture',
    ]);
    expect(clear.status).toBe(0);
    expect(clear.stdout).toContain('command credential cleared for fixture (user)');
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({
      apiKeys: { unrelated: 'plain-key-sentinel' },
    });

    const logoutCommand = `!printf logout-command-key; touch ${markerPath}`;
    await writeFile(
      settingsPath,
      JSON.stringify({
        apiKeys: {
          fixture: logoutCommand,
          plain: 'plain-key-sentinel',
          unrelated: 'keep-this-key',
        },
      }),
    );
    await writeFile(
      authPath,
      JSON.stringify({ fixture: { type: 'api_key', key: 'stored-user-key' } }),
    );
    const logout = runCli([
      'auth',
      'logout',
      '--repo-root',
      repoRoot,
      '--provider',
      'fixture',
    ]);
    expect(logout.status).toBe(0);
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({
      apiKeys: {
        fixture: logoutCommand,
        plain: 'plain-key-sentinel',
        unrelated: 'keep-this-key',
      },
    });
    expect(existsSync(markerPath)).toBe(false);

    const setProject = runCli([
      'auth',
      'set-command',
      '--repo-root',
      repoRoot,
      '--provider',
      'fixture',
      '--target',
      'project',
      '--',
      '!printf project-cli-fixture',
    ]);
    expect(setProject.status).toBe(0);
    expect(setProject.stdout).toContain('command credential configured for fixture (project)');
    expect(setProject.stdout).toContain(`settings: ${join(projectDir, 'settings.json')}`);
    expect(setProject.stderr).toContain('Project Pi settings may be committed');
    expect(setProject.stderr).toContain('conductor process user and environment');
    expect(JSON.parse(await readFile(join(projectDir, 'settings.json'), 'utf8'))).toEqual({
      defaultProvider: 'fixture',
      defaultModel: 'fixture-model',
      apiKeys: { fixture: '!printf project-cli-fixture' },
    });
    expect(existsSync(markerPath)).toBe(false);

    const clearProject = runCli([
      'auth',
      'clear-command',
      '--repo-root',
      repoRoot,
      '--provider',
      'fixture',
      '--target',
      'project',
    ]);
    expect(clearProject.status).toBe(0);
    expect(JSON.parse(await readFile(join(projectDir, 'settings.json'), 'utf8'))).toEqual({
      defaultProvider: 'fixture',
      defaultModel: 'fixture-model',
    });
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({
      apiKeys: {
        fixture: logoutCommand,
        plain: 'plain-key-sentinel',
        unrelated: 'keep-this-key',
      },
    });
  });
});
