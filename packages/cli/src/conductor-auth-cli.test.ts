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

  it('stores stdin API keys in user auth.json without exposing them or creating session logs', async () => {
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
    await expect(readFile(authPath, 'utf8')).resolves.toContain(secret);
    await expect(readdir(join(repoRoot, '.ensemble'))).resolves.toEqual(['config.yaml']);
    expect(existsSync(join(projectDir, 'auth.json'))).toBe(false);
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
});
