import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveConductorCommandContext,
  runConductorAuthStatus,
  runConductorLogout,
} from './conductor-auth-command.js';

describe('conductor auth CLI wiring', () => {
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
});
