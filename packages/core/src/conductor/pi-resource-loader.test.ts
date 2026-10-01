import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPiResources, resolvePiResourceRoots } from './pi-resource-loader.js';

const EXTENSION = (name: string, text: string): string => `
export default (pi) => pi.registerTool({
  name: '${name}',
  description: '${text}',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ content: [{ type: 'text', text: '${text}' }] }),
});
`;

describe('Pi resource loader', () => {
  it('resolves user/project roots and loads standard resources with project precedence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-resource-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-resource-user-'));
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await mkdir(join(projectDir, 'extensions'), { recursive: true });
    await mkdir(join(projectDir, 'skills', 'review'), { recursive: true });
    await mkdir(join(projectDir, 'prompts'), { recursive: true });
    await mkdir(join(projectDir, 'themes'), { recursive: true });
    await mkdir(join(agentDir, 'skills', 'review'), { recursive: true });

    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'anthropic',
        defaultModel: 'user-model',
        nested: { user: true, shared: 'user' },
      }),
    );
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({
        defaultModel: 'project-model',
        nested: { project: true, shared: 'project' },
      }),
    );
    await writeFile(
      join(agentDir, 'auth.json'),
      JSON.stringify({ anthropic: { key: 'user-key' } }),
    );
    await writeFile(
      join(projectDir, 'auth.json'),
      JSON.stringify({ anthropic: { token: 'project-token' } }),
    );
    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          local: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:11434/v1',
            models: [{ id: 'review-model' }],
          },
        },
      }),
    );
    await writeFile(
      join(agentDir, 'extensions', 'user-extension.mjs'),
      EXTENSION('user_extension', 'user'),
    );
    await writeFile(
      join(projectDir, 'extensions', 'project-extension.mjs'),
      EXTENSION('project_extension', 'project'),
    );
    await writeFile(
      join(projectDir, 'extensions', 'project-override.mjs'),
      EXTENSION('user_extension', 'project override'),
    );
    await writeFile(
      join(agentDir, 'skills', 'review', 'SKILL.md'),
      '---\ndescription: user review\n---\nuser skill',
    );
    await writeFile(
      join(projectDir, 'skills', 'review', 'SKILL.md'),
      '---\ndescription: project review\n---\nproject skill',
    );
    await writeFile(
      join(projectDir, 'prompts', 'prompt.md'),
      '---\ndescription: review prompt\nargument-hint: issue\n---\nReview $1',
    );
    await writeFile(
      join(projectDir, 'themes', 'theme.json'),
      JSON.stringify({ name: 'project-theme', colors: { accent: '#fff' } }),
    );
    await writeFile(join(projectDir, 'SYSTEM.md'), 'not loaded by the conductor');

    const resources = await loadPiResources({ cwd, pi: { agentDir, projectDir } });

    expect(resources.roots).toEqual({ agentDir, projectDir });
    expect(resources.settings).toMatchObject({
      defaultProvider: 'anthropic',
      defaultModel: 'project-model',
      nested: { user: true, project: true, shared: 'project' },
    });
    expect(resources.auth).toEqual({
      anthropic: { key: 'user-key', token: 'project-token' },
    });
    expect(resources.authLayers).toEqual([
      { anthropic: { key: 'user-key' } },
      { anthropic: { token: 'project-token' } },
    ]);
    expect(resources.models.providers.local).toMatchObject({
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: [{ id: 'review-model' }],
    });
    expect(resources.extensionTools.map((tool) => tool.name)).toEqual([
      'user_extension',
      'project_extension',
    ]);
    expect(resources.skillPaths).toContain(join(projectDir, 'skills', 'review'));
    expect(resources.promptPaths).toContain(join(projectDir, 'prompts', 'prompt.md'));
    expect(resources.themePaths).toContain(join(projectDir, 'themes', 'theme.json'));
    expect(resources.skills).toEqual([
      expect.objectContaining({
        name: 'review',
        description: 'project review',
        content: 'project skill',
      }),
    ]);
    expect(resources.prompts).toEqual([
      expect.objectContaining({
        name: 'prompt',
        description: 'review prompt',
        argumentHint: 'issue',
        content: 'Review $1',
      }),
    ]);
    expect(resources.themes).toEqual([
      expect.objectContaining({
        name: 'project-theme',
        value: { name: 'project-theme', colors: { accent: '#fff' } },
      }),
    ]);
    await expect(
      resources.extensionTools[0]!.execute('call-1', {}),
    ).resolves.toMatchObject({
      content: [{ type: 'text', text: 'project override' }],
      details: {},
    });
  });

  it('uses the ensemble defaults and PI_CODING_AGENT_DIR compatibility override', async () => {
    const cwd = '/repo';
    const home = '/home/tester';
    expect(resolvePiResourceRoots({ cwd, home, env: {} })).toEqual({
      agentDir: '/home/tester/.ensemble/pi',
      projectDir: '/repo/.ensemble/pi',
    });
    expect(
      resolvePiResourceRoots({
        cwd,
        home,
        env: { PI_CODING_AGENT_DIR: '/custom/pi' },
      }),
    ).toEqual({
      agentDir: '/custom/pi',
      projectDir: '/repo/.ensemble/pi',
    });
  });
});
