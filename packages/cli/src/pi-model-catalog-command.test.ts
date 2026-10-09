import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listPiConductorModels } from '@agents-ensemble/core';
import { describe, expect, it } from 'vitest';
import { runPiModelsSync } from './pi-model-catalog-command.js';

describe('Pi model catalog sync command', () => {
  it('compares catalogs, imports selected IDs, and exposes them to a fresh registry', async () => {
    const fixture = await createFixture({
      projectModels: [
        { id: 'existing-model' },
        { id: 'removed-model', name: 'Keep this model' },
      ],
      apiKey: '!printf catalog-secret',
    });
    const requests: Array<{ url: string; authorization: string | null }> = [];

    const result = await runPiModelsSync({
      repoRoot: fixture.repoRoot,
      provider: 'litellm',
      target: 'project',
      add: ['new-limited'],
      fetchImpl: (async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return Response.json({
          data: [
            { id: 'existing-model' },
            { id: 'new-plain' },
            { id: 'new-limited', max_input_tokens: 922000 },
            { id: 'new-limited', max_input_tokens: 1 },
            { id: '' },
            null,
          ],
        });
      }) as typeof fetch,
    });

    expect(requests).toEqual([
      {
        url: 'https://litellm.example/v1/models',
        authorization: 'Bearer catalog-secret',
      },
    ]);
    expect(result).toMatchObject({
      provider: 'litellm',
      apiOnly: [
        { id: 'new-limited', maxInputTokens: 922000 },
        { id: 'new-plain' },
      ],
      jsonOnly: ['removed-model'],
      shared: ['existing-model'],
      added: ['new-limited'],
      skipped: [],
      targetPath: fixture.projectModelsPath,
    });
    expect(JSON.stringify(result)).not.toContain('catalog-secret');

    const saved = JSON.parse(await readFile(fixture.projectModelsPath, 'utf8'));
    expect(saved.providers.litellm.models).toEqual([
      { id: 'existing-model' },
      { id: 'removed-model', name: 'Keep this model' },
      { id: 'new-limited', contextWindow: 922000 },
    ]);

    await expect(
      listPiConductorModels({
        cwd: fixture.repoRoot,
        pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
        provider: 'litellm',
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'litellm/new-limited', provider: 'litellm' }),
      ]),
    );
  });

  it('does not expose credentials or provider response bodies on request failure', async () => {
    const fixture = await createFixture({
      projectModels: [{ id: 'existing-model' }],
      apiKey: '!printf catalog-secret',
    });

    await expect(
      runPiModelsSync({
        repoRoot: fixture.repoRoot,
        provider: 'litellm',
        fetchImpl: (async () =>
          new Response('catalog-secret https://internal.example/private', {
            status: 401,
          })) as typeof fetch,
      }),
    ).rejects.toThrow('HTTP 401');
    await expect(
      runPiModelsSync({
        repoRoot: fixture.repoRoot,
        provider: 'litellm',
        fetchImpl: (async () => {
          throw new Error('catalog-secret https://internal.example/private');
        }) as typeof fetch,
      }),
    ).rejects.toThrow(
      /Could not fetch the model catalog for Pi provider "litellm"/,
    );
  });

  it('uses an API key for catalog requests only when authHeader is enabled', async () => {
    const fixture = await createFixture({
      apiKey: 'catalog-secret',
      authHeader: false,
    });
    let authorization: string | null = 'unexpected';

    await runPiModelsSync({
      repoRoot: fixture.repoRoot,
      provider: 'litellm',
      fetchImpl: (async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization');
        return Response.json({ data: [] });
      }) as typeof fetch,
    });

    expect(authorization).toBeNull();
  });

  it('rejects user imports hidden by the project provider model list before writing', async () => {
    const fixture = await createFixture({
      projectModels: [{ id: 'existing-model' }],
      apiKey: 'catalog-secret',
    });
    const userModelsPath = join(fixture.agentDir, 'models.json');

    await expect(
      runPiModelsSync({
        repoRoot: fixture.repoRoot,
        provider: 'litellm',
        target: 'user',
        add: ['new-model'],
        fetchImpl: (async () =>
          Response.json({ data: [{ id: 'existing-model' }, { id: 'new-model' }] })) as typeof fetch,
      }),
    ).rejects.toThrow(/Project models\.json replaces the user model list/);
    await expect(readFile(userModelsPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('can add a model to the user file when the project layer does not replace its list', async () => {
    const fixture = await createFixture({
      apiKey: 'catalog-secret',
    });
    const userModelsPath = join(fixture.agentDir, 'models.json');

    const result = await runPiModelsSync({
      repoRoot: fixture.repoRoot,
      provider: 'litellm',
      target: 'user',
      add: ['new-model'],
      fetchImpl: (async () =>
        Response.json({
          data: [{ id: 'new-model', max_input_tokens: 64000 }],
        })) as typeof fetch,
    });

    expect(result.added).toEqual(['new-model']);
    const saved = JSON.parse(await readFile(userModelsPath, 'utf8'));
    expect(saved.providers.litellm.models).toEqual([
      { id: 'new-model', contextWindow: 64000 },
    ]);
    await expect(
      listPiConductorModels({
        cwd: fixture.repoRoot,
        pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
        provider: 'litellm',
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'litellm/new-model', provider: 'litellm' }),
      ]),
    );
  });

  it('requires an explicit target when adding IDs and preserves existing selections', async () => {
    const fixture = await createFixture({
      projectModels: [{ id: 'existing-model' }],
      apiKey: 'catalog-secret',
    });
    const fetchImpl = (async () =>
      Response.json({
        data: [{ id: 'existing-model' }, { id: 'new-model' }],
      })) as typeof fetch;

    await expect(
      runPiModelsSync({
        repoRoot: fixture.repoRoot,
        provider: 'litellm',
        add: ['new-model'],
        fetchImpl,
      }),
    ).rejects.toThrow(/Pass --target project or --target user/);

    const result = await runPiModelsSync({
      repoRoot: fixture.repoRoot,
      provider: 'litellm',
      target: 'project',
      add: ['existing-model'],
      fetchImpl,
    });
    expect(result.skipped).toEqual(['existing-model']);
    expect(result.added).toEqual([]);
  });
});

async function createFixture(options: {
  projectModels?: Array<{ id: string; name?: string }>;
  apiKey: string;
  authHeader?: boolean;
}) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-model-catalog-'));
  const agentDir = join(repoRoot, 'user-pi');
  const projectDir = join(repoRoot, 'project-pi');
  const projectModelsPath = join(projectDir, 'models.json');
  await mkdir(join(repoRoot, '.ensemble'), { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(repoRoot, '.ensemble', 'config.yaml'),
    [
      'conductor:',
      '  backend: pi',
      '  pi:',
      '    agentDir: ./user-pi',
      '    projectDir: ./project-pi',
      '',
    ].join('\n'),
  );
  await writeFile(
    projectModelsPath,
    JSON.stringify(
      {
        providers: {
          litellm: {
            name: 'LiteLLM',
            api: 'openai-completions',
            baseUrl: 'https://litellm.example/v1',
            apiKey: options.apiKey,
            authHeader: options.authHeader ?? true,
            ...(options.projectModels ? { models: options.projectModels } : {}),
          },
        },
      },
      null,
      2,
    ),
  );
  return { repoRoot, agentDir, projectDir, projectModelsPath };
}
