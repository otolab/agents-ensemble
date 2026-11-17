import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runEnsembleCli } from './test-helpers.js';

describe('ensemble models show CLI', () => {
  let fixtureRoot: string | undefined;

  afterEach(async () => {
    if (fixtureRoot) {
      await rm(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = undefined;
    }
  });

  it('uses conductor model config and shows local custom metadata without network or secrets', async () => {
    const fixture = await createFixture('pi');
    fixtureRoot = fixture.root;
    const commandMarkerPath = join(fixture.root, 'command-ran');
    const networkMarkerPath = join(fixture.root, 'network-ran');
    const preloadPath = join(fixture.root, 'block-network.mjs');
    await writeFile(
      join(fixture.repoRoot, '.ensemble', 'config.yaml'),
      [
        'conductor:',
        '  backend: pi',
        '  model: local/review-model',
        '  pi:',
        `    agentDir: ${JSON.stringify(fixture.agentDir)}`,
        '',
      ].join('\n'),
    );
    await writeFile(
      join(fixture.projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          local: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKey: `!touch ${commandMarkerPath}`,
            headers: { 'x-private-header': 'HEADER_SENTINEL' },
            models: [{
              id: 'review-model',
              name: 'Review model',
              contextWindow: 98304,
              maxTokens: 8192,
            }, {
              id: 'env-model',
              name: 'Environment model',
              contextWindow: 32768,
            }],
          },
        },
      }),
    );
    await writeFile(
      preloadPath,
      [
        "import { writeFileSync } from 'node:fs';",
        'const nativeFetch = globalThis.fetch.bind(globalThis);',
        'globalThis.fetch = async (input, init) => {',
        '  const url = String(input);',
        "  if (!/^https?:/iu.test(url)) return nativeFetch(input, init);",
        `  writeFileSync(${JSON.stringify(networkMarkerPath)}, url);`,
        "  throw new Error('unexpected remote request');",
        '};',
        '',
      ].join('\n'),
    );

    const result = await runEnsembleCli(
      ['models', 'show', '--repo-root', fixture.repoRoot, '--json'],
      {
        env: {
          ...fixture.env,
          NODE_OPTIONS: `--import=${preloadPath}`,
          ENSEMBLE_MODELS_SHOW_NETWORK_MARKER: networkMarkerPath,
          CONDUCTOR_MODEL_ID: '',
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      provider: 'local',
      id: 'review-model',
      name: 'Review model',
      contextWindow: 98304,
      contextWindowSource: 'models.json',
      maxTokens: 8192,
      modelSource: 'models.json',
      selection: {
        model: 'conductor.model',
        provider: 'qualified-model',
      },
    });
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('SENTINEL');
    await expect(access(commandMarkerPath)).rejects.toThrow();
    await expect(access(networkMarkerPath)).rejects.toThrow();

    const envOverride = await runEnsembleCli(
      ['models', 'show', '--repo-root', fixture.repoRoot, '--json'],
      {
        env: {
          ...fixture.env,
          NODE_OPTIONS: `--import=${preloadPath}`,
          CONDUCTOR_MODEL_ID: 'local/env-model',
        },
      },
    );
    expect(envOverride.exitCode).toBe(0);
    expect(JSON.parse(envOverride.stdout)).toMatchObject({
      id: 'env-model',
      name: 'Environment model',
      contextWindow: 32768,
      selection: {
        model: 'CONDUCTOR_MODEL_ID',
        provider: 'qualified-model',
      },
    });

    const positionalOverride = await runEnsembleCli(
      [
        'models',
        'show',
        'local/review-model',
        '--repo-root',
        fixture.repoRoot,
        '--json',
      ],
      {
        env: {
          ...fixture.env,
          NODE_OPTIONS: `--import=${preloadPath}`,
          CONDUCTOR_MODEL_ID: 'local/env-model',
        },
      },
    );
    expect(positionalOverride.exitCode).toBe(0);
    expect(JSON.parse(positionalOverride.stdout)).toMatchObject({
      id: 'review-model',
      selection: { model: 'argument' },
    });
  });

  it('reports ambiguous unqualified IDs and tells the operator how to select one', async () => {
    const fixture = await createFixture('pi');
    fixtureRoot = fixture.root;
    await writeFile(join(fixture.agentDir, 'settings.json'), '{}');
    await writeFile(
      join(fixture.projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          alpha: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1/alpha',
            models: [{ id: 'shared-model' }],
          },
          beta: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1/beta',
            models: [{ id: 'shared-model' }],
          },
        },
      }),
    );

    const result = await runEnsembleCli(
      ['models', 'show', 'shared-model', '--repo-root', fixture.repoRoot],
      { env: fixture.env },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Pi model "shared-model" exists under multiple providers: alpha, beta',
    );
    expect(result.stderr).toContain('provider/model');
    expect(result.stderr).toContain('--provider <id>');
  });

  it('states that non-Pi backends do not provide context window details', async () => {
    const fixture = await createFixture('cursor');
    fixtureRoot = fixture.root;

    const result = await runEnsembleCli(
      ['models', 'show', '--repo-root', fixture.repoRoot],
      { env: fixture.env },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('requires the Pi backend');
    expect(result.stderr).toContain('configured backend is "cursor"');
    expect(result.stderr).toContain('contextWindow');
  });

  async function createFixture(backend: 'pi' | 'cursor') {
    const root = await mkdtemp(join(tmpdir(), 'ensemble-models-show-e2e-'));
    const repoRoot = join(root, 'repo');
    const home = join(root, 'home');
    const userRoot = join(root, 'ensemble-user');
    const agentDir = join(root, 'pi-user');
    const projectDir = join(repoRoot, '.ensemble', 'pi');
    await Promise.all([
      mkdir(join(repoRoot, '.ensemble'), { recursive: true }),
      mkdir(projectDir, { recursive: true }),
      mkdir(home, { recursive: true }),
      mkdir(userRoot, { recursive: true }),
      mkdir(agentDir, { recursive: true }),
    ]);
    await writeFile(
      join(repoRoot, '.ensemble', 'config.yaml'),
      [
        'conductor:',
        `  backend: ${backend}`,
        `  pi:\n    agentDir: ${JSON.stringify(agentDir)}`,
        '',
      ].join('\n'),
    );
    await writeFile(join(agentDir, 'settings.json'), '{}');

    return {
      root,
      repoRoot,
      agentDir,
      projectDir,
      env: {
        ...process.env,
        HOME: home,
        ENSEMBLE_USER_ROOT: userRoot,
        CONDUCTOR_MODEL_ID: '',
        PI_CODING_AGENT_DIR: '',
      },
    };
  }
});
