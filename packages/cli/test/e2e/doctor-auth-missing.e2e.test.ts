import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runEnsembleCli } from './test-helpers.js';

describe('ensemble doctor auth guard e2e', () => {
  let fixtureRoot: string | undefined;

  afterEach(async () => {
    if (fixtureRoot) {
      await rm(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = undefined;
    }
  });

  it('exits nonzero with setup/auth guidance and starts no interactive session when auth is absent', async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'ensemble-doctor-auth-e2e-'));
    const repoRoot = join(fixtureRoot, 'repo');
    const userRoot = join(fixtureRoot, 'ensemble-user');
    const home = join(fixtureRoot, 'home');
    const projectConfigDir = join(repoRoot, '.ensemble');
    await Promise.all([
      mkdir(projectConfigDir, { recursive: true }),
      mkdir(userRoot, { recursive: true }),
      mkdir(home, { recursive: true }),
    ]);
    await writeFile(
      join(projectConfigDir, 'config.yaml'),
      'conductor:\n  backend: cursor\n',
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ENSEMBLE_USER_ROOT: userRoot,
      NO_OPEN_BROWSER: '1',
    };
    for (const key of [
      'CURSOR_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'OPENROUTER_API_KEY',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'ENSEMBLE_DEFAULT_PROFILE',
      'PI_CODING_AGENT_DIR',
      'HF_TOKEN',
    ]) {
      delete env[key];
    }

    const result = await runEnsembleCli(
      ['doctor', '--repo-root', repoRoot],
      { env, timeoutMs: 30_000 },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('ensemble setup');
    expect(result.stderr).toContain('ensemble auth login');
    expect(result.stderr).toContain('ensemble auth status');
    expect(result.stdout).not.toContain('doctor agent');
  });
});
