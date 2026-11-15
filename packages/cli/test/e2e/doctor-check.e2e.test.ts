import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runEnsembleCli } from './test-helpers.js';

describe('ensemble doctor check e2e', () => {
  let fixtureRoot: string | undefined;

  afterEach(async () => {
    if (fixtureRoot) {
      await rm(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = undefined;
    }
  });

  it('runs non-TTY basic checks without starting a model or the fake worker CLI', async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'ensemble-doctor-check-e2e-'));
    const repoRoot = join(fixtureRoot, 'repo');
    const userRoot = join(fixtureRoot, 'ensemble-user');
    const home = join(fixtureRoot, 'home');
    const binDir = join(fixtureRoot, 'bin');
    const markerPath = join(fixtureRoot, 'fake-acp-started');
    await Promise.all([
      mkdir(join(repoRoot, '.ensemble'), { recursive: true }),
      mkdir(userRoot, { recursive: true }),
      mkdir(home, { recursive: true }),
      mkdir(binDir, { recursive: true }),
    ]);
    await writeFile(
      join(userRoot, 'config.yaml'),
      [
        'config:',
        '  loadProjectConfig: true',
        'profile:',
        '  default: missing-team-profile',
        'conductor:',
        '  backend: cursor',
        'acp:',
        '  defaultPreset: cursor',
        '  env:',
        '    PRIVATE_CONFIG_SENTINEL: do-not-print-this-value',
        'github:',
        '  auth:',
        '    allowGhAuthTokenFallback: true',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(binDir, 'agent'),
      `#!/bin/sh\nprintf started > '${markerPath}'\n`,
    );
    await chmod(join(binDir, 'agent'), 0o755);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ENSEMBLE_USER_ROOT: userRoot,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      CURSOR_API_KEY: 'cursor-secret-sentinel',
      FAKE_ACP_MARKER: markerPath,
    };
    for (const key of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'ENSEMBLE_DEFAULT_PROFILE',
      'PI_CODING_AGENT_DIR',
      'CONDUCTOR_MODEL_ID',
    ]) {
      delete env[key];
    }

    const result = await runEnsembleCli(
      ['doctor', 'check', '--json', '--repo-root', repoRoot],
      { env, timeoutMs: 30_000 },
    );
    const report = JSON.parse(result.stdout) as {
      mode: string;
      checks: Array<{ id: string; status: string }>;
      agent: { started: boolean; turns: number };
      exitCode: number;
    };

    expect(result.exitCode).toBe(0);
    expect(report).toMatchObject({
      mode: 'basic',
      agent: { started: false, turns: 0 },
      exitCode: 0,
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'conductor.auth',
          status: 'ok',
          summary: expect.any(String),
        }),
        expect.objectContaining({
          id: 'worker.spawn',
          status: 'ok',
          summary: expect.any(String),
        }),
        expect.objectContaining({
          id: 'config.read',
          status: 'ok',
          summary: expect.any(String),
          details: expect.any(Object),
        }),
      ]),
    );
    expect(result.stdout).not.toContain('cursor-secret-sentinel');
    expect(result.stdout).not.toContain('do-not-print-this-value');
    expect(result.stdout).not.toContain('PRIVATE_CONFIG_SENTINEL');
    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const textResult = await runEnsembleCli(
      ['doctor', 'check', '--repo-root', repoRoot],
      { env, timeoutMs: 30_000 },
    );
    expect(textResult.exitCode).toBe(0);
    expect(textResult.stdout).toContain('Doctor check (basic)');
    expect(textResult.stdout).toContain('Agent: not started');
    expect(textResult.stdout).not.toContain('cursor-secret-sentinel');
    expect(textResult.stdout).not.toContain('do-not-print-this-value');

    const unauthenticatedEnv = { ...env };
    delete unauthenticatedEnv.CURSOR_API_KEY;
    const requestResult = await runEnsembleCli(
      [
        'doctor',
        'check',
        '--json',
        'check',
        'the',
        'worker',
        'configuration',
      ],
      { env: unauthenticatedEnv, timeoutMs: 30_000 },
    );
    const requestReport = JSON.parse(requestResult.stdout) as {
      mode: string;
      agent: { started: boolean; turns: number };
      nextActions: string[];
      exitCode: number;
    };
    expect(requestResult.exitCode).toBe(1);
    expect(requestReport).toMatchObject({
      mode: 'agent',
      agent: { started: false, turns: 0 },
      exitCode: 1,
    });
    expect(requestReport.nextActions).toContain('ensemble auth login');
    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const helpResult = await runEnsembleCli(
      ['doctor', 'check', '--help'],
      { env, timeoutMs: 30_000 },
    );
    expect(helpResult.exitCode).toBe(0);
    expect(helpResult.stdout).toContain('[request...]');
    expect(helpResult.stdout).toContain('one turn');

    const usageResult = await runEnsembleCli(
      ['doctor', 'check', '--unknown'],
      { env, timeoutMs: 30_000 },
    );
    expect(usageResult.exitCode).toBe(2);
    expect(usageResult.stderr).toContain("unknown option '--unknown'");
  });
});
