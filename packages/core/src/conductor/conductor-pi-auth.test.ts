import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthStorage } from '@earendil-works/pi-coding-agent';
import {
  getPiConductorAuthStatus,
  hasPiConductorAuth,
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

  it('keeps project auth above user AuthStorage while using user auth dynamically', async () => {
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

    const authStorage = AuthStorage.create(join(agentDir, 'auth.json'));
    authStorage.set('anthropic', { type: 'api_key', key: 'user-key' });
    const resources = await loadPiResources({
      cwd,
      pi: { agentDir, projectDir },
    });

    await expect(
      resolvePiConductorApiKey({
        authStorage,
        resources,
        provider: 'anthropic',
      }),
    ).resolves.toBe('project-key');

    await writeFile(join(projectDir, 'auth.json'), JSON.stringify({}));
    const userOnlyResources = await loadPiResources({
      cwd,
      pi: { agentDir, projectDir },
    });
    await expect(
      resolvePiConductorApiKey({
        authStorage,
        resources: userOnlyResources,
        provider: 'anthropic',
      }),
    ).resolves.toBe('user-key');
  });

  it('delegates OAuth login to Pi AuthStorage callbacks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-user-'));
    const login = vi
      .spyOn(AuthStorage.prototype, 'login')
      .mockResolvedValue(undefined);
    const callbacks = {} as Parameters<AuthStorage['login']>[1];

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
    expect(login).toHaveBeenCalledWith('anthropic', callbacks);
  });

  it('asks AuthStorage for the key at request time so OAuth refresh can take effect', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-user-'));
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    const resources = await loadPiResources({
      cwd,
      pi: { agentDir, projectDir },
    });
    const authStorage = AuthStorage.inMemory({
      anthropic: { type: 'api_key', key: 'initial-key' },
    });
    const getApiKey = vi
      .spyOn(authStorage, 'getApiKey')
      .mockResolvedValue('refreshed-key');

    await expect(
      resolvePiConductorApiKey({
        authStorage,
        resources,
        provider: 'anthropic',
      }),
    ).resolves.toBe('refreshed-key');
    expect(getApiKey).toHaveBeenCalledWith('anthropic');
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
    const authStorage = AuthStorage.inMemory({
      anthropic: { type: 'api_key', key: 'user-key' },
    });
    const resources = await loadPiResources({
      cwd,
      pi: { agentDir, projectDir },
    });

    await expect(
      resolvePiConductorApiKey({
        authStorage,
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
    const authStorage = AuthStorage.create(join(agentDir, 'auth.json'));
    authStorage.set('anthropic', { type: 'api_key', key: 'secret-value' });

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
});
