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
      },
    }));
    await writeFile(preload, `
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => String(input).startsWith('https://litellm.example/')
        ? Response.json({ data: [{ id: 'remote-model', max_input_tokens: 64000 }] })
        : String(input).startsWith('data:')
          ? originalFetch(input, init)
          : Promise.reject(new Error('Unexpected network request'));
    `);
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

  it('exposes the new commands without rm or bulk add', () => {
    const help = run('--help');
    expect(help.status).toBe(0);
    for (const name of ['list', 'remote', 'diff', 'add', 'sync']) {
      expect(help.stdout).toContain(name);
    }
    expect(help.stdout).not.toMatch(/\brm\b/);
    expect(run('add', 'one', 'two', '--provider', 'litellm').status).not.toBe(0);
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

  it('rejects a hidden user addition before writing and permits an explicit project addition', async () => {
    const projectPath = join(repoRoot, 'project-pi', 'models.json');
    const project = JSON.parse(await readFile(projectPath, 'utf8'));
    project.providers.litellm.models = [{ id: 'local-model' }];
    await writeFile(projectPath, JSON.stringify(project));
    const rejected = run('add', 'remote-model', '--provider', 'litellm');
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('Project models.json replaces the user model list');
    await expect(readFile(join(repoRoot, 'user-pi', 'models.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const added = run('add', 'remote-model', '--provider', 'litellm', '--target', 'project');
    expect(added.status).toBe(0);
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
