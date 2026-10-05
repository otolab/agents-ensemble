import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createPiConductorAuthContext,
  resolvePiConductorApiKey,
} from './conductor-pi-auth.js';
import { loadPiResources } from './pi-resource-loader.js';

describe('PiConductorAgent v1 model runtime integration', () => {
  it('uses ModelRuntime and ModelRegistry for custom model auth and request metadata', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-runtime-project-'));
    const agentDir = join(cwd, 'user-pi');
    const projectDir = join(cwd, 'project-pi');
    await mkdir(agentDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(agentDir, 'auth.json'),
      JSON.stringify({ local: { type: 'api_key', key: 'runtime-key' } }),
    );
    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          local: {
            api: 'openai-completions',
            baseUrl: 'https://local.example/v1',
            headers: { 'X-Project': 'project' },
            models: [
              {
                id: 'review-model',
                name: 'Review model',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 1_024,
              },
            ],
          },
        },
      }),
    );

    const resources = await loadPiResources({
      cwd,
      pi: { agentDir, projectDir },
    });
    const context = await createPiConductorAuthContext(
      { cwd, pi: { agentDir, projectDir } },
      resources,
    );
    const model = context.modelRegistry.find('local', 'review-model');

    expect(model).toMatchObject({
      provider: 'local',
      id: 'review-model',
      baseUrl: 'https://local.example/v1',
    });
    await expect(context.modelRuntime.getAuth('local')).resolves.toMatchObject({
      auth: { apiKey: 'runtime-key' },
    });
    await expect(
      resolvePiConductorApiKey({
        modelRuntime: context.modelRuntime,
        resources,
        provider: 'local',
      }),
    ).resolves.toBe('runtime-key');
    await expect(readFile(join(agentDir, 'auth.json'), 'utf8')).resolves.toContain(
      'runtime-key',
    );
  });
});
