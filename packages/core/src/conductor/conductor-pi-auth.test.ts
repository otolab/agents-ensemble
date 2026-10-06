import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  createPiConductorAuthContext,
  getPiConductorAuthStatus,
  hasPiConductorAuth,
  hasPiProviderAuth,
  listPiConductorModels,
  loginPiConductor,
  logoutPiConductor,
  resolvePiConductorApiKey,
  resolvePiConductorProvider,
} from './conductor-pi-auth.js';
import { loadPiResources } from './pi-resource-loader.js';

describe('Pi conductor authentication', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores API-key login in the configured user auth layer only', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-user-'));
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'local' }),
    );

    const result = await loginPiConductor({
      cwd,
      pi: { agentDir, projectDir },
      apiKey: 'user-secret',
    });

    expect(result).toMatchObject({
      backend: 'pi',
      provider: 'local',
      method: 'api_key',
      authPath: join(agentDir, 'auth.json'),
    });
    await expect(readFile(join(agentDir, 'auth.json'), 'utf8')).resolves.toContain(
      'user-secret',
    );
    await expect(readFile(join(projectDir, 'auth.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps project auth above the user Pi runtime while resolving user auth dynamically', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-user-'));
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic' }),
    );
    await writeFile(
      join(projectDir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: 'project-key' } }),
    );

    await writeFile(
      join(agentDir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: 'user-key' } }),
    );
    const resources = await loadPiResources({
      cwd,
      pi: { agentDir, projectDir },
    });

    const context = await createPiConductorAuthContext({
      cwd,
      pi: { agentDir, projectDir },
    }, resources);
    await expect(
      resolvePiConductorApiKey({
        modelRuntime: context.modelRuntime,
        resources,
        provider: 'anthropic',
      }),
    ).resolves.toBe('project-key');

    await writeFile(
      join(projectDir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: '!printf project-command-key' } }),
    );
    const commandResources = await loadPiResources({
      cwd,
      pi: { agentDir, projectDir },
    });
    const commandContext = await createPiConductorAuthContext(
      { cwd, pi: { agentDir, projectDir } },
      commandResources,
    );
    await expect(
      resolvePiConductorApiKey({
        modelRuntime: commandContext.modelRuntime,
        resources: commandResources,
        provider: 'anthropic',
      }),
    ).resolves.toBe('project-command-key');
    await expect(commandContext.modelRuntime.getAuth('anthropic')).resolves.toMatchObject({
      auth: { apiKey: 'project-command-key' },
    });

    await writeFile(join(projectDir, 'auth.json'), JSON.stringify({}));
    const userOnlyResources = await loadPiResources({
      cwd,
      pi: { agentDir, projectDir },
    });
    const userOnlyContext = await createPiConductorAuthContext({
      cwd,
      pi: { agentDir, projectDir },
    }, userOnlyResources);
    await expect(
      resolvePiConductorApiKey({
        modelRuntime: userOnlyContext.modelRuntime,
        resources: userOnlyResources,
        provider: 'anthropic',
      }),
    ).resolves.toBe('user-key');
  });

  it('delegates OAuth login to the Pi runtime callbacks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-user-'));
    const login = vi
      .spyOn(ModelRuntime.prototype, 'login')
      .mockResolvedValue(undefined);
    const callbacks = {
      onAuth: vi.fn(),
      onDeviceCode: vi.fn(),
      onPrompt: vi.fn().mockResolvedValue('answer'),
      onSelect: vi.fn().mockResolvedValue('option'),
    };

    await expect(
      loginPiConductor({
        cwd,
        pi: { agentDir },
        provider: 'anthropic',
        oauthCallbacks: callbacks,
      }),
    ).resolves.toMatchObject({
      backend: 'pi',
      provider: 'anthropic',
      method: 'oauth',
    });
    expect(login).toHaveBeenCalledWith(
      'anthropic',
      'oauth',
      expect.objectContaining({ prompt: expect.any(Function), notify: expect.any(Function) }),
    );
  });

  it('asks the Pi runtime for the key at request time so OAuth refresh can take effect', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-user-'));
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    const resources = await loadPiResources({
      cwd,
      pi: { agentDir, projectDir },
    });
    await writeFile(
      join(agentDir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: 'initial-key' } }),
    );
    const context = await createPiConductorAuthContext({
      cwd,
      pi: { agentDir, projectDir },
    }, resources);

    await expect(
      resolvePiConductorApiKey({
        modelRuntime: context.modelRuntime,
        resources,
        provider: 'anthropic',
      }),
    ).resolves.toBe('initial-key');
  });

  it('rejects project OAuth credentials instead of sending an unrefreshable access token', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-user-'));
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'auth.json'),
      JSON.stringify({
        anthropic: {
          type: 'oauth',
          access: 'stale-access-token',
          refresh: 'refresh-token',
          expires: 0,
        },
      }),
    );
    await writeFile(
      join(agentDir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: 'user-key' } }),
    );
    const resources = await loadPiResources({
      cwd,
      pi: { agentDir, projectDir },
    });

    const context = await createPiConductorAuthContext({
      cwd,
      pi: { agentDir, projectDir },
    }, resources);
    await expect(
      resolvePiConductorApiKey({
        modelRuntime: context.modelRuntime,
        resources,
        provider: 'anthropic',
      }),
    ).rejects.toThrow(/project .*OAuth.*ensemble auth login --provider anthropic/i);

    expect(
      hasPiConductorAuth({
        cwd,
        pi: { agentDir, projectDir },
        provider: 'anthropic',
      }),
    ).toBe(false);
    await expect(
      getPiConductorAuthStatus({
        cwd,
        pi: { agentDir, projectDir },
        provider: 'anthropic',
      }),
    ).resolves.toMatchObject({
      providers: [
        {
          provider: 'anthropic',
          configured: false,
          source: 'project_oauth_unsupported',
        },
      ],
    });
  });

  it('resolves the configured provider and reports non-secret status', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-user-'));
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-test' }),
    );
    await writeFile(
      join(agentDir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: 'secret-value' } }),
    );

    await expect(
      resolvePiConductorProvider({ cwd, pi: { agentDir } }),
    ).resolves.toBe('anthropic');

    const status = await getPiConductorAuthStatus({ cwd, pi: { agentDir } });
    expect(status.providers).toEqual([
      expect.objectContaining({
        provider: 'anthropic',
        configured: true,
        source: 'stored',
      }),
    ]);
    expect(JSON.stringify(status)).not.toContain('secret-value');

    await expect(
      logoutPiConductor({ cwd, pi: { agentDir }, provider: 'anthropic' }),
    ).resolves.toMatchObject({ provider: 'anthropic', backend: 'pi' });
    await expect(readFile(join(agentDir, 'auth.json'), 'utf8')).resolves.not.toContain(
      'secret-value',
    );
  });

  it('checks readiness only for the provider selected by default settings', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-user-'));
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-test' }),
    );
    await writeFile(
      join(agentDir, 'auth.json'),
      JSON.stringify({ openai: { type: 'api_key', key: 'openai-key' } }),
    );

    const options = { cwd, pi: { agentDir, projectDir } };
    expect(hasPiConductorAuth(options)).toBe(false);

    await writeFile(
      join(agentDir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: 'anthropic-key' } }),
    );
    expect(hasPiConductorAuth(options)).toBe(true);

    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'openai/gpt-test' }),
    );
    await writeFile(
      join(agentDir, 'auth.json'),
      JSON.stringify({ openai: { type: 'api_key', key: 'openai-key' } }),
    );
    expect(hasPiConductorAuth(options)).toBe(true);
  });

  it('lists authenticated custom project models and gives a Pi-specific empty hint', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-user-'));
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          local: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKey: '$LOCAL_MODEL_KEY',
            models: [{ id: 'review-model', name: 'Review model' }],
          },
        },
      }),
    );

    await expect(
      listPiConductorModels({
        cwd,
        home: await mkdtemp(join(tmpdir(), 'pi-auth-home-')),
        pi: { agentDir, projectDir },
        provider: 'local',
        env: { LOCAL_MODEL_KEY: 'local-key' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'local/review-model',
        provider: 'local',
        displayName: 'Review model',
      }),
    ]);

    await expect(
      listPiConductorModels({
        cwd,
        home: await mkdtemp(join(tmpdir(), 'pi-auth-home-')),
        pi: { agentDir, projectDir },
        modelId: 'local/review-model',
        env: { LOCAL_MODEL_KEY: 'local-key' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'local/review-model', provider: 'local' }),
    ]);

    await writeFile(
      join(projectDir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: 'project-key' } }),
    );
    expect(
      hasPiConductorAuth({
        cwd,
        pi: { agentDir, projectDir },
        provider: 'anthropic',
      }),
    ).toBe(true);
    await expect(
      listPiConductorModels({
        cwd,
        home: await mkdtemp(join(tmpdir(), 'pi-auth-home-')),
        pi: { agentDir, projectDir },
        provider: 'anthropic',
        env: {},
      }),
    ).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'anthropic' }),
    ]));

    await expect(
      listPiConductorModels({
        cwd,
        home: await mkdtemp(join(tmpdir(), 'pi-auth-home-')),
        pi: { agentDir },
        provider: 'local',
        env: {},
      }),
    ).rejects.toThrow(/No authenticated Pi models.*ensemble auth login/);
  });

  it('resolves a custom models.json apiKey command through the Pi runtime', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-user-'));
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture-model' }),
    );
    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          fixture: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKey: '!printf command-key',
            models: [{ id: 'fixture-model', name: 'Fixture model' }],
          },
        },
      }),
    );

    const options = {
      cwd,
      pi: { agentDir, projectDir },
      env: {},
    };
    const resources = await loadPiResources(options);
    const context = await createPiConductorAuthContext(options, resources);

    await expect(
      resolvePiConductorApiKey({
        modelRuntime: context.modelRuntime,
        resources,
        provider: 'fixture',
        env: {},
      }),
    ).resolves.toBe('command-key');
    expect(hasPiConductorAuth({ ...options, provider: 'fixture' })).toBe(true);
    expect(
      hasPiProviderAuth('fixture', context, resources, {}),
    ).toBe(true);
    await expect(
      listPiConductorModels({ ...options, provider: 'fixture' }),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'fixture/fixture-model', provider: 'fixture' }),
    ]);
  });

  it('resolves a settings.json apiKeys command through the Pi runtime', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-user-'));
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'fixture',
        defaultModel: 'fixture-model',
        apiKeys: { fixture: '!printf settings-key' },
      }),
    );
    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          fixture: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:11434/v1',
            models: [{ id: 'fixture-model', name: 'Fixture model' }],
          },
        },
      }),
    );

    const options = { cwd, pi: { agentDir, projectDir }, env: {} };
    const resources = await loadPiResources(options);
    const context = await createPiConductorAuthContext(options, resources);

    await expect(
      resolvePiConductorApiKey({
        modelRuntime: context.modelRuntime,
        resources,
        provider: 'fixture',
        env: {},
      }),
    ).resolves.toBe('settings-key');

    await writeFile(
      join(projectDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'fixture',
        defaultModel: 'fixture-model',
        apiKey: '!printf settings-global-key',
      }),
    );
    const globalResources = await loadPiResources(options);
    const globalContext = await createPiConductorAuthContext(options, globalResources);
    await expect(
      resolvePiConductorApiKey({
        modelRuntime: globalContext.modelRuntime,
        resources: globalResources,
        provider: 'fixture',
        env: {},
      }),
    ).resolves.toBe('settings-global-key');
  });

  it('reports a clear error when a Pi apiKey command cannot be resolved', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-user-'));
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          fixture: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKey: "!sh -c 'exit 7'",
            models: [{ id: 'fixture-model' }],
          },
        },
      }),
    );

    const options = { cwd, pi: { agentDir, projectDir }, env: {} };
    const resources = await loadPiResources(options);
    const context = await createPiConductorAuthContext(options, resources);

    await expect(
      resolvePiConductorApiKey({
        modelRuntime: context.modelRuntime,
        resources,
        provider: 'fixture',
        env: {},
      }),
    ).rejects.toThrow(/Failed to resolve API key for Pi provider "fixture" from shell command/);
  });
});
