import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('ensemble models catalog CLI', () => {
  let repoRoot: string;
  let preload: string;
  const cliEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-model-cli-'));
    preload = join(repoRoot, 'fetch.mjs');
    await mkdir(join(repoRoot, '.ensemble'), { recursive: true });
    await mkdir(join(repoRoot, 'project-pi'), { recursive: true });
    await writeFile(join(repoRoot, '.ensemble', 'config.yaml'), [
      'conductor:',
      '  backend: pi',
      '  pi:',
      '    agentDir: ./user-pi',
      '    projectDir: ./project-pi',
      '',
    ].join('\n'));
    await writeFile(join(repoRoot, 'project-pi', 'models.json'), JSON.stringify({
      providers: {
        litellm: {
          api: 'openai-completions',
          baseUrl: 'https://litellm.example/v1',
          apiKey: 'test-key',
        },
        magpie: {
          api: 'openai-completions',
          baseUrl: 'https://magpie.example/v1',
          apiKey: 'test-key',
        },
      },
    }));
    await setRemoteModels([{ id: 'remote-model', max_input_tokens: 64000 }]);
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    return spawnSync(process.execPath, [
      '--import', pathToFileURL(preload).href, cliEntry, 'models', ...args,
      '--repo-root', repoRoot,
    ], { encoding: 'utf8', env: { ...process.env, HOME: repoRoot } });
  }

  async function setRemoteModels(
    models: unknown[],
    provider = 'litellm',
    modelGroupInfo: unknown = { data: [] },
  ) {
    const catalogUrl = `https://${provider}.example/v1/models`;
    const modelGroupInfoUrl = `https://${provider}.example/model_group/info`;
    await writeFile(preload, `
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (String(input) === ${JSON.stringify(catalogUrl)}) {
          return Response.json({ data: ${JSON.stringify(models)} });
        }
        if (String(input) === ${JSON.stringify(modelGroupInfoUrl)}) {
          return Response.json(${JSON.stringify(modelGroupInfo)});
        }
        return String(input).startsWith('data:')
          ? originalFetch(input, init)
          : Promise.reject(new Error('Unexpected network request'));
      };
    `);
  }

  it('exposes the new commands and requires explicit IDs', () => {
    const help = run('--help');
    expect(help.status).toBe(0);
    for (const name of ['list', 'remote', 'diff', 'add', 'sync']) {
      expect(help.stdout).toContain(name);
    }
    expect(help.stdout).not.toMatch(/\brm\b/);
    const addHelp = run('add', '--help');
    expect(addHelp.stdout).toContain('<id...>');
    expect(addHelp.stdout).toContain('Remote model IDs to add');
    expect(addHelp.stdout).toContain('--refresh-metadata');
    expect(run('add', '--provider', 'litellm').status).not.toBe(0);
  });

  it('lists remote IDs, compares IDs, and adds one ID to user models', async () => {
    const remote = run('remote', '--provider', 'litellm', '--json');
    expect(remote.status).toBe(0);
    expect(JSON.parse(remote.stdout)).toEqual({ provider: 'litellm', ids: ['remote-model'] });
    const diff = run('diff', '--provider', 'litellm', '--json');
    expect(diff.status).toBe(0);
    expect(JSON.parse(diff.stdout)).toEqual({
      provider: 'litellm', apiOnly: ['remote-model'], jsonOnly: [], shared: [],
    });
    const added = run('add', 'remote-model', '--provider', 'litellm', '--json');
    expect(added.status).toBe(0);
    expect(JSON.parse(added.stdout).added).toEqual(['remote-model']);
    const models = JSON.parse(await readFile(join(repoRoot, 'user-pi', 'models.json'), 'utf8'));
    expect(models.providers.litellm.models).toEqual([
      { id: 'remote-model', contextWindow: 64000 },
    ]);
    const list = run('list', '--provider', 'litellm');
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('remote-model');
    expect(list.stderr).toContain('model registry');
    expect(list.stderr).toContain('team 設定');
  });

  it('imports Magpie /v1/models reasoning metadata and refreshes only API-supplied fields', async () => {
    const catalog = JSON.parse(
      await readFile(
        new URL('../test/fixtures/magpie-v1-models-reasoning.json', import.meta.url),
        'utf8',
      ),
    ) as { data: unknown[] };
    await setRemoteModels(catalog.data, 'magpie');

    const userModelsPath = join(repoRoot, 'user-pi', 'models.json');
    const added = run(
      'add',
      'openai/limited-reasoning',
      'openai/medium-reasoning',
      '--provider',
      'magpie',
      '--json',
    );
    expect(added.status).toBe(0);
    expect(JSON.parse(added.stdout).added).toEqual([
      'openai/limited-reasoning',
      'openai/medium-reasoning',
    ]);

    const models = JSON.parse(await readFile(userModelsPath, 'utf8'));
    expect(models.providers.magpie.models).toEqual([
      {
        id: 'openai/limited-reasoning',
        contextWindow: 9216,
        reasoning: true,
        thinkingLevelMap: {
          off: 'none',
          minimal: 'minimal',
          low: 'low',
          medium: null,
          high: 'high',
          xhigh: null,
          max: 'max',
        },
      },
      {
        id: 'openai/medium-reasoning',
        contextWindow: 8192,
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: 'minimal',
          low: null,
          medium: 'medium',
          high: null,
          xhigh: 'xhigh',
          max: null,
        },
      },
    ]);

    models.providers.magpie.models = [
      {
        id: 'openai/limited-reasoning',
        name: 'Hand edited name',
        contextWindow: 12345,
        reasoning: false,
        thinkingLevelMap: { high: 'manual-high' },
      },
      {
        id: 'openai/plain',
        name: 'Manual plain model',
        contextWindow: 23456,
        reasoning: true,
        thinkingLevelMap: { low: 'manual-low' },
      },
    ];
    await writeFile(userModelsPath, JSON.stringify(models));
    await setRemoteModels([
      ...catalog.data,
      { id: 'openai/plain', max_input_tokens: 64000 },
    ], 'magpie');

    const refreshed = run(
      'add',
      'openai/limited-reasoning',
      'openai/plain',
      '--provider',
      'magpie',
      '--refresh-metadata',
      '--json',
    );
    expect(refreshed.status).toBe(0);
    expect(JSON.parse(refreshed.stdout)).toMatchObject({
      refreshed: ['openai/limited-reasoning'],
      skipped: ['openai/plain'],
      targetPath: userModelsPath,
    });

    const saved = JSON.parse(await readFile(userModelsPath, 'utf8'));
    expect(saved.providers.magpie.models).toEqual([
      {
        id: 'openai/limited-reasoning',
        name: 'Hand edited name',
        contextWindow: 12345,
        reasoning: true,
        thinkingLevelMap: {
          off: 'none',
          minimal: 'minimal',
          low: 'low',
          medium: null,
          high: 'high',
          xhigh: null,
          max: 'max',
        },
      },
      {
        id: 'openai/plain',
        name: 'Manual plain model',
        contextWindow: 23456,
        reasoning: true,
        thinkingLevelMap: { low: 'manual-low' },
      },
    ]);
  });

  it('imports LiteLLM model-group metadata through the CLI', async () => {
    const modelsCatalog = JSON.parse(
      await readFile(
        new URL('../test/fixtures/litellm-v1-models.json', import.meta.url),
        'utf8',
      ),
    ) as { data: unknown[] };
    const modelGroups = JSON.parse(
      await readFile(
        new URL('../test/fixtures/litellm-model-group-info.json', import.meta.url),
        'utf8',
      ),
    );
    await setRemoteModels(modelsCatalog.data, 'litellm', modelGroups);

    const result = run(
      'add',
      'gpt-6.1-terra',
      'gpt-6.1-plain',
      'gpt-6.1-false-empty-efforts',
      '--provider',
      'litellm',
      '--target',
      'project',
      '--json',
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).added).toEqual([
      'gpt-6.1-terra',
      'gpt-6.1-plain',
      'gpt-6.1-false-empty-efforts',
    ]);

    const projectModels = JSON.parse(
      await readFile(join(repoRoot, 'project-pi', 'models.json'), 'utf8'),
    );
    expect(projectModels.providers.litellm.models).toEqual([
      {
        id: 'gpt-6.1-terra',
        contextWindow: 196608,
        reasoning: true,
        thinkingLevelMap: {
          off: 'none',
          minimal: 'minimal',
          low: 'low',
          medium: null,
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
      },
      {
        id: 'gpt-6.1-plain',
        contextWindow: 65536,
      },
      {
        id: 'gpt-6.1-false-empty-efforts',
        contextWindow: 45000,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: null,
          xhigh: null,
          max: null,
        },
      },
    ]);
  });

  it('warns instead of guessing reasoning metadata for LiteLLM caller aliases', async () => {
    const modelsCatalog = JSON.parse(
      await readFile(
        new URL('../test/fixtures/litellm-v1-models-caller-alias.json', import.meta.url),
        'utf8',
      ),
    ) as { data: unknown[] };
    const modelGroups = JSON.parse(
      await readFile(
        new URL('../test/fixtures/litellm-model-group-info-caller-alias.json', import.meta.url),
        'utf8',
      ),
    );
    await setRemoteModels(modelsCatalog.data, 'litellm', modelGroups);

    const result = run(
      'add',
      'team-key-alias',
      '--provider',
      'litellm',
      '--target',
      'project',
      '--json',
    );
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.added).toEqual(['team-key-alias']);
    expect(output.metadataWarnings).toHaveLength(1);
    expect(output.metadataWarnings[0]).toContain(
      'no exact model_group row for requested /v1/models ID(s): team-key-alias',
    );
    expect(output.metadataWarnings[0]).toContain(
      'reasoning metadata was not synchronized and no alias mapping was inferred',
    );
    expect(result.stderr).toContain('Warning: LiteLLM GET /model_group/info');

    const projectModels = JSON.parse(
      await readFile(join(repoRoot, 'project-pi', 'models.json'), 'utf8'),
    );
    expect(projectModels.providers.litellm.models).toEqual([
      { id: 'team-key-alias', contextWindow: 65536 },
    ]);
  });

  it('keeps sync JSON usable while warning and defaulting additions to user', async () => {
    const compare = run('sync', '--provider', 'litellm', '--json');
    expect(compare.status).toBe(0);
    expect(compare.stderr).toContain('deprecated');
    expect(JSON.parse(compare.stdout).apiOnly).toEqual([
      { id: 'remote-model', maxInputTokens: 64000 },
    ]);
    await expect(readFile(join(repoRoot, 'user-pi', 'models.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const sync = run('sync', '--provider', 'litellm', '--add', 'remote-model', '--json');
    expect(sync.status).toBe(0);
    expect(sync.stderr).toContain('deprecated');
    expect(JSON.parse(sync.stdout).added).toEqual(['remote-model']);
    await expect(readFile(join(repoRoot, 'user-pi', 'models.json'), 'utf8')).resolves.toContain('remote-model');
  });

  it('preserves the sync JSON shape while diff returns only IDs', async () => {
    const projectPath = join(repoRoot, 'project-pi', 'models.json');
    const project = JSON.parse(await readFile(projectPath, 'utf8'));
    project.providers.litellm.models = [{ id: 'shared' }, { id: 'local-only' }];
    await writeFile(projectPath, JSON.stringify(project));
    await setRemoteModels([
      { id: 'shared' },
      { id: 'remote-with-limit', max_input_tokens: 64000 },
      { id: 'remote-without-limit' },
    ]);
    const diff = run('diff', '--provider', 'litellm', '--json');
    const sync = run('sync', '--provider', 'litellm', '--json');
    expect(diff.status).toBe(0);
    expect(sync.status).toBe(0);
    expect(sync.stderr).toContain('deprecated');
    expect(JSON.parse(diff.stdout)).toEqual({
      provider: 'litellm',
      apiOnly: ['remote-with-limit', 'remote-without-limit'],
      jsonOnly: ['local-only'],
      shared: ['shared'],
    });
    expect(JSON.parse(sync.stdout)).toEqual({
      provider: 'litellm',
      apiOnly: [
        { id: 'remote-with-limit', maxInputTokens: 64000 },
        { id: 'remote-without-limit' },
      ],
      jsonOnly: ['local-only'],
      shared: ['shared'],
      added: [],
      skipped: [],
    });
  });

  it('reports the pre-add comparison in sync JSON and the post-add state in diff', () => {
    const before = run('diff', '--provider', 'litellm', '--json');
    expect(before.status).toBe(0);
    expect(JSON.parse(before.stdout)).toEqual({
      provider: 'litellm', apiOnly: ['remote-model'], jsonOnly: [], shared: [],
    });

    const sync = run('sync', '--provider', 'litellm', '--add', 'remote-model', '--json');
    expect(sync.status).toBe(0);
    expect(JSON.parse(sync.stdout)).toEqual({
      provider: 'litellm',
      apiOnly: [{ id: 'remote-model', maxInputTokens: 64000 }],
      jsonOnly: [],
      shared: [],
      added: ['remote-model'],
      skipped: [],
      targetPath: join(repoRoot, 'user-pi', 'models.json'),
    });

    const after = run('diff', '--provider', 'litellm', '--json');
    expect(after.status).toBe(0);
    expect(JSON.parse(after.stdout)).toEqual({
      provider: 'litellm', apiOnly: [], jsonOnly: [], shared: ['remote-model'],
    });
  });

  it('compares before add and reports the added ID as shared afterwards', () => {
    const before = run('diff', '--provider', 'litellm', '--json');
    expect(before.status).toBe(0);
    expect(JSON.parse(before.stdout)).toEqual({
      provider: 'litellm', apiOnly: ['remote-model'], jsonOnly: [], shared: [],
    });

    const added = run('add', 'remote-model', '--provider', 'litellm', '--json');
    expect(added.status).toBe(0);
    expect(JSON.parse(added.stdout)).toEqual({
      provider: 'litellm',
      added: ['remote-model'],
      skipped: [],
      targetPath: join(repoRoot, 'user-pi', 'models.json'),
    });

    const after = run('diff', '--provider', 'litellm', '--json');
    expect(after.status).toBe(0);
    expect(JSON.parse(after.stdout)).toEqual({
      provider: 'litellm', apiOnly: [], jsonOnly: [], shared: ['remote-model'],
    });
  });

  it.each([
    ['remote', []],
    ['diff', []],
    ['add', ['remote-model']],
    ['sync', []],
  ])('%s documents and enforces an explicit provider', async (command, args) => {
    await writeFile(join(repoRoot, 'project-pi', 'settings.json'), JSON.stringify({
      defaultProvider: 'litellm',
    }));
    const help = run(command, '--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Required: configured Pi provider ID');
    expect(help.stdout).toContain('does not select the catalog provider');
    expect(help.stdout).not.toContain('defaultProvider');
    expect(help.stdout).not.toContain('used to infer the provider');

    for (const modelOptions of [[], ['--model-id', 'litellm/remote-model']]) {
      const result = run(command, ...args, ...modelOptions);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Pass --provider <id>');
    }
  });

  it('validates every repeated sync ID before writing and preserves repeatable adds', async () => {
    await setRemoteModels([{ id: 'first' }, { id: 'second', max_input_tokens: 64000 }]);
    const userPath = join(repoRoot, 'user-pi', 'models.json');
    const rejected = run('sync', '--provider', 'litellm', '--add', 'first', '--add', 'missing');
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('not in the API catalog: missing');
    await expect(readFile(userPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const added = run('sync', '--provider', 'litellm', '--add', 'first', '--add', 'second', '--json');
    expect(added.status).toBe(0);
    expect(added.stderr).toContain('deprecated');
    expect(JSON.parse(added.stdout).added).toEqual(['first', 'second']);
    const contents = await readFile(userPath, 'utf8');
    expect(JSON.parse(contents).providers.litellm.models).toEqual([
      { id: 'first' },
      { id: 'second', contextWindow: 64000 },
    ]);

    const rejectedAgain = run('sync', '--provider', 'litellm', '--add', 'second', '--add', 'missing');
    expect(rejectedAgain.status).toBe(1);
    expect(await readFile(userPath, 'utf8')).toBe(contents);
  });

  it('adds multiple explicit IDs with the same result as repeated sync options', async () => {
    await setRemoteModels([{ id: 'first' }, { id: 'second', max_input_tokens: 64000 }]);
    const userPath = join(repoRoot, 'user-pi', 'models.json');
    const added = run('add', 'first', 'second', '--provider', 'litellm', '--json');
    expect(added.status).toBe(0);
    const result = JSON.parse(added.stdout);
    expect(result.added).toEqual(['first', 'second']);
    expect(result.skipped).toEqual([]);
    expect(result.targetPath).toBe(userPath);
    const contents = await readFile(userPath, 'utf8');
    expect(JSON.parse(contents).providers.litellm.models).toEqual([
      { id: 'first' },
      { id: 'second', contextWindow: 64000 },
    ]);
    await rm(userPath);
    const sync = run('sync', '--provider', 'litellm', '--add', 'first', '--add', 'second', '--json');
    expect(sync.status).toBe(0);
    const syncResult = JSON.parse(sync.stdout);
    expect(syncResult.added).toEqual(result.added);
    expect(syncResult.skipped).toEqual(result.skipped);
    expect(syncResult.targetPath).toBe(result.targetPath);
    expect(await readFile(userPath, 'utf8')).toBe(contents);
  });

  it('rejects mixed unknown IDs without writing and reports added and skipped IDs', async () => {
    await setRemoteModels([{ id: 'first' }, { id: 'second' }]);
    const userPath = join(repoRoot, 'user-pi', 'models.json');
    const rejected = run('add', 'first', 'missing', '--provider', 'litellm');
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('not in the API catalog: missing');
    await expect(readFile(userPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const first = run('add', 'first', '--provider', 'litellm');
    expect(first.status).toBe(0);
    const contents = await readFile(userPath, 'utf8');
    const rejectedAgain = run('add', 'first', 'second', 'missing', '--provider', 'litellm');
    expect(rejectedAgain.status).toBe(1);
    expect(await readFile(userPath, 'utf8')).toBe(contents);

    const added = run('add', 'first', 'second', 'second', '--provider', 'litellm');
    expect(added.status).toBe(0);
    expect(added.stdout).toContain('Added second to');
    expect(added.stdout).toContain('Already present; preserved: first');
    expect(JSON.parse(await readFile(userPath, 'utf8')).providers.litellm.models)
      .toEqual([{ id: 'first' }, { id: 'second' }]);
  });

  it('rejects a hidden user addition before writing and permits an explicit project addition', async () => {
    await setRemoteModels([{ id: 'local-model' }, { id: 'remote-model', max_input_tokens: 64000 }]);
    const projectPath = join(repoRoot, 'project-pi', 'models.json');
    const project = JSON.parse(await readFile(projectPath, 'utf8'));
    project.providers.litellm.models = [{ id: 'local-model' }];
    await writeFile(projectPath, JSON.stringify(project));
    const rejected = run('add', 'local-model', 'remote-model', '--provider', 'litellm');
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('Project models.json replaces the user model list');
    await expect(readFile(join(repoRoot, 'user-pi', 'models.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const added = run('add', 'local-model', 'remote-model', '--provider', 'litellm', '--target', 'project', '--json');
    expect(added.status).toBe(0);
    expect(JSON.parse(added.stdout)).toMatchObject({
      added: ['remote-model'],
      skipped: ['local-model'],
    });
    const saved = JSON.parse(await readFile(projectPath, 'utf8'));
    expect(saved.providers.litellm.models).toEqual([
      { id: 'local-model' },
      { id: 'remote-model', contextWindow: 64000 },
    ]);
  });

  it('rejects Pi-only commands on the Cursor backend', async () => {
    await writeFile(join(repoRoot, '.ensemble', 'config.yaml'), 'conductor:\n  backend: cursor\n');
    for (const args of [
      ['remote'], ['diff'], ['add', 'remote-model'], ['sync'],
    ]) {
      const result = run(...args, '--provider', 'litellm');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Pi conductor backend');
    }
  });
});
