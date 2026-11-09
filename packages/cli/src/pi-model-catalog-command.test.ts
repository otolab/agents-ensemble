import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listPiConductorModels, PiConductorAgent } from '@agents-ensemble/core';
import { describe, expect, it } from 'vitest';
import {
  runPiModelsAdd,
  runPiModelsDiff,
  runPiModelsRemote,
  runPiModelsSync,
} from './pi-model-catalog-command.js';

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
        const url = String(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get('authorization'),
        });
        if (url === 'https://litellm.example/model_group/info') {
          return Response.json({ data: [] });
        }
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
      {
        url: 'https://litellm.example/model_group/info',
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

  it('imports the LiteLLM model-group contract and passes conductor pre-session validation', async () => {
    const fixture = await createFixture({
      apiKey: 'catalog-test-key',
      providerId: 'litellm',
    });
    // The LiteLLM fixtures use the `/model_group/info` data[] contract.
    // `null` means effort support is unknown; [] is a known empty set.
    const modelsCatalog = JSON.parse(
      await readFile(
        new URL('../test/fixtures/litellm-v1-models.json', import.meta.url),
        'utf8',
      ),
    );
    const modelGroups = JSON.parse(
      await readFile(
        new URL('../test/fixtures/litellm-model-group-info.json', import.meta.url),
        'utf8',
      ),
    );
    const systemPromptPath = join(fixture.repoRoot, 'system.md');
    await writeFile(systemPromptPath, 'test prompt');
    const requests: Array<{ url: string; authorization: string | null }> = [];

    const result = await runPiModelsAdd({
      repoRoot: fixture.repoRoot,
      provider: 'litellm',
      target: 'project',
      fetchImpl: (async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return Response.json(
          url === 'https://litellm.example/model_group/info'
            ? modelGroups
            : modelsCatalog,
        );
      }) as typeof fetch,
    }, [
      'gpt-6.1-terra',
      'gpt-6.1-plain',
      'gpt-6.1-no-common-effort',
      'gpt-6.1-efforts-unknown',
    ]);

    expect(requests).toEqual([
      {
        url: 'https://litellm.example/v1/models',
        authorization: 'Bearer catalog-test-key',
      },
      {
        url: 'https://litellm.example/model_group/info',
        authorization: 'Bearer catalog-test-key',
      },
    ]);
    expect(result.added).toEqual([
      'gpt-6.1-terra',
      'gpt-6.1-plain',
      'gpt-6.1-no-common-effort',
      'gpt-6.1-efforts-unknown',
    ]);

    const saved = JSON.parse(await readFile(fixture.projectModelsPath, 'utf8'));
    expect(saved.providers.litellm.models).toEqual([
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
        reasoning: false,
      },
      {
        id: 'gpt-6.1-no-common-effort',
        contextWindow: 32768,
        reasoning: true,
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
      {
        id: 'gpt-6.1-efforts-unknown',
        reasoning: true,
      },
    ]);
    expect(result.apiOnly.map((model) => model.id)).toEqual([
      'gpt-6.1-efforts-unknown',
      'gpt-6.1-no-common-effort',
      'gpt-6.1-plain',
      'gpt-6.1-terra',
    ]);

    const conductor = await PiConductorAgent.create({
      cwd: fixture.repoRoot,
      pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
      modelId: 'litellm/gpt-6.1-terra',
      reasoning: 'low',
      systemPrompt: systemPromptPath,
      sessionDir: join(fixture.repoRoot, '.ensemble', 'pi-sessions'),
    });
    await conductor.close();
  });

  it('does not treat LiteLLM model groups absent from /v1/models as addable IDs', async () => {
    const fixture = await createFixture({
      apiKey: 'catalog-test-key',
      providerId: 'litellm',
    });
    const modelsCatalog = JSON.parse(
      await readFile(
        new URL('../test/fixtures/litellm-v1-models.json', import.meta.url),
        'utf8',
      ),
    );
    const modelGroups = JSON.parse(
      await readFile(
        new URL('../test/fixtures/litellm-model-group-info.json', import.meta.url),
        'utf8',
      ),
    );

    await expect(
      runPiModelsAdd({
        repoRoot: fixture.repoRoot,
        provider: 'litellm',
        target: 'project',
        fetchImpl: (async (input) =>
          Response.json(
            String(input) === 'https://litellm.example/model_group/info'
              ? modelGroups
              : modelsCatalog,
          )) as typeof fetch,
      }, ['not-in-v1-models']),
    ).rejects.toThrow(
      'Cannot add model IDs that are not in the API catalog: not-in-v1-models.',
    );

    const saved = JSON.parse(await readFile(fixture.projectModelsPath, 'utf8'));
    expect(saved.providers.litellm.models).toBeUndefined();
  });

  it('imports Magpie /v1/models reasoning metadata and passes conductor pre-session validation', async () => {
    const fixture = await createFixture({
      apiKey: 'catalog-test-key',
      providerId: 'magpie',
    });
    const catalog = JSON.parse(
      await readFile(
        new URL('../test/fixtures/magpie-v1-models-reasoning.json', import.meta.url),
        'utf8',
      ),
    );
    for (const model of catalog.data) {
      expect(model.reasoning).toEqual(expect.any(Boolean));
      expect(model.reasoning_levels).toEqual(
        model.supported_reasoning_levels.map(
          (level: { effort: string }) => level.effort,
        ),
      );
    }
    const userModelsPath = join(fixture.agentDir, 'models.json');
    const systemPromptPath = join(fixture.repoRoot, 'system.md');
    await writeFile(systemPromptPath, 'test prompt');
    const requestUrls: string[] = [];

    const result = await runPiModelsAdd({
      repoRoot: fixture.repoRoot,
      provider: fixture.providerId,
      fetchImpl: (async (input) => {
        requestUrls.push(String(input));
        return Response.json(catalog);
      }) as typeof fetch,
    }, ['openai/limited-reasoning', 'openai/medium-reasoning']);

    expect(requestUrls).toEqual(['https://magpie.example/v1/models']);
    expect(result.added).toEqual([
      'openai/limited-reasoning',
      'openai/medium-reasoning',
    ]);
    const saved = JSON.parse(await readFile(userModelsPath, 'utf8'));
    expect(saved.providers.magpie.models).toEqual([
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

    const conductor = await PiConductorAgent.create({
      cwd: fixture.repoRoot,
      pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
      modelId: 'magpie/openai/limited-reasoning',
      reasoning: 'low',
      systemPrompt: systemPromptPath,
      sessionDir: join(fixture.repoRoot, '.ensemble', 'pi-sessions'),
    });
    await conductor.close();
  });

  it('refreshes only API-supplied LiteLLM metadata and keeps existing model settings', async () => {
    const fixture = await createFixture({
      apiKey: 'catalog-test-key',
      projectModels: [
        {
          id: 'gpt-6.1-terra',
          name: 'Hand edited name',
          contextWindow: 12345,
          maxTokens: 4096,
          reasoning: false,
          thinkingLevelMap: { high: 'manual-high' },
          headers: { 'x-manual': 'keep' },
        },
        {
          id: 'gpt-6.1-plain',
          name: 'Manual plain model',
          contextWindow: 23456,
          reasoning: true,
          thinkingLevelMap: { low: 'manual-low' },
        },
      ],
    });
    const modelsCatalog = JSON.parse(
      await readFile(
        new URL('../test/fixtures/litellm-v1-models.json', import.meta.url),
        'utf8',
      ),
    );
    const modelGroups = JSON.parse(
      await readFile(
        new URL('../test/fixtures/litellm-model-group-info.json', import.meta.url),
        'utf8',
      ),
    );
    const fetchImpl = (async (input) =>
      Response.json(
        String(input) === 'https://litellm.example/model_group/info'
          ? modelGroups
          : modelsCatalog,
      )) as typeof fetch;
    const original = await readFile(fixture.projectModelsPath, 'utf8');

    const defaultResult = await runPiModelsAdd({
      repoRoot: fixture.repoRoot,
      provider: 'litellm',
      target: 'project',
      fetchImpl,
    }, ['gpt-6.1-terra', 'gpt-6.1-plain']);

    expect(defaultResult.skipped).toEqual(['gpt-6.1-terra', 'gpt-6.1-plain']);
    expect(await readFile(fixture.projectModelsPath, 'utf8')).toBe(original);

    const refreshResult = await runPiModelsAdd({
      repoRoot: fixture.repoRoot,
      provider: 'litellm',
      target: 'project',
      refreshMetadata: true,
      fetchImpl,
    }, ['gpt-6.1-terra', 'gpt-6.1-plain']);

    expect(refreshResult.refreshed).toEqual(['gpt-6.1-terra', 'gpt-6.1-plain']);
    expect(refreshResult.skipped).toEqual([]);
    const saved = JSON.parse(await readFile(fixture.projectModelsPath, 'utf8'));
    expect(saved.providers.litellm.models).toEqual([
      {
        id: 'gpt-6.1-terra',
        name: 'Hand edited name',
        contextWindow: 12345,
        maxTokens: 4096,
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
        headers: { 'x-manual': 'keep' },
      },
      {
        id: 'gpt-6.1-plain',
        name: 'Manual plain model',
        contextWindow: 23456,
        reasoning: false,
        thinkingLevelMap: { low: 'manual-low' },
      },
    ]);
  });

  it('continues using /v1/models when LiteLLM model-group metadata is unavailable', async () => {
    const fixture = await createFixture({ apiKey: 'catalog-test-key' });
    const modelsCatalog = JSON.parse(
      await readFile(
        new URL('../test/fixtures/litellm-v1-models.json', import.meta.url),
        'utf8',
      ),
    );

    const result = await runPiModelsAdd({
      repoRoot: fixture.repoRoot,
      provider: 'litellm',
      target: 'project',
      fetchImpl: (async (input) => {
        if (String(input) === 'https://litellm.example/model_group/info') {
          return new Response('forbidden', { status: 403 });
        }
        return Response.json(modelsCatalog);
      }) as typeof fetch,
    }, ['gpt-6.1-terra']);

    expect(result.added).toEqual(['gpt-6.1-terra']);
    expect(result.metadataWarnings).toEqual([
      'LiteLLM GET /model_group/info returned HTTP 403; continuing with the available /v1/models fields only.',
    ]);
    const saved = JSON.parse(await readFile(fixture.projectModelsPath, 'utf8'));
    expect(saved.providers.litellm.models).toEqual([
      { id: 'gpt-6.1-terra', contextWindow: 196608 },
    ]);
  });

  it('leaves existing models alone by default and refreshes only supplied reasoning metadata', async () => {
    const fixture = await createFixture({
      apiKey: 'catalog-test-key',
      providerId: 'magpie',
      projectModels: [
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
      ],
    });
    const catalog = JSON.parse(
      await readFile(
        new URL('../test/fixtures/magpie-v1-models-reasoning.json', import.meta.url),
        'utf8',
      ),
    );
    const fetchImpl = (async () =>
      Response.json({
        // This mock-only row exercises a catalog that omits optional reasoning
        // metadata; Magpie's documented rows advertise both level fields.
        data: [...catalog.data, { id: 'openai/plain', max_input_tokens: 64000 }],
      })) as typeof fetch;
    const original = await readFile(fixture.projectModelsPath, 'utf8');

    const defaultResult = await runPiModelsAdd({
      repoRoot: fixture.repoRoot,
      provider: fixture.providerId,
      target: 'project',
      fetchImpl,
    }, ['openai/limited-reasoning', 'openai/plain']);

    expect(defaultResult.skipped).toEqual([
      'openai/limited-reasoning',
      'openai/plain',
    ]);
    expect(await readFile(fixture.projectModelsPath, 'utf8')).toBe(original);

    const refreshResult = await runPiModelsAdd({
      repoRoot: fixture.repoRoot,
      provider: fixture.providerId,
      target: 'project',
      refreshMetadata: true,
      fetchImpl,
    }, ['openai/limited-reasoning', 'openai/plain']);

    expect(refreshResult.refreshed).toEqual(['openai/limited-reasoning']);
    expect(refreshResult.skipped).toEqual(['openai/plain']);
    const saved = JSON.parse(await readFile(fixture.projectModelsPath, 'utf8'));
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
      runPiModelsAdd({
        repoRoot: fixture.repoRoot,
        provider: 'litellm',
        fetchImpl: (async () =>
          Response.json({ data: [{ id: 'existing-model' }, { id: 'new-model' }] })) as typeof fetch,
      }, ['new-model']),
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

    const result = await runPiModelsAdd({
      repoRoot: fixture.repoRoot,
      provider: 'litellm',
      fetchImpl: (async () =>
        Response.json({
          data: [{ id: 'new-model', max_input_tokens: 64000 }],
        })) as typeof fetch,
    }, ['new-model']);

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

  it('preserves existing selections and guards default user sync imports', async () => {
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
    ).rejects.toThrow(/Project models\.json replaces the user model list/);

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

  it('uses the same catalog for read-only remote IDs and ID-only diff', async () => {
    const fixture = await createFixture({
      projectModels: [{ id: 'existing-model' }, { id: 'local-only' }],
      apiKey: 'catalog-secret',
    });
    const before = await readFile(fixture.projectModelsPath, 'utf8');
    const options = {
      repoRoot: fixture.repoRoot,
      provider: 'litellm',
      fetchImpl: (async () => Response.json({
        data: [{ id: 'existing-model', max_input_tokens: 10 }, { id: 'remote-only', max_input_tokens: 20 }],
      })) as typeof fetch,
    };
    await expect(runPiModelsRemote(options)).resolves.toEqual({
      provider: 'litellm',
      ids: ['existing-model', 'remote-only'],
    });
    await expect(runPiModelsDiff(options)).resolves.toEqual({
      provider: 'litellm',
      apiOnly: ['remote-only'],
      jsonOnly: ['local-only'],
      shared: ['existing-model'],
    });
    expect(await readFile(fixture.projectModelsPath, 'utf8')).toBe(before);
  });

  it('defaults legacy sync additions to user and rejects unknown IDs', async () => {
    const fixture = await createFixture({ apiKey: 'catalog-secret' });
    const options = {
      repoRoot: fixture.repoRoot,
      provider: 'litellm',
      fetchImpl: (async () => Response.json({ data: [{ id: 'remote-model' }] })) as typeof fetch,
    };
    await expect(runPiModelsAdd(options, ['missing'])).rejects.toThrow(/not in the API catalog/);
    const result = await runPiModelsSync({ ...options, add: ['remote-model'] });
    expect(result.targetPath).toBe(join(fixture.agentDir, 'models.json'));
    expect(result.added).toEqual(['remote-model']);
  });
});

async function createFixture(options: {
  providerId?: string;
  projectModels?: Array<{
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null>;
    headers?: Record<string, string>;
  }>;
  apiKey: string;
  authHeader?: boolean;
}) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-model-catalog-'));
  const providerId = options.providerId ?? 'litellm';
  const providerName = providerId === 'litellm'
    ? 'LiteLLM'
    : providerId === 'magpie'
      ? 'Magpie'
      : providerId;
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
          [providerId]: {
            name: providerName,
            api: 'openai-completions',
            baseUrl: `https://${providerId}.example/v1`,
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
  return { repoRoot, agentDir, projectDir, projectModelsPath, providerId };
}
