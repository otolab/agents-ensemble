import { chmodSync } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelRuntime,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  createPiConductorAuthContext,
  getPiConductorAuthStatus,
  hasPiConductorAuth,
  hasPiProviderAuth,
  isPiConductorOAuthProvider,
  listPiConductorModels,
  loginPiConductor,
  logoutPiConductor,
  resolvePiConductorApiKey,
  resolvePiConductorProvider,
} from './conductor-pi-auth.js';
import type { PiConductorOAuthLoginCallbacks } from './conductor-pi-auth.js';
import { loadPiResources } from './pi-resource-loader.js';

const PROJECT_FILE_ALIAS_CASES = [
  ['project .ensemble/config.yaml', 'config'],
  ['project Pi settings.json', 'settings'],
  ['project Pi auth.json', 'auth'],
] as const;

const PROJECT_DIRECTORY_ALIAS_CASES = [
  ['project .ensemble directory', 'ensemble'],
  ['configured project Pi directory', 'project-pi'],
] as const;

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
    const authPath = join(agentDir, 'auth.json');
    await writeFile(
      authPath,
      JSON.stringify({ existing: { type: 'api_key', key: 'existing-secret' } }),
    );
    await chmod(authPath, 0o644);
    const originalAuthFile = await stat(authPath);

    const result = await loginPiConductor({
      cwd,
      pi: { agentDir, projectDir },
      apiKey: 'user-secret',
    });

    expect(result).toMatchObject({
      backend: 'pi',
      provider: 'local',
      method: 'api_key',
      authPath,
    });
    const savedAuth = JSON.parse(await readFile(authPath, 'utf8'));
    expect(savedAuth).toMatchObject({
      existing: { type: 'api_key', key: 'existing-secret' },
      local: { type: 'api_key', key: 'user-secret' },
    });
    const savedAuthFile = await stat(authPath);
    await expectPosixPrivateAuthMode(authPath);
    expectDifferentInodes(savedAuthFile.ino, originalAuthFile.ino);
    await expect(readFile(join(projectDir, 'auth.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('separates a hard-linked user auth file before API-key login', async () => {
    const fixture = await createAuthFileFixture('pi-auth-hardlink-api-');
    const projectAuth = JSON.stringify(
      { openai: { type: 'api_key', key: 'shared-project-secret' } },
      null,
      2,
    ) + '\n';
    await writeFile(fixture.projectAuthPath, projectAuth);
    await link(fixture.projectAuthPath, fixture.userAuthPath);
    await chmod(fixture.userAuthPath, 0o600);
    const originalUserFile = await stat(fixture.userAuthPath);

    await expect(
      loginPiConductor({
        cwd: fixture.cwd,
        pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
        apiKey: 'new-user-secret',
      }),
    ).resolves.toMatchObject({ method: 'api_key', authPath: fixture.userAuthPath });

    const [userFile, projectFile] = await Promise.all([
      stat(fixture.userAuthPath),
      stat(fixture.projectAuthPath),
    ]);
    expectSeparatedAuthInodes(userFile, projectFile, originalUserFile.ino);
    expect(JSON.parse(await readFile(fixture.userAuthPath, 'utf8'))).toMatchObject({
      openai: { type: 'api_key', key: 'new-user-secret' },
    });
    await expect(readFile(fixture.projectAuthPath, 'utf8')).resolves.toBe(projectAuth);
    await expectPosixPrivateAuthMode(fixture.userAuthPath);
  });

  it('separates a hard-linked user auth file before OAuth writes credentials', async () => {
    const fixture = await createAuthFileFixture('pi-auth-hardlink-oauth-');
    const projectAuth = JSON.stringify(
      { openai: { type: 'api_key', key: 'shared-project-secret' } },
      null,
      2,
    ) + '\n';
    const oauthAuth = JSON.stringify({
      openai: { type: 'oauth', access: 'new-access', refresh: 'new-refresh', expires: 123 },
    });
    await writeFile(fixture.projectAuthPath, projectAuth);
    await link(fixture.projectAuthPath, fixture.userAuthPath);
    await chmod(fixture.userAuthPath, 0o600);
    const originalUserFile = await stat(fixture.userAuthPath);

    const runtimeAuthPaths: string[] = [];
    const originalCreate = ModelRuntime.create.bind(ModelRuntime);
    vi.spyOn(ModelRuntime, 'create').mockImplementation(async (options) => {
      runtimeAuthPaths.push(options?.authPath ?? '');
      return originalCreate(options);
    });
    const oauthLogin = vi
      .spyOn(ModelRuntime.prototype, 'login')
      .mockImplementation(async () => {
        const runtimeAuthPath = runtimeAuthPaths.at(-1);
        expect(runtimeAuthPath).toBe(await realpath(fixture.userAuthPath));
        const [userFile, projectFile] = await Promise.all([
          stat(fixture.userAuthPath),
          stat(fixture.projectAuthPath),
        ]);
        expectSeparatedAuthInodes(userFile, projectFile, originalUserFile.ino);
        await expectPosixPrivateAuthMode(fixture.userAuthPath);
        await writeFile(runtimeAuthPath!, `${oauthAuth}\n`);
      });

    await expect(
      loginPiConductor({
        cwd: fixture.cwd,
        pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
        oauthCallbacks: createOAuthCallbacks(),
      }),
    ).resolves.toMatchObject({ method: 'oauth', authPath: fixture.userAuthPath });

    expect(oauthLogin).toHaveBeenCalledOnce();
    expect(runtimeAuthPaths).toEqual([await realpath(fixture.userAuthPath)]);
    expect(JSON.parse(await readFile(fixture.userAuthPath, 'utf8'))).toMatchObject({
      openai: { type: 'oauth', access: 'new-access', refresh: 'new-refresh', expires: 123 },
    });
    await expect(readFile(fixture.projectAuthPath, 'utf8')).resolves.toBe(projectAuth);
    await expectPosixPrivateAuthMode(fixture.userAuthPath);
  });

  it('separates a hard-linked user auth file before logout', async () => {
    const fixture = await createAuthFileFixture('pi-auth-hardlink-logout-');
    const projectAuth = JSON.stringify(
      { openai: { type: 'api_key', key: 'shared-project-secret' } },
      null,
      2,
    ) + '\n';
    await writeFile(fixture.projectAuthPath, projectAuth);
    await link(fixture.projectAuthPath, fixture.userAuthPath);
    await chmod(fixture.userAuthPath, 0o600);
    const originalUserFile = await stat(fixture.userAuthPath);

    await expect(
      logoutPiConductor({
        cwd: fixture.cwd,
        pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
      }),
    ).resolves.toMatchObject({ provider: 'openai', authPath: fixture.userAuthPath });

    const [userFile, projectFile] = await Promise.all([
      stat(fixture.userAuthPath),
      stat(fixture.projectAuthPath),
    ]);
    expectSeparatedAuthInodes(userFile, projectFile, originalUserFile.ino);
    expect(JSON.parse(await readFile(fixture.userAuthPath, 'utf8'))).not.toHaveProperty('openai');
    await expect(readFile(fixture.projectAuthPath, 'utf8')).resolves.toBe(projectAuth);
    await expectPosixPrivateAuthMode(fixture.userAuthPath);
  });

  it('refuses a user auth.json symlink into project resources for every write operation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-symlink-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-symlink-user-'));
    const projectDir = join(cwd, '.ensemble', 'pi');
    const projectAuthPath = join(projectDir, 'auth.json');
    const userAuthPath = join(agentDir, 'auth.json');
    const projectAuth = JSON.stringify({
      openai: { type: 'api_key', key: 'project-secret' },
    });
    await mkdir(projectDir, { recursive: true });
    await writeFile(projectAuthPath, projectAuth);
    await symlink(projectAuthPath, userAuthPath);

    await expect(
      loginPiConductor({
        cwd,
        pi: { agentDir, projectDir },
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
        apiKey: 'new-user-secret',
      }),
    ).rejects.toThrow(
      /configured path or a symlink target enters the project Pi resource root or project \.ensemble layer/i,
    );
    const oauthLogin = vi.spyOn(ModelRuntime.prototype, 'login');
    await expect(
      loginPiConductor({
        cwd,
        pi: { agentDir, projectDir },
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
        oauthCallbacks: createOAuthCallbacks(),
      }),
    ).rejects.toThrow(
      /configured path or a symlink target enters the project Pi resource root or project \.ensemble layer/i,
    );
    const logout = vi.spyOn(ModelRuntime.prototype, 'logout');
    await expect(
      logoutPiConductor({
        cwd,
        pi: { agentDir, projectDir },
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
      }),
    ).rejects.toThrow(
      /configured path or a symlink target enters the project Pi resource root or project \.ensemble layer/i,
    );

    expect(oauthLogin).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
    expect(await readlink(userAuthPath)).toBe(projectAuthPath);
    expect((await lstat(userAuthPath)).isSymbolicLink()).toBe(true);
    await expect(readFile(projectAuthPath, 'utf8')).resolves.toBe(projectAuth);
  });

  it.each(['api-key', 'oauth', 'logout'] as const)(
    'refuses a user auth.json symlink to project .ensemble/config.yaml for %s',
    async (operation) => {
      const fixture = await createAuthFileFixture(`pi-auth-project-config-symlink-${operation}-`);
      const projectConfigPath = join(dirname(fixture.projectDir), 'config.yaml');
      const originalProjectConfig = '{"conductor":{"backend":"cursor","model":"project-model"}}\n';
      await writeFile(projectConfigPath, originalProjectConfig);
      await symlink(projectConfigPath, fixture.userAuthPath);

      const oauthLogin = vi.spyOn(ModelRuntime.prototype, 'login').mockResolvedValue(undefined);
      const logout = vi.spyOn(ModelRuntime.prototype, 'logout').mockResolvedValue(undefined);

      await expect(performAuthWriteOperation(operation, fixture)).rejects.toThrow(
        /configured path or a symlink target enters the project Pi resource root or project \.ensemble layer/i,
      );

      expect(oauthLogin).not.toHaveBeenCalled();
      expect(logout).not.toHaveBeenCalled();
      expect((await lstat(fixture.userAuthPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(fixture.userAuthPath)).toBe(projectConfigPath);
      await expect(readFile(projectConfigPath, 'utf8')).resolves.toBe(originalProjectConfig);
    },
  );

  it.each(
    PROJECT_FILE_ALIAS_CASES.flatMap(([name, kind]) =>
      (['api-key', 'oauth', 'logout'] as const).map((operation) => [
        operation,
        name,
        kind,
      ] as const),
    ),
  )(
    'refuses auth write %s when project %s symlinks to the same external file',
    async (operation, _name, kind) => {
      const fixture = await createAuthFileFixture(
        `pi-auth-project-external-file-alias-${kind}-${operation}-`,
      );
      const projectFilePath =
        kind === 'config'
          ? join(dirname(fixture.projectDir), 'config.yaml')
          : kind === 'settings'
            ? join(fixture.projectDir, 'settings.json')
            : fixture.projectAuthPath;
      const originalContents = '{"project":"owned"}\n';
      await writeFile(fixture.externalAuthPath, originalContents);
      await symlink(fixture.externalAuthPath, projectFilePath);
      await symlink(fixture.externalAuthPath, fixture.userAuthPath);

      const oauthLogin = vi
        .spyOn(ModelRuntime.prototype, 'login')
        .mockResolvedValue(undefined);
      const logout = vi
        .spyOn(ModelRuntime.prototype, 'logout')
        .mockResolvedValue(undefined);

      await expect(performAuthWriteOperation(operation, fixture)).rejects.toThrow(
        /configured path or a symlink target enters the project Pi resource root or project \.ensemble layer/i,
      );

      expect(oauthLogin).not.toHaveBeenCalled();
      expect(logout).not.toHaveBeenCalled();
      expect((await lstat(projectFilePath)).isSymbolicLink()).toBe(true);
      expect((await lstat(fixture.userAuthPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(projectFilePath)).toBe(fixture.externalAuthPath);
      expect(await readlink(fixture.userAuthPath)).toBe(fixture.externalAuthPath);
      await expect(readFile(fixture.externalAuthPath, 'utf8')).resolves.toBe(
        originalContents,
      );
    },
  );

  it.each(
    PROJECT_DIRECTORY_ALIAS_CASES.flatMap(([name, projectRootKind]) =>
      (['api-key', 'oauth', 'logout'] as const).map((operation) => [
        operation,
        name,
        projectRootKind,
      ] as const),
    ),
  )(
    'refuses auth write %s when %s links to a directory containing the user target',
    async (operation, _name, projectRootKind) => {
      const fixture = await createProjectDirectoryAliasFixture(
        `pi-auth-project-directory-alias-${projectRootKind}-${operation}-`,
        projectRootKind,
      );
      const originalContents = '{"project":"owned"}\n';
      await writeFile(fixture.externalAuthPath, originalContents);
      await symlink(dirname(fixture.externalAuthPath), fixture.projectLinkPath);
      await symlink(fixture.externalAuthPath, fixture.userAuthPath);

      const oauthLogin = vi
        .spyOn(ModelRuntime.prototype, 'login')
        .mockResolvedValue(undefined);
      const logout = vi
        .spyOn(ModelRuntime.prototype, 'logout')
        .mockResolvedValue(undefined);

      await expect(
        performAuthWriteOperation(operation, fixture),
      ).rejects.toThrow(/resolves to a target linked from either project layer/i);

      expect(oauthLogin).not.toHaveBeenCalled();
      expect(logout).not.toHaveBeenCalled();
      expect((await lstat(fixture.projectLinkPath)).isSymbolicLink()).toBe(true);
      expect((await lstat(fixture.userAuthPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(fixture.projectLinkPath)).toBe(
        dirname(fixture.externalAuthPath),
      );
      expect(await readlink(fixture.userAuthPath)).toBe(fixture.externalAuthPath);
      await expect(readFile(fixture.externalAuthPath, 'utf8')).resolves.toBe(
        originalContents,
      );
    },
  );

  it.each(PROJECT_DIRECTORY_ALIAS_CASES)(
    'rejects OAuth before runtime login when user settings alias a target under %s',
    async (_name, projectRootKind) => {
      const fixture = await createProjectDirectoryAliasFixture(
        `pi-auth-oauth-device-id-directory-alias-${projectRootKind}-`,
        projectRootKind,
      );
      const userSettingsPath = join(fixture.agentDir, 'settings.json');
      const originalContents = '{"project":"owned"}\n';
      await writeFile(fixture.externalAuthPath, originalContents);
      await symlink(dirname(fixture.externalAuthPath), fixture.projectLinkPath);
      await symlink(fixture.externalAuthPath, userSettingsPath);

      const oauthLogin = vi
        .spyOn(ModelRuntime.prototype, 'login')
        .mockResolvedValue(undefined);

      await expect(
        loginPiConductor({
          cwd: fixture.cwd,
          pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
          provider: 'openai',
          modelId: 'gpt-6.1-sol',
          oauthCallbacks: createOAuthCallbacks(),
        }),
      ).rejects.toThrow(
        /Refusing to use Pi user settings\.json .* resolves to a target linked from either project layer/i,
      );

      expect(oauthLogin).not.toHaveBeenCalled();
      expect((await lstat(fixture.projectLinkPath)).isSymbolicLink()).toBe(true);
      expect((await lstat(userSettingsPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(userSettingsPath)).toBe(fixture.externalAuthPath);
      await expect(readFile(fixture.externalAuthPath, 'utf8')).resolves.toBe(
        originalContents,
      );
    },
  );

  it.each(PROJECT_FILE_ALIAS_CASES)(
    'rejects OAuth before runtime login when user settings alias the target of %s',
    async (_name, kind) => {
      const fixture = await createAuthFileFixture(
        `pi-auth-oauth-device-id-project-alias-${kind}-`,
      );
      const projectFilePath =
        kind === 'config'
          ? join(dirname(fixture.projectDir), 'config.yaml')
          : kind === 'settings'
            ? join(fixture.projectDir, 'settings.json')
            : fixture.projectAuthPath;
      const userSettingsPath = join(fixture.agentDir, 'settings.json');
      const originalContents = '{"project":"owned"}\n';
      await writeFile(fixture.externalAuthPath, originalContents);
      await symlink(fixture.externalAuthPath, projectFilePath);
      await symlink(fixture.externalAuthPath, userSettingsPath);

      const oauthLogin = vi
        .spyOn(ModelRuntime.prototype, 'login')
        .mockResolvedValue(undefined);

      await expect(
        loginPiConductor({
          cwd: fixture.cwd,
          pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
          provider: 'openai',
          modelId: 'gpt-6.1-sol',
          oauthCallbacks: createOAuthCallbacks(),
        }),
      ).rejects.toThrow(
        /Refusing to use Pi user settings\.json .* project Pi resource root or project \.ensemble layer/i,
      );

      expect(oauthLogin).not.toHaveBeenCalled();
      expect((await lstat(projectFilePath)).isSymbolicLink()).toBe(true);
      expect((await lstat(userSettingsPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(projectFilePath)).toBe(fixture.externalAuthPath);
      expect(await readlink(userSettingsPath)).toBe(fixture.externalAuthPath);
      await expect(readFile(fixture.externalAuthPath, 'utf8')).resolves.toBe(
        originalContents,
      );
    },
  );

  it.each(['api-key', 'oauth', 'logout'] as const)(
    'protects an external symlink target under a configured project Pi root during %s',
    async (operation) => {
      const fixture = await createAuthFileFixture(
        `pi-auth-custom-project-root-external-alias-${operation}-`,
      );
      const projectDir = join(fixture.cwd, 'project-resources', 'pi');
      const projectAuthPath = join(projectDir, 'auth.json');
      const originalContents = '{"project":"owned"}\n';
      await mkdir(projectDir, { recursive: true });
      await writeFile(fixture.externalAuthPath, originalContents);
      await symlink(fixture.externalAuthPath, projectAuthPath);
      await symlink(fixture.externalAuthPath, fixture.userAuthPath);

      const oauthLogin = vi
        .spyOn(ModelRuntime.prototype, 'login')
        .mockResolvedValue(undefined);
      const logout = vi
        .spyOn(ModelRuntime.prototype, 'logout')
        .mockResolvedValue(undefined);

      await expect(
        performAuthWriteOperation(operation, {
          cwd: fixture.cwd,
          agentDir: fixture.agentDir,
          projectDir,
        }),
      ).rejects.toThrow(
        /configured path or a symlink target enters the project Pi resource root or project \.ensemble layer/i,
      );

      expect(oauthLogin).not.toHaveBeenCalled();
      expect(logout).not.toHaveBeenCalled();
      expect(await readlink(projectAuthPath)).toBe(fixture.externalAuthPath);
      expect(await readlink(fixture.userAuthPath)).toBe(fixture.externalAuthPath);
      await expect(readFile(fixture.externalAuthPath, 'utf8')).resolves.toBe(
        originalContents,
      );
    },
  );

  it.each(['api-key', 'oauth', 'logout'] as const)(
    'keeps project .ensemble/config.yaml unchanged when user auth is hard-linked to it during %s',
    async (operation) => {
      const fixture = await createAuthFileFixture(`pi-auth-project-config-hardlink-${operation}-`);
      const projectConfigPath = join(dirname(fixture.projectDir), 'config.yaml');
      const originalProjectConfig =
        '{"conductor":{"backend":"cursor"},"projectMarker":"project-owned"}\n';
      await writeFile(projectConfigPath, originalProjectConfig);
      await link(projectConfigPath, fixture.userAuthPath);
      const originalProjectFile = await stat(projectConfigPath);
      expect((await stat(fixture.userAuthPath)).nlink).toBe(2);

      const assertProjectFileDetached = async () => {
        const [userFile, projectFile] = await Promise.all([
          stat(fixture.userAuthPath),
          stat(projectConfigPath),
        ]);
        expectSeparatedAuthInodes(userFile, projectFile, originalProjectFile.ino);
        await expect(readFile(projectConfigPath, 'utf8')).resolves.toBe(originalProjectConfig);
      };
      const oauthLogin = vi
        .spyOn(ModelRuntime.prototype, 'login')
        .mockImplementation(assertProjectFileDetached);
      const logout = vi
        .spyOn(ModelRuntime.prototype, 'logout')
        .mockImplementation(assertProjectFileDetached);

      await expect(performAuthWriteOperation(operation, fixture)).resolves.toBeDefined();

      expect(oauthLogin).toHaveBeenCalledTimes(operation === 'oauth' ? 1 : 0);
      expect(logout).toHaveBeenCalledTimes(operation === 'logout' ? 1 : 0);
      await assertProjectFileDetached();
      if (operation === 'api-key') {
        expect(JSON.parse(await readFile(fixture.userAuthPath, 'utf8'))).toMatchObject({
          openai: { type: 'api_key', key: 'case-alias-api-key' },
        });
      }
    },
  );

  it.each(['api-key', 'oauth', 'logout'] as const)(
    'protects project .ensemble from a case-only user auth root alias during %s',
    async (operation) => {
      const fixture = await createAuthFileFixture(`pi-auth-project-ensemble-case-alias-${operation}-`);
      const projectEnsembleDir = dirname(fixture.projectDir);
      const projectConfigPath = join(projectEnsembleDir, 'config.yaml');
      const agentDir = join(fixture.cwd, '.Ensemble', 'user-pi');
      const userAuthPath = join(agentDir, 'auth.json');
      const originalProjectConfig = '{"conductor":{"backend":"cursor"}}\n';
      await writeFile(projectConfigPath, originalProjectConfig);

      const caseInsensitiveVolume = await directoryPathIsCaseInsensitive(projectEnsembleDir);
      const oauthLogin = vi.spyOn(ModelRuntime.prototype, 'login').mockResolvedValue(undefined);
      const logout = vi.spyOn(ModelRuntime.prototype, 'logout').mockResolvedValue(undefined);

      if (caseInsensitiveVolume) {
        await expect(
          performAuthWriteOperation(operation, {
            cwd: fixture.cwd,
            agentDir,
            projectDir: fixture.projectDir,
          }),
        ).rejects.toThrow(
          /configured path or a symlink target enters the project Pi resource root or project \.ensemble layer/i,
        );
        expect(oauthLogin).not.toHaveBeenCalled();
        expect(logout).not.toHaveBeenCalled();
        await expect(stat(userAuthPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(projectConfigPath, 'utf8')).resolves.toBe(originalProjectConfig);
        return;
      }

      await expect(
        performAuthWriteOperation(operation, {
          cwd: fixture.cwd,
          agentDir,
          projectDir: fixture.projectDir,
        }),
      ).resolves.toBeDefined();
      await expect(stat(userAuthPath)).resolves.toBeDefined();
      await expect(readFile(projectConfigPath, 'utf8')).resolves.toBe(originalProjectConfig);
      expect(oauthLogin).toHaveBeenCalledTimes(operation === 'oauth' ? 1 : 0);
      expect(logout).toHaveBeenCalledTimes(operation === 'logout' ? 1 : 0);
    },
  );

  it.each(['api-key', 'oauth', 'logout'] as const)(
    'refuses a project-resident auth.json path that symlinks outward for %s',
    async (operation) => {
      const baseDir = await mkdtemp(join(tmpdir(), `pi-auth-project-outward-${operation}-`));
      const cwd = join(baseDir, 'project');
      const projectDir = join(cwd, '.ensemble', 'pi');
      const agentDir = join(projectDir, 'user');
      const externalAuthPath = join(baseDir, 'external', 'auth.json');
      const userAuthPath = join(agentDir, 'auth.json');
      const originalAuth = '{"openai":{"type":"api_key","key":"external-secret"}}\n';
      await mkdir(agentDir, { recursive: true });
      await mkdir(join(baseDir, 'external'), { recursive: true });
      await writeFile(externalAuthPath, originalAuth);
      await symlink(externalAuthPath, userAuthPath);

      const oauthLogin = vi
        .spyOn(ModelRuntime.prototype, 'login')
        .mockResolvedValue(undefined);
      const logout = vi
        .spyOn(ModelRuntime.prototype, 'logout')
        .mockResolvedValue(undefined);

      await expect(
        performAuthWriteOperation(operation, { cwd, agentDir, projectDir }),
      ).rejects.toThrow(
        /configured path or a symlink target enters the project Pi resource root or project \.ensemble layer/i,
      );

      expect(oauthLogin).not.toHaveBeenCalled();
      expect(logout).not.toHaveBeenCalled();
      expect(await readlink(userAuthPath)).toBe(externalAuthPath);
      await expect(readFile(externalAuthPath, 'utf8')).resolves.toBe(originalAuth);
    },
  );

  it('preserves an external auth.json symlink during API-key login', async () => {
    const fixture = await createAuthFileFixture('pi-auth-external-symlink-api-');
    const projectAuth = '{"project-marker":"leave untouched"}\n';
    const originalExternalAuth = '{"existing":{"type":"api_key","key":"old-secret"}}\n';
    await writeFile(fixture.projectAuthPath, projectAuth);
    await writeFile(fixture.externalAuthPath, originalExternalAuth);
    await chmod(fixture.externalAuthPath, 0o644);
    await symlink(fixture.externalAuthPath, fixture.userAuthPath);

    await expect(
      loginPiConductor({
        cwd: fixture.cwd,
        pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
        apiKey: 'new-user-secret',
      }),
    ).resolves.toMatchObject({ method: 'api_key', authPath: fixture.userAuthPath });

    expect(JSON.parse(await readFile(fixture.externalAuthPath, 'utf8'))).toMatchObject({
      existing: { type: 'api_key', key: 'old-secret' },
      openai: { type: 'api_key', key: 'new-user-secret' },
    });
    expect((await lstat(fixture.userAuthPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(fixture.userAuthPath)).toBe(fixture.externalAuthPath);
    await expect(readFile(fixture.projectAuthPath, 'utf8')).resolves.toBe(projectAuth);
    await expectPosixPrivateAuthMode(fixture.externalAuthPath);
  });

  it('preserves and secures an external auth.json symlink before OAuth login', async () => {
    const fixture = await createAuthFileFixture('pi-auth-external-symlink-oauth-');
    const projectAuth = '{"project-marker":"leave untouched"}\n';
    const originalExternalAuth = '{"existing":{"type":"api_key","key":"old-secret"}}\n';
    const oauthAuth = JSON.stringify({
      openai: { type: 'oauth', access: 'new-access', refresh: 'new-refresh', expires: 123 },
    });
    await writeFile(fixture.projectAuthPath, projectAuth);
    await writeFile(fixture.externalAuthPath, originalExternalAuth);
    await chmod(fixture.externalAuthPath, 0o644);
    await symlink(fixture.externalAuthPath, fixture.userAuthPath);

    const runtimeAuthPaths: string[] = [];
    const originalCreate = ModelRuntime.create.bind(ModelRuntime);
    vi.spyOn(ModelRuntime, 'create').mockImplementation(async (options) => {
      runtimeAuthPaths.push(options?.authPath ?? '');
      return originalCreate(options);
    });
    const oauthLogin = vi
      .spyOn(ModelRuntime.prototype, 'login')
      .mockImplementation(async () => {
        const runtimeAuthPath = runtimeAuthPaths.at(-1);
        expect(runtimeAuthPath).toBe(await realpath(fixture.externalAuthPath));
        await expectPosixPrivateAuthMode(fixture.externalAuthPath);
        await writeFile(runtimeAuthPath!, `${oauthAuth}\n`);
      });

    await expect(
      loginPiConductor({
        cwd: fixture.cwd,
        pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
        oauthCallbacks: createOAuthCallbacks(),
      }),
    ).resolves.toMatchObject({ method: 'oauth', authPath: fixture.userAuthPath });

    expect(oauthLogin).toHaveBeenCalledOnce();
    expect(runtimeAuthPaths).toEqual([await realpath(fixture.externalAuthPath)]);
    expect(JSON.parse(await readFile(fixture.externalAuthPath, 'utf8'))).toMatchObject({
      openai: { type: 'oauth', access: 'new-access', refresh: 'new-refresh', expires: 123 },
    });
    expect((await lstat(fixture.userAuthPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(fixture.userAuthPath)).toBe(fixture.externalAuthPath);
    await expect(readFile(fixture.projectAuthPath, 'utf8')).resolves.toBe(projectAuth);
    await expectPosixPrivateAuthMode(fixture.externalAuthPath);
  });

  it('preserves an external auth.json symlink during logout', async () => {
    const fixture = await createAuthFileFixture('pi-auth-external-symlink-logout-');
    const projectAuth = '{"project-marker":"leave untouched"}\n';
    const originalExternalAuth = JSON.stringify({
      openai: { type: 'api_key', key: 'user-secret' },
      other: { type: 'api_key', key: 'other-secret' },
    });
    await writeFile(fixture.projectAuthPath, projectAuth);
    await writeFile(fixture.externalAuthPath, `${originalExternalAuth}\n`);
    await symlink(fixture.externalAuthPath, fixture.userAuthPath);

    await expect(
      logoutPiConductor({
        cwd: fixture.cwd,
        pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
      }),
    ).resolves.toMatchObject({ authPath: fixture.userAuthPath, provider: 'openai' });

    expect(JSON.parse(await readFile(fixture.externalAuthPath, 'utf8'))).toEqual({
      other: { type: 'api_key', key: 'other-secret' },
    });
    expect((await lstat(fixture.userAuthPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(fixture.userAuthPath)).toBe(fixture.externalAuthPath);
    await expect(readFile(fixture.projectAuthPath, 'utf8')).resolves.toBe(projectAuth);
    await expectPosixPrivateAuthMode(fixture.externalAuthPath);
  });

  it('refuses a user auth path inside the project resource root before creating it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-project-root-'));
    const projectDir = join(cwd, '.ensemble', 'pi');
    const agentDir = join(projectDir, 'user');
    await mkdir(projectDir, { recursive: true });

    await expect(
      loginPiConductor({
        cwd,
        pi: { agentDir, projectDir },
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
        apiKey: 'new-user-secret',
      }),
    ).rejects.toThrow(
      /configured path or a symlink target enters the project Pi resource root or project \.ensemble layer/i,
    );

    await expect(stat(agentDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(projectDir, 'auth.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each(['api-key', 'oauth', 'logout'] as const)(
    'protects a missing project Pi root against a case-only user path alias during %s',
    async (operation) => {
      const cwd = await mkdtemp(join(tmpdir(), `pi-auth-case-alias-${operation}-`));
      const projectParent = join(cwd, 'project-resources');
      const projectDir = join(projectParent, 'pi');
      const agentDir = join(projectParent, 'Pi');
      await mkdir(projectParent, { recursive: true });
      const caseInsensitiveVolume = await directoryPathIsCaseInsensitive(projectParent);

      const oauthLogin = vi
        .spyOn(ModelRuntime.prototype, 'login')
        .mockResolvedValue(undefined);
      const logout = vi
        .spyOn(ModelRuntime.prototype, 'logout')
        .mockResolvedValue(undefined);

      if (caseInsensitiveVolume) {
        await expect(
          performAuthWriteOperation(operation, { cwd, agentDir, projectDir }),
        ).rejects.toThrow(
          /configured path or a symlink target enters the project Pi resource root or project \.ensemble layer/i,
        );
        expect(oauthLogin).not.toHaveBeenCalled();
        expect(logout).not.toHaveBeenCalled();
        await expect(stat(agentDir)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(projectDir)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(join(projectDir, 'auth.json'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        return;
      }

      const result = await performAuthWriteOperation(operation, { cwd, agentDir, projectDir });
      if (operation === 'api-key') expect(result).toMatchObject({ method: 'api_key' });
      if (operation === 'oauth') expect(result).toMatchObject({ method: 'oauth' });
      if (operation === 'logout') expect(result).toMatchObject({ provider: 'openai' });
      if (operation === 'oauth') expect(oauthLogin).toHaveBeenCalledOnce();
      if (operation === 'logout') expect(logout).toHaveBeenCalledOnce();
      await expect(stat(join(agentDir, 'auth.json'))).resolves.toBeDefined();
      await expect(stat(projectDir)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('stores an explicitly selected API key for an OAuth-capable provider', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-openai-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-openai-user-'));
    const projectDir = join(cwd, '.ensemble', 'pi');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-6.1-sol' }),
    );

    const options = {
      cwd,
      pi: { agentDir, projectDir },
      provider: 'openai',
      modelId: 'gpt-6.1-sol',
    };
    await expect(isPiConductorOAuthProvider(options)).resolves.toBe(true);

    const result = await loginPiConductor({
      ...options,
      apiKey: 'openai-user-secret',
    });

    expect(result).toMatchObject({
      backend: 'pi',
      provider: 'openai',
      method: 'api_key',
      authPath: join(agentDir, 'auth.json'),
    });
    await expect(readFile(join(agentDir, 'auth.json'), 'utf8')).resolves.toContain(
      'openai-user-secret',
    );
    await expectPosixPrivateAuthMode(join(agentDir, 'auth.json'));
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

  it('provides a persistent device ID to Pi OAuth login', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-user-'));
    const deviceIds: string[] = [];
    const login = vi
      .spyOn(ModelRuntime.prototype, 'login')
      .mockImplementation(async (_provider, _method, _interaction, loginOptions) => {
        if (!loginOptions?.getDeviceId) {
          throw new Error('OAuth login did not receive getDeviceId');
        }
        deviceIds.push(await loginOptions.getDeviceId());
      });
    const callbacks = {
      onAuth: vi.fn(),
      onDeviceCode: vi.fn(),
      onPrompt: vi.fn().mockResolvedValue('answer'),
      onSelect: vi.fn().mockResolvedValue('option'),
    };

    const options = {
      cwd,
      pi: { agentDir },
      provider: 'openai',
      oauthCallbacks: callbacks,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(loginPiConductor(options)).resolves.toMatchObject({
        backend: 'pi',
        provider: 'openai',
        method: 'oauth',
      });
    }

    expect(login).toHaveBeenCalledTimes(2);
    expect(login).toHaveBeenCalledWith(
      'openai',
      'oauth',
      expect.objectContaining({ prompt: expect.any(Function), notify: expect.any(Function) }),
      expect.objectContaining({ getDeviceId: expect.any(Function) }),
    );
    expect(deviceIds).toHaveLength(2);
    expect(deviceIds[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(deviceIds[1]).toBe(deviceIds[0]);
    const settings = JSON.parse(
      await readFile(join(agentDir, 'settings.json'), 'utf8'),
    ) as { deviceId?: string };
    expect(settings.deviceId).toBe(deviceIds[0]);
  });

  it('bridges Pi OAuth URL, device-code, manual-code, secret, and selection prompts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-interaction-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-interaction-user-'));
    const manualCodeSignal = new AbortController().signal;
    const secretSignal = new AbortController().signal;
    const selectSignal = new AbortController().signal;
    const promptResponses: unknown[] = [];
    const callbacks: PiConductorOAuthLoginCallbacks = {
      onAuth: vi.fn(),
      onDeviceCode: vi.fn(),
      onProgress: vi.fn(),
      onManualCodeInput: vi.fn().mockResolvedValue('pasted-authorization-code'),
      onPrompt: vi.fn().mockResolvedValue('provider-secret'),
      onSelect: vi.fn().mockResolvedValue('chatgpt'),
    };
    const login = vi
      .spyOn(ModelRuntime.prototype, 'login')
      .mockImplementation(async (_provider, _method, interaction) => {
        interaction.notify({
          type: 'auth_url',
          url: 'https://auth.example.test/authorize?state=copyable',
          instructions: 'Open this URL on a device with a browser.',
        });
        interaction.notify({
          type: 'device_code',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://auth.example.test/device',
          intervalSeconds: 5,
          expiresInSeconds: 300,
        });
        interaction.notify({ type: 'progress', message: 'Waiting for authorization.' });

        promptResponses.push(
          await interaction.prompt({
            type: 'manual_code',
            message: 'Paste the authorization code',
            placeholder: 'authorization code',
            signal: manualCodeSignal,
          }),
          await interaction.prompt({
            type: 'secret',
            message: 'Enter provider secret',
            placeholder: 'secret',
            signal: secretSignal,
          }),
          await interaction.prompt({
            type: 'select',
            message: 'Choose a login method',
            options: [
              { id: 'chatgpt', label: 'ChatGPT account' },
              { id: 'api-key', label: 'API key' },
            ],
            signal: selectSignal,
          }),
        );
      });

    await expect(
      loginPiConductor({
        cwd,
        pi: { agentDir },
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
        oauthCallbacks: callbacks,
      }),
    ).resolves.toMatchObject({
      backend: 'pi',
      provider: 'openai',
      method: 'oauth',
    });

    expect(callbacks.onAuth).toHaveBeenCalledWith({
      url: 'https://auth.example.test/authorize?state=copyable',
      instructions: 'Open this URL on a device with a browser.',
    });
    expect(callbacks.onDeviceCode).toHaveBeenCalledWith({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.example.test/device',
      intervalSeconds: 5,
      expiresInSeconds: 300,
    });
    expect(callbacks.onProgress).toHaveBeenCalledWith('Waiting for authorization.');
    expect(callbacks.onManualCodeInput).toHaveBeenCalledWith({
      message: 'Paste the authorization code',
      placeholder: 'authorization code',
      signal: manualCodeSignal,
    });
    expect(callbacks.onPrompt).toHaveBeenCalledWith({
      type: 'secret',
      message: 'Enter provider secret',
      placeholder: 'secret',
      signal: secretSignal,
    });
    expect(callbacks.onSelect).toHaveBeenCalledWith({
      message: 'Choose a login method',
      options: [
        { id: 'chatgpt', label: 'ChatGPT account' },
        { id: 'api-key', label: 'API key' },
      ],
      signal: selectSignal,
    });
    expect(promptResponses).toEqual([
      'pasted-authorization-code',
      'provider-secret',
      'chatgpt',
    ]);
    expect(login).toHaveBeenCalledOnce();
  });

  it('reuses the persisted device ID across concurrent OpenAI OAuth logins', async () => {
    const fixture = await createAuthFileFixture(
      'pi-auth-concurrent-device-id-',
    );
    const deviceIds: string[] = [];
    const login = vi
      .spyOn(ModelRuntime.prototype, 'login')
      .mockImplementation(async (_provider, _method, _interaction, loginOptions) => {
        const deviceId = loginOptions?.getDeviceId?.();
        if (!deviceId) throw new Error('OAuth login did not receive getDeviceId');
        deviceIds.push(deviceId);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    const options = {
      cwd: fixture.cwd,
      pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
      provider: 'openai',
      modelId: 'gpt-6.1-sol',
      oauthCallbacks: createOAuthCallbacks(),
    };

    const results = await Promise.all([
      loginPiConductor(options),
      loginPiConductor(options),
    ]);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).toMatchObject({ method: 'oauth', provider: 'openai' });
    }
    expect(deviceIds).toHaveLength(2);
    expect(deviceIds[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(deviceIds[1]).toBe(deviceIds[0]);

    await expect(loginPiConductor(options)).resolves.toMatchObject({
      method: 'oauth',
      provider: 'openai',
    });
    expect(deviceIds[2]).toBe(deviceIds[0]);
    const settings = JSON.parse(
      await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'),
    ) as { deviceId?: string };
    expect(settings.deviceId).toBe(deviceIds[0]);
  });

  it.skipIf(process.platform === 'win32')(
    'preserves read-only user settings during Anthropic OAuth',
    async () => {
      const fixture = await createAuthFileFixture(
        'pi-auth-anthropic-readonly-settings-',
      );
      const userSettingsPath = join(fixture.agentDir, 'settings.json');
      const externalSettingsPath = join(
        dirname(fixture.externalAuthPath),
        'settings.json',
      );
      const originalSettings = '{"custom":"keep"}\n';
      await writeFile(externalSettingsPath, originalSettings);
      await chmod(externalSettingsPath, 0o400);
      await symlink(externalSettingsPath, userSettingsPath);

      const createSettingsManager = vi.spyOn(SettingsManager, 'create');
      const getOrCreateDeviceId = vi.spyOn(
        SettingsManager.prototype,
        'getOrCreateDeviceId',
      );
      const login = vi
        .spyOn(ModelRuntime.prototype, 'login')
        .mockResolvedValue(undefined);

      await expect(
        loginPiConductor({
          cwd: fixture.cwd,
          pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
          provider: 'anthropic',
          oauthCallbacks: createOAuthCallbacks(),
        }),
      ).resolves.toMatchObject({
        backend: 'pi',
        provider: 'anthropic',
        method: 'oauth',
      });

      expect(login).toHaveBeenCalledOnce();
      expect(login.mock.calls[0]?.[3]?.getDeviceId).toBeUndefined();
      expect(createSettingsManager).not.toHaveBeenCalled();
      expect(getOrCreateDeviceId).not.toHaveBeenCalled();
      expect((await lstat(userSettingsPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(userSettingsPath)).toBe(externalSettingsPath);
      expect((await stat(externalSettingsPath)).mode & 0o777).toBe(0o400);
      await expect(readFile(externalSettingsPath, 'utf8')).resolves.toBe(
        originalSettings,
      );
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'does not report OAuth login success when saving the device ID fails',
    async () => {
      const fixture = await createAuthFileFixture('pi-auth-device-id-save-failure-');
      const userSettingsPath = join(fixture.agentDir, 'settings.json');
      const originalSettings = JSON.stringify({
        defaultProvider: 'openai',
        defaultModel: 'gpt-6.1-sol',
      }, null, 2) + '\n';
      await writeFile(userSettingsPath, originalSettings);
      await chmod(userSettingsPath, 0o600);

      const originalGetOrCreateDeviceId =
        SettingsManager.prototype.getOrCreateDeviceId;
      const failDeviceIdWrite = vi
        .spyOn(SettingsManager.prototype, 'getOrCreateDeviceId')
        .mockImplementation(function (this: SettingsManager) {
          // The OAuth path safety check has already run. Make the queued Pi write
          // fail so this exercises SettingsManager.flush()/drainErrors().
          chmodSync(userSettingsPath, 0o400);
          return originalGetOrCreateDeviceId.call(this);
        });
      const deviceIds: string[] = [];
      const login = vi
        .spyOn(ModelRuntime.prototype, 'login')
        .mockImplementation(async (_provider, _method, _interaction, loginOptions) => {
          const getDeviceId = loginOptions?.getDeviceId;
          if (!getDeviceId) throw new Error('OAuth login did not receive getDeviceId');
          deviceIds.push(await getDeviceId());
        });
      const options = {
        cwd: fixture.cwd,
        pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
        oauthCallbacks: createOAuthCallbacks(),
      };

      try {
        await expect(loginPiConductor(options)).rejects.toThrow(
          /Failed to persist the Pi OAuth device ID.*login was not started/i,
        );
      } finally {
        await chmod(userSettingsPath, 0o600);
        failDeviceIdWrite.mockRestore();
      }

      expect(login).not.toHaveBeenCalled();
      expect(deviceIds).toEqual([]);
      await expect(readFile(userSettingsPath, 'utf8')).resolves.toBe(originalSettings);

      await expect(loginPiConductor(options)).resolves.toMatchObject({
        method: 'oauth',
        authPath: fixture.userAuthPath,
      });
      await expect(loginPiConductor(options)).resolves.toMatchObject({
        method: 'oauth',
        authPath: fixture.userAuthPath,
      });

      expect(login).toHaveBeenCalledTimes(2);
      expect(deviceIds).toHaveLength(2);
      expect(deviceIds[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(deviceIds[1]).toBe(deviceIds[0]);
      expect(JSON.parse(await readFile(userSettingsPath, 'utf8'))).toMatchObject({
        defaultProvider: 'openai',
        defaultModel: 'gpt-6.1-sol',
        deviceId: deviceIds[0],
      });
    },
  );

  it('preserves an independent external settings.json symlink during OAuth device-ID save', async () => {
    const fixture = await createAuthFileFixture('pi-auth-device-id-settings-external-link-');
    const userSettingsPath = join(fixture.agentDir, 'settings.json');
    const originalSettings =
      '{"apiKeys":{"openai":"existing-user-key"},"custom":"keep"}\n';
    await writeFile(fixture.externalAuthPath, originalSettings);
    await chmod(fixture.externalAuthPath, 0o644);
    await symlink(fixture.externalAuthPath, userSettingsPath);
    const login = vi
      .spyOn(ModelRuntime.prototype, 'login')
      .mockImplementation(async (_provider, _method, _interaction, loginOptions) => {
        expect(loginOptions?.getDeviceId?.()).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      });

    await expect(
      loginPiConductor({
        cwd: fixture.cwd,
        pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
        oauthCallbacks: createOAuthCallbacks(),
      }),
    ).resolves.toMatchObject({ method: 'oauth', authPath: fixture.userAuthPath });

    expect(login).toHaveBeenCalledOnce();
    expect((await lstat(userSettingsPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(userSettingsPath)).toBe(fixture.externalAuthPath);
    expect(JSON.parse(await readFile(fixture.externalAuthPath, 'utf8'))).toMatchObject({
      apiKeys: { openai: 'existing-user-key' },
      custom: 'keep',
      deviceId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
    await expectPosixPrivateAuthMode(fixture.externalAuthPath);
    await expect(readFile(fixture.projectAuthPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not replace a single-link settings.json for mode bits in the simulated Windows branch', async () => {
    const fixture = await createAuthFileFixture('pi-auth-device-id-settings-windows-mode-');
    const userSettingsPath = join(fixture.agentDir, 'settings.json');
    await writeFile(userSettingsPath, '{"custom":"keep"}\n');
    await chmod(userSettingsPath, 0o644);
    const originalSettings = await stat(userSettingsPath);
    let settingsInodeAtLogin: number | undefined;

    const login = vi
      .spyOn(ModelRuntime.prototype, 'login')
      .mockImplementation(async (_provider, _method, _interaction, loginOptions) => {
        settingsInodeAtLogin = (await stat(userSettingsPath)).ino;
        expect(loginOptions?.getDeviceId?.()).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      });

    await withProcessPlatform('win32', async () => {
      await expect(
        loginPiConductor({
          cwd: fixture.cwd,
          pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
          provider: 'openai',
          modelId: 'gpt-6.1-sol',
          oauthCallbacks: createOAuthCallbacks(),
        }),
      ).resolves.toMatchObject({ method: 'oauth' });
    });

    expect(login).toHaveBeenCalledOnce();
    expectSameInodes(settingsInodeAtLogin, originalSettings.ino);
    expectSameInodes((await stat(userSettingsPath)).ino, originalSettings.ino);
    // This simulates only the process.platform branch; it does not test Windows ACL behavior.
  });

  it('separates a hard-linked user settings.json before OAuth writes the device ID', async () => {
    const fixture = await createAuthFileFixture('pi-auth-device-id-settings-hardlink-');
    const projectSettingsPath = join(fixture.projectDir, 'settings.json');
    const userSettingsPath = join(fixture.agentDir, 'settings.json');
    const originalProjectSettings =
      '{"defaultProvider":"openai","defaultModel":"gpt-6.1-sol","projectMarker":"owned"}\n';
    await writeFile(projectSettingsPath, originalProjectSettings);
    await link(projectSettingsPath, userSettingsPath);
    const originalProjectFile = await stat(projectSettingsPath);
    expect((await stat(userSettingsPath)).nlink).toBe(2);

    const login = vi
      .spyOn(ModelRuntime.prototype, 'login')
      .mockImplementation(async (_provider, _method, _interaction, loginOptions) => {
        const [userSettings, projectSettings] = await Promise.all([
          stat(userSettingsPath),
          stat(projectSettingsPath),
        ]);
        expect(userSettings.nlink).toBe(1);
        expect(projectSettings.nlink).toBe(1);
        expectDifferentInodes(userSettings.ino, projectSettings.ino);
        expectDifferentInodes(userSettings.ino, originalProjectFile.ino);
        expect(projectSettings.ino).toBe(originalProjectFile.ino);
        expect(await readFile(projectSettingsPath, 'utf8')).toBe(
          originalProjectSettings,
        );
        const deviceId = loginOptions?.getDeviceId?.();
        expect(deviceId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      });

    await expect(
      loginPiConductor({
        cwd: fixture.cwd,
        pi: { agentDir: fixture.agentDir, projectDir: fixture.projectDir },
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
        oauthCallbacks: createOAuthCallbacks(),
      }),
    ).resolves.toMatchObject({ method: 'oauth', authPath: fixture.userAuthPath });

    expect(login).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(userSettingsPath, 'utf8'))).toMatchObject({
      deviceId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
      projectMarker: 'owned',
    });
    await expect(readFile(projectSettingsPath, 'utf8')).resolves.toBe(
      originalProjectSettings,
    );
  });

  it('applies platform-appropriate protection before Pi OAuth can write credentials', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-auth-oauth-permissions-project-'));
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-auth-oauth-permissions-user-'));
    const authPath = join(agentDir, 'auth.json');
    const originalAuth = JSON.stringify({
      openai: { type: 'api_key', key: 'existing-secret' },
    });
    await writeFile(authPath, originalAuth);
    await chmod(authPath, 0o644);
    const originalAuthFile = await stat(authPath);
    let modeAtLogin: number | undefined;
    let inodeAtLogin: number | undefined;
    const login = vi
      .spyOn(ModelRuntime.prototype, 'login')
      .mockImplementation(async () => {
        const authFile = await stat(authPath);
        modeAtLogin = authFile.mode & 0o777;
        inodeAtLogin = authFile.ino;
      });
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
        provider: 'openai',
        oauthCallbacks: callbacks,
      }),
    ).resolves.toMatchObject({ provider: 'openai', method: 'oauth' });

    if (process.platform === 'win32') {
      expectSameInodes(inodeAtLogin, originalAuthFile.ino);
    } else {
      expect(modeAtLogin).toBe(0o600);
      expectDifferentInodes(inodeAtLogin, originalAuthFile.ino);
    }
    await expectPosixPrivateAuthMode(authPath);
    expect(await readFile(authPath, 'utf8')).toBe(originalAuth);
  });

  it.each(['oauth', 'logout'] as const)(
    'does not replace an ordinary auth.json for Windows mode bits during %s',
    async (operation) => {
      const fixture = await createAuthFileFixture(`pi-auth-win32-mode-${operation}-`);
      const originalAuth = JSON.stringify({
        openai: { type: 'api_key', key: 'existing-secret' },
      });
      await writeFile(fixture.userAuthPath, originalAuth);
      await chmod(fixture.userAuthPath, 0o666);
      const originalAuthFile = await stat(fixture.userAuthPath);
      expect(originalAuthFile.mode & 0o777).not.toBe(0o600);

      const oauthLogin = vi
        .spyOn(ModelRuntime.prototype, 'login')
        .mockResolvedValue(undefined);
      const logout = vi
        .spyOn(ModelRuntime.prototype, 'logout')
        .mockResolvedValue(undefined);

      await withProcessPlatform('win32', async () => {
        await performAuthWriteOperation(operation, fixture);
      });

      const authFileAfter = await stat(fixture.userAuthPath);
      expectSameInodes(authFileAfter.ino, originalAuthFile.ino);
      expect(authFileAfter.nlink).toBe(1);
      expect(authFileAfter.mode & 0o777).toBe(originalAuthFile.mode & 0o777);
      expect(await readFile(fixture.userAuthPath, 'utf8')).toBe(originalAuth);
      if (operation === 'oauth') expect(oauthLogin).toHaveBeenCalledOnce();
      else expect(logout).toHaveBeenCalledOnce();
    },
  );

  it.each(['oauth', 'logout'] as const)(
    'still separates a project hardlink before Windows-mode %s',
    async (operation) => {
      const fixture = await createAuthFileFixture(`pi-auth-win32-hardlink-${operation}-`);
      const projectAuth = JSON.stringify({
        openai: { type: 'api_key', key: 'shared-project-secret' },
      }) + '\n';
      await writeFile(fixture.projectAuthPath, projectAuth);
      await link(fixture.projectAuthPath, fixture.userAuthPath);
      await chmod(fixture.userAuthPath, 0o666);
      const originalUserFile = await stat(fixture.userAuthPath);
      const assertSeparated = async () => {
        const [userFile, projectFile] = await Promise.all([
          stat(fixture.userAuthPath),
          stat(fixture.projectAuthPath),
        ]);
        expectSeparatedAuthInodes(userFile, projectFile, originalUserFile.ino);
      };
      const oauthLogin = vi
        .spyOn(ModelRuntime.prototype, 'login')
        .mockImplementation(assertSeparated);
      const logout = vi
        .spyOn(ModelRuntime.prototype, 'logout')
        .mockImplementation(assertSeparated);

      await withProcessPlatform('win32', async () => {
        await performAuthWriteOperation(operation, fixture);
      });

      const [userFile, projectFile] = await Promise.all([
        stat(fixture.userAuthPath),
        stat(fixture.projectAuthPath),
      ]);
      expectSeparatedAuthInodes(userFile, projectFile, originalUserFile.ino);
      expect(await readFile(fixture.userAuthPath, 'utf8')).toBe(projectAuth);
      await expect(readFile(fixture.projectAuthPath, 'utf8')).resolves.toBe(projectAuth);
      if (operation === 'oauth') expect(oauthLogin).toHaveBeenCalledOnce();
      else expect(logout).toHaveBeenCalledOnce();
      await expectPosixPrivateAuthMode(fixture.userAuthPath);
    },
  );

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

type AuthWriteOperation = 'api-key' | 'oauth' | 'logout';

interface AuthOperationPaths {
  cwd: string;
  agentDir: string;
  projectDir: string;
}

interface AuthFileFixture extends AuthOperationPaths {
  projectAuthPath: string;
  userAuthPath: string;
  externalAuthPath: string;
}

type ProjectDirectoryAliasKind =
  (typeof PROJECT_DIRECTORY_ALIAS_CASES)[number][1];

interface ProjectDirectoryAliasFixture extends AuthFileFixture {
  projectLinkPath: string;
}

function createOAuthCallbacks() {
  return {
    onAuth: vi.fn(),
    onDeviceCode: vi.fn(),
    onPrompt: vi.fn().mockResolvedValue('answer'),
    onSelect: vi.fn().mockResolvedValue('option'),
  };
}

async function performAuthWriteOperation(
  operation: AuthWriteOperation,
  paths: AuthOperationPaths,
): Promise<unknown> {
  const options = {
    cwd: paths.cwd,
    pi: { agentDir: paths.agentDir, projectDir: paths.projectDir },
    provider: 'openai',
    modelId: 'gpt-6.1-sol',
  };
  if (operation === 'api-key') {
    return loginPiConductor({ ...options, apiKey: 'case-alias-api-key' });
  }
  if (operation === 'oauth') {
    return loginPiConductor({ ...options, oauthCallbacks: createOAuthCallbacks() });
  }
  return logoutPiConductor(options);
}

async function createAuthFileFixture(prefix: string): Promise<AuthFileFixture> {
  const baseDir = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(baseDir, 'project');
  const agentDir = join(baseDir, 'user-pi');
  const projectDir = join(cwd, '.ensemble', 'pi');
  const projectAuthPath = join(projectDir, 'auth.json');
  const userAuthPath = join(agentDir, 'auth.json');
  const externalAuthPath = join(baseDir, 'external', 'auth.json');
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(projectDir, { recursive: true }),
    mkdir(dirname(externalAuthPath), { recursive: true }),
  ]);
  return {
    cwd,
    agentDir,
    projectDir,
    projectAuthPath,
    userAuthPath,
    externalAuthPath,
  };
}

async function createProjectDirectoryAliasFixture(
  prefix: string,
  projectRootKind: ProjectDirectoryAliasKind,
): Promise<ProjectDirectoryAliasFixture> {
  const fixture = await createAuthFileFixture(prefix);
  const projectDir =
    projectRootKind === 'project-pi'
      ? join(fixture.cwd, 'project-resources', 'pi')
      : fixture.projectDir;
  const projectLinkPath =
    projectRootKind === 'project-pi'
      ? join(projectDir, 'linked-resources')
      : join(dirname(projectDir), 'linked-resources');
  await mkdir(dirname(projectLinkPath), { recursive: true });
  return { ...fixture, projectDir, projectLinkPath };
}

async function directoryPathIsCaseInsensitive(directory: string): Promise<boolean> {
  const name = basename(directory);
  const alternateName = name.replace(/[a-z]/, (letter) => letter.toUpperCase());
  if (alternateName === name) return false;
  try {
    const [original, alternate] = await Promise.all([
      stat(directory),
      stat(join(dirname(directory), alternateName)),
    ]);
    return original.dev === alternate.dev && original.ino === alternate.ino;
  } catch {
    return false;
  }
}

function expectSeparatedAuthInodes(
  userFile: Awaited<ReturnType<typeof stat>>,
  projectFile: Awaited<ReturnType<typeof stat>>,
  originalInode: number,
): void {
  expect(userFile.nlink).toBe(1);
  expect(projectFile.nlink).toBe(1);
  expectDifferentInodes(userFile.ino, projectFile.ino);
  expectDifferentInodes(userFile.ino, originalInode);
  if (originalInode !== 0) expect(projectFile.ino).toBe(originalInode);
}

function expectDifferentInodes(first: number | undefined, second: number): void {
  if (first !== undefined && first !== 0 && second !== 0) {
    expect(first).not.toBe(second);
  }
}

function expectSameInodes(first: number | undefined, second: number): void {
  if (first !== undefined && first !== 0 && second !== 0) {
    expect(first).toBe(second);
  }
}

/** Simulate only the process.platform branch; this does not emulate Windows ACLs. */
async function withProcessPlatform<T>(
  platform: NodeJS.Platform,
  action: () => Promise<T>,
): Promise<T> {
  if (process.platform === platform) return action();
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor?.configurable) {
    throw new Error(`Cannot simulate process.platform=${platform} in this test process.`);
  }
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return await action();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

async function expectPosixPrivateAuthMode(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  expect((await stat(path)).mode & 0o777).toBe(0o600);
}
