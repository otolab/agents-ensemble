import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeConductorSetupFiles } from './conductor-setup.js';
import { resolvePiModelConfig } from './pi-conductor-agent.js';

describe('writeConductorSetupFiles', () => {
  it('creates the first user config and a Pi model that the pinned runtime can resolve', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-first-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-first-user-'));
    const home = await mkdtemp(join(tmpdir(), 'ensemble-setup-first-home-'));
    const agentDir = join(home, '.ensemble', 'pi');
    const configPath = join(userRoot, 'config.yaml');
    const settingsPath = join(agentDir, 'settings.json');

    const result = await writeConductorSetupFiles({
      repoRoot,
      userEnsembleRoot: userRoot,
      home,
      backend: 'pi',
      pi: { provider: 'openai', modelId: 'gpt-6.1-sol' },
    });

    expect(result).toMatchObject({
      configPath,
      backend: 'pi',
      pi: { agentDir, settingsPath, provider: 'openai', modelId: 'gpt-6.1-sol' },
    });
    expect(await readFile(configPath, 'utf8')).toContain('backend: pi');
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toMatchObject({
      defaultProvider: 'openai',
      defaultModel: 'gpt-6.1-sol',
    });

    await expect(
      resolvePiModelConfig({
        cwd: repoRoot,
        home,
        pi: { agentDir, projectDir: join(repoRoot, '.ensemble', 'pi') },
      }),
    ).resolves.toMatchObject({
      provider: 'openai',
      modelId: 'gpt-6.1-sol',
    });
  });

  it('merges Pi defaults into user files and leaves project resources untouched', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-user-'));
    const agentDir = join(repoRoot, 'user-pi');
    const projectDir = join(repoRoot, 'project-pi');
    const projectConfigPath = join(repoRoot, '.ensemble', 'config.yaml');
    const projectSettingsPath = join(projectDir, 'settings.json');
    const userConfigPath = join(userRoot, 'config.yaml');
    const userSettingsPath = join(agentDir, 'settings.json');

    await mkdir(join(repoRoot, '.ensemble'), { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      projectConfigPath,
      'conductor:\n  backend: cursor\n  model: cursor-model\n',
    );
    await writeFile(
      projectSettingsPath,
      JSON.stringify({ defaultProvider: 'project-provider', custom: true }, null, 2),
    );
    await mkdir(userRoot, { recursive: true });
    await writeFile(
      userConfigPath,
      [
        '# keep this user-owned comment',
        'conductor:',
        '  backend: cursor # keep this inline comment',
        '  model: existing-model',
        '  pi:',
        '    agentDir: ./user-pi',
        '    projectDir: ./project-pi',
        'session:',
        '  worktree: isolated',
        '',
      ].join('\n'),
    );
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      userSettingsPath,
      JSON.stringify(
        { defaultProvider: 'anthropic', defaultModel: 'old-model', extensions: ['ext.js'] },
        null,
        2,
      ),
    );

    const result = await writeConductorSetupFiles({
      repoRoot,
      userEnsembleRoot: userRoot,
      backend: 'pi',
      pi: { provider: 'openai', modelId: 'gpt-6.1-sol' },
    });

    expect(result).toMatchObject({
      configPath: userConfigPath,
      backend: 'pi',
      pi: {
        agentDir,
        settingsPath: userSettingsPath,
        provider: 'openai',
        modelId: 'gpt-6.1-sol',
      },
    });
    const userConfig = await readFile(userConfigPath, 'utf8');
    expect(userConfig).toContain('# keep this user-owned comment');
    expect(userConfig).toContain('backend: pi # keep this inline comment');
    expect(userConfig).toContain('model: existing-model');
    expect(userConfig).toContain('worktree: isolated');
    expect(userConfig).not.toContain('cursor-model');
    expect(await readFile(userSettingsPath, 'utf8')).toContain('"extensions": [\n    "ext.js"\n  ]');
    expect(JSON.parse(await readFile(userSettingsPath, 'utf8'))).toMatchObject({
      defaultProvider: 'openai',
      defaultModel: 'gpt-6.1-sol',
      extensions: ['ext.js'],
    });
    expect(await readFile(projectConfigPath, 'utf8')).toBe(
      'conductor:\n  backend: cursor\n  model: cursor-model\n',
    );
    expect(JSON.parse(await readFile(projectSettingsPath, 'utf8'))).toMatchObject({
      defaultProvider: 'project-provider',
      custom: true,
    });
    expect((await stat(userConfigPath)).mode & 0o777).toBe(0o600);
    expect((await stat(userSettingsPath)).mode & 0o777).toBe(0o600);
  });

  it('changes only the user backend for Cursor and keeps existing Pi files', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-cursor-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-cursor-user-'));
    const userConfigPath = join(userRoot, 'config.yaml');
    const settingsPath = join(userRoot, 'pi', 'settings.json');
    await mkdir(join(userRoot, 'pi'), { recursive: true });
    await writeFile(userConfigPath, 'conductor:\n  model: existing-model\n');
    await writeFile(settingsPath, '{"defaultProvider":"openai","defaultModel":"existing"}\n');

    const result = await writeConductorSetupFiles({
      repoRoot,
      userEnsembleRoot: userRoot,
      backend: 'cursor',
    });

    expect(result).toEqual({ configPath: userConfigPath, backend: 'cursor' });
    expect(await readFile(userConfigPath, 'utf8')).toContain('backend: cursor');
    expect(await readFile(userConfigPath, 'utf8')).toContain('model: existing-model');
    expect(await readFile(settingsPath, 'utf8')).toBe(
      '{"defaultProvider":"openai","defaultModel":"existing"}\n',
    );
  });

  it('does not overwrite malformed user settings or config', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-invalid-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-invalid-user-'));
    const userConfigPath = join(userRoot, 'config.yaml');
    const settingsPath = join(userRoot, 'pi', 'settings.json');
    await mkdir(join(userRoot, 'pi'), { recursive: true });
    await writeFile(userConfigPath, 'conductor: [not, an, object]\n');
    await writeFile(settingsPath, '{ invalid json');

    await expect(
      writeConductorSetupFiles({
        repoRoot,
        userEnsembleRoot: userRoot,
        backend: 'pi',
        pi: { provider: 'openai', modelId: 'gpt-6.1-sol' },
      }),
    ).rejects.toThrow('setup did not overwrite it');

    expect(await readFile(userConfigPath, 'utf8')).toBe('conductor: [not, an, object]\n');
    expect(await readFile(settingsPath, 'utf8')).toBe('{ invalid json');
  });

  it('does not replace a malformed user config when setting Cursor', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-invalid-cursor-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-invalid-cursor-user-'));
    const userConfigPath = join(userRoot, 'config.yaml');
    await writeFile(userConfigPath, 'conductor: [\n');

    await expect(
      writeConductorSetupFiles({
        repoRoot,
        userEnsembleRoot: userRoot,
        backend: 'cursor',
      }),
    ).rejects.toThrow('Could not parse user config');
    expect(await readFile(userConfigPath, 'utf8')).toBe('conductor: [\n');
  });

  it('refuses to write user Pi settings into the configured project resource root', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-shared-root-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-shared-root-user-'));
    const projectPiDir = join(repoRoot, '.ensemble', 'pi');
    const userConfigPath = join(userRoot, 'config.yaml');
    const projectSettingsPath = join(projectPiDir, 'settings.json');
    await mkdir(projectPiDir, { recursive: true });
    await writeFile(
      userConfigPath,
      `conductor:\n  pi:\n    agentDir: ${projectPiDir}\n    projectDir: ${projectPiDir}\n`,
    );
    await writeFile(projectSettingsPath, '{"custom":"project"}\n');

    await expect(
      writeConductorSetupFiles({
        repoRoot,
        userEnsembleRoot: userRoot,
        backend: 'pi',
        pi: { provider: 'openai', modelId: 'gpt-6.1-sol' },
      }),
    ).rejects.toThrow('User Pi resource root resolves inside the project resource root');
    expect(await readFile(projectSettingsPath, 'utf8')).toBe('{"custom":"project"}\n');
  });

  it('refuses a user Pi root nested under the project resource root', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-nested-pi-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-nested-pi-user-'));
    const projectPiDir = join(repoRoot, '.ensemble', 'pi');
    const agentDir = join(projectPiDir, 'user');
    await mkdir(projectPiDir, { recursive: true });
    await writeFile(
      join(userRoot, 'config.yaml'),
      `conductor:\n  pi:\n    agentDir: ${agentDir}\n`,
    );

    await expect(
      writeConductorSetupFiles({
        repoRoot,
        userEnsembleRoot: userRoot,
        backend: 'pi',
        pi: { provider: 'openai', modelId: 'gpt-6.1-sol' },
      }),
    ).rejects.toThrow('User Pi resource root resolves inside the project resource root');

    await expect(stat(agentDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(projectPiDir, 'settings.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('protects a missing project Pi root when its user path differs only by case', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-case-alias-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-case-alias-user-'));
    const projectParent = join(repoRoot, '.ensemble');
    const projectPiDir = join(projectParent, 'pi');
    const agentDir = join(projectParent, 'Pi');
    const userConfigPath = join(userRoot, 'config.yaml');
    await mkdir(projectParent, { recursive: true });
    await writeFile(userConfigPath, `conductor:\n  pi:\n    agentDir: ${agentDir}\n`);

    const caseInsensitiveVolume = await hasCaseInsensitiveDirectoryNames(repoRoot, projectParent);

    if (caseInsensitiveVolume) {
      await expect(
        writeConductorSetupFiles({
          repoRoot,
          userEnsembleRoot: userRoot,
          backend: 'pi',
          pi: { provider: 'openai', modelId: 'gpt-6.1-sol' },
        }),
      ).rejects.toThrow('User Pi resource root resolves inside the project resource root');

      await expect(stat(agentDir)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(projectPiDir)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(projectPiDir, 'settings.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      return;
    }

    await expect(
      writeConductorSetupFiles({
        repoRoot,
        userEnsembleRoot: userRoot,
        backend: 'pi',
        pi: { provider: 'openai', modelId: 'gpt-6.1-sol' },
      }),
    ).resolves.toMatchObject({ pi: { agentDir } });

    expect(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))).toMatchObject({
      defaultProvider: 'openai',
      defaultModel: 'gpt-6.1-sol',
    });
    await expect(stat(projectPiDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a user settings symlink that resolves into project resources', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-settings-link-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-settings-link-user-'));
    const agentDir = join(userRoot, 'pi');
    const projectPiDir = join(repoRoot, '.ensemble', 'pi');
    const projectSettingsPath = join(projectPiDir, 'nested', 'settings.json');
    const originalProjectSettings = '{"project":"owned"}\n';
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(projectPiDir, 'nested'), { recursive: true });
    await writeFile(
      join(userRoot, 'config.yaml'),
      `conductor:\n  pi:\n    agentDir: ${agentDir}\n`,
    );
    await writeFile(projectSettingsPath, originalProjectSettings);
    await symlink(projectSettingsPath, join(agentDir, 'settings.json'));

    await expect(
      writeConductorSetupFiles({
        repoRoot,
        userEnsembleRoot: userRoot,
        backend: 'pi',
        pi: { provider: 'openai', modelId: 'gpt-6.1-sol' },
      }),
    ).rejects.toThrow('User Pi settings resolve inside the project resource root');

    expect(await readFile(projectSettingsPath, 'utf8')).toBe(originalProjectSettings);
  });

  it('refuses a user Pi settings symlink to project .ensemble/config.yaml', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-settings-project-config-link-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-settings-project-config-user-'));
    const projectEnsembleDir = join(repoRoot, '.ensemble');
    const projectConfigPath = join(projectEnsembleDir, 'config.yaml');
    const agentDir = join(userRoot, 'pi');
    const settingsPath = join(agentDir, 'settings.json');
    const userConfigPath = join(userRoot, 'config.yaml');
    const originalProjectConfig = '{"conductor":{"backend":"cursor","model":"project-model"}}\n';
    const originalUserConfig = `conductor:\n  backend: cursor\n  pi:\n    agentDir: ${agentDir}\n`;
    await mkdir(projectEnsembleDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(projectConfigPath, originalProjectConfig);
    await writeFile(userConfigPath, originalUserConfig);
    await symlink(projectConfigPath, settingsPath);

    await expect(
      writeConductorSetupFiles({
        repoRoot,
        userEnsembleRoot: userRoot,
        backend: 'pi',
        pi: { provider: 'openai', modelId: 'gpt-6.1-sol' },
      }),
    ).rejects.toThrow(
      /User Pi settings resolve inside the project resource root \(\.ensemble or configured Pi root\)/,
    );

    expect(await readFile(projectConfigPath, 'utf8')).toBe(originalProjectConfig);
    expect(await readFile(userConfigPath, 'utf8')).toBe(originalUserConfig);
    expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(settingsPath)).toBe(projectConfigPath);
  });

  it('keeps an external user Pi settings symlink usable', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-settings-external-link-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-settings-external-link-user-'));
    const externalRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-settings-external-link-target-'));
    const projectEnsembleDir = join(repoRoot, '.ensemble');
    const projectConfigPath = join(projectEnsembleDir, 'config.yaml');
    const agentDir = join(userRoot, 'pi');
    const settingsPath = join(agentDir, 'settings.json');
    const externalSettingsPath = join(externalRoot, 'settings.json');
    const originalProjectConfig = '{"conductor":{"backend":"cursor"}}\n';
    const originalExternalSettings = '{"custom":"keep"}\n';
    await mkdir(projectEnsembleDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(projectConfigPath, originalProjectConfig);
    await writeFile(join(userRoot, 'config.yaml'), `conductor:\n  pi:\n    agentDir: ${agentDir}\n`);
    await writeFile(externalSettingsPath, originalExternalSettings);
    await symlink(externalSettingsPath, settingsPath);

    await expect(
      writeConductorSetupFiles({
        repoRoot,
        userEnsembleRoot: userRoot,
        backend: 'pi',
        pi: { provider: 'openai', modelId: 'gpt-6.1-sol' },
      }),
    ).resolves.toMatchObject({ pi: { agentDir, settingsPath } });

    expect(JSON.parse(await readFile(externalSettingsPath, 'utf8'))).toMatchObject({
      custom: 'keep',
      defaultProvider: 'openai',
      defaultModel: 'gpt-6.1-sol',
    });
    expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(settingsPath)).toBe(externalSettingsPath);
    expect(await readFile(projectConfigPath, 'utf8')).toBe(originalProjectConfig);
  });

  it('detaches a user Pi settings hard link from project .ensemble before saving', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-settings-project-hardlink-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-settings-project-hardlink-user-'));
    const projectEnsembleDir = join(repoRoot, '.ensemble');
    const projectConfigPath = join(projectEnsembleDir, 'config.yaml');
    const agentDir = join(userRoot, 'pi');
    const settingsPath = join(agentDir, 'settings.json');
    const originalProjectConfig = '{"custom":"project-owned"}\n';
    await mkdir(projectEnsembleDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(projectConfigPath, originalProjectConfig);
    await writeFile(join(userRoot, 'config.yaml'), `conductor:\n  pi:\n    agentDir: ${agentDir}\n`);
    await link(projectConfigPath, settingsPath);
    expect((await stat(settingsPath)).nlink).toBe(2);

    await expect(
      writeConductorSetupFiles({
        repoRoot,
        userEnsembleRoot: userRoot,
        backend: 'pi',
        pi: { provider: 'openai', modelId: 'gpt-6.1-sol' },
      }),
    ).resolves.toMatchObject({ pi: { agentDir, settingsPath } });

    const [userSettings, projectConfig] = await Promise.all([
      stat(settingsPath),
      stat(projectConfigPath),
    ]);
    expect(userSettings.nlink).toBe(1);
    expect(projectConfig.nlink).toBe(1);
    if (userSettings.ino !== 0 && projectConfig.ino !== 0) {
      expect(userSettings.ino).not.toBe(projectConfig.ino);
    }
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toMatchObject({
      custom: 'project-owned',
      defaultProvider: 'openai',
      defaultModel: 'gpt-6.1-sol',
    });
    expect(await readFile(projectConfigPath, 'utf8')).toBe(originalProjectConfig);
  });

  it('protects project .ensemble when a user Pi root differs only by case', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-case-alias-ensemble-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-case-alias-ensemble-user-'));
    const projectEnsembleDir = join(repoRoot, '.ensemble');
    const projectConfigPath = join(projectEnsembleDir, 'config.yaml');
    const agentDir = join(repoRoot, '.Ensemble', 'user-pi');
    const settingsPath = join(agentDir, 'settings.json');
    const originalProjectConfig = '{"conductor":{"backend":"cursor"}}\n';
    await mkdir(projectEnsembleDir, { recursive: true });
    await writeFile(projectConfigPath, originalProjectConfig);
    await writeFile(join(userRoot, 'config.yaml'), `conductor:\n  pi:\n    agentDir: ${agentDir}\n`);

    const caseInsensitiveVolume = await hasCaseInsensitiveDirectoryNames(
      repoRoot,
      projectEnsembleDir,
    );
    if (caseInsensitiveVolume) {
      await expect(
        writeConductorSetupFiles({
          repoRoot,
          userEnsembleRoot: userRoot,
          backend: 'pi',
          pi: { provider: 'openai', modelId: 'gpt-6.1-sol' },
        }),
      ).rejects.toThrow(
        /User Pi resource root resolves inside the project resource root \(\.ensemble or configured Pi root\)/,
      );
      await expect(stat(settingsPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(projectConfigPath, 'utf8')).toBe(originalProjectConfig);
      return;
    }

    await expect(
      writeConductorSetupFiles({
        repoRoot,
        userEnsembleRoot: userRoot,
        backend: 'pi',
        pi: { provider: 'openai', modelId: 'gpt-6.1-sol' },
      }),
    ).resolves.toMatchObject({ pi: { agentDir, settingsPath } });
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toMatchObject({
      defaultProvider: 'openai',
      defaultModel: 'gpt-6.1-sol',
    });
    expect(await readFile(projectConfigPath, 'utf8')).toBe(originalProjectConfig);
  });

  it('refuses a user config path inside the project repository', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-user-config-project-'));
    const userRoot = join(repoRoot, '.ensemble', 'user');

    await expect(
      writeConductorSetupFiles({
        repoRoot,
        userEnsembleRoot: userRoot,
        backend: 'cursor',
      }),
    ).rejects.toThrow('User config resolves inside the project repository');

    await expect(stat(userRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a user config symlink to project .ensemble/config.yaml', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-user-config-link-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-user-config-link-user-'));
    const projectConfigPath = join(repoRoot, '.ensemble', 'config.yaml');
    const userConfigPath = join(userRoot, 'config.yaml');
    const originalProjectConfig = 'conductor:\n  backend: cursor\n  model: project-model\n';
    await mkdir(join(repoRoot, '.ensemble'), { recursive: true });
    await writeFile(projectConfigPath, originalProjectConfig);
    await symlink(projectConfigPath, userConfigPath);

    await expect(
      writeConductorSetupFiles({
        repoRoot,
        userEnsembleRoot: userRoot,
        home: userRoot,
        backend: 'pi',
        pi: { provider: 'openai', modelId: 'gpt-6.1-sol' },
      }),
    ).rejects.toThrow('User config resolves inside the project repository');

    expect(await readFile(projectConfigPath, 'utf8')).toBe(originalProjectConfig);
    expect((await lstat(userConfigPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(userConfigPath)).toBe(projectConfigPath);
    await expect(stat(join(userRoot, '.ensemble', 'pi', 'settings.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports when Pi settings were saved but user config could not be saved',
    async () => {
      const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-partial-project-'));
      const userRoot = await mkdtemp(join(tmpdir(), 'ensemble-setup-partial-user-'));
      const agentDir = await mkdtemp(join(tmpdir(), 'ensemble-setup-partial-pi-'));
      const userConfigPath = join(userRoot, 'config.yaml');
      const originalConfig = `conductor:\n  model: keep-existing\n  pi:\n    agentDir: ${agentDir}\n`;
      await writeFile(userConfigPath, originalConfig);
      await chmod(userRoot, 0o500);

      try {
        await expect(
          writeConductorSetupFiles({
            repoRoot,
            userEnsembleRoot: userRoot,
            backend: 'pi',
            pi: { provider: 'openai', modelId: 'gpt-6.1-sol' },
          }),
        ).rejects.toThrow(
          `Pi settings は ${join(agentDir, 'settings.json')} に保存しましたが、user config`,
        );

        expect(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))).toMatchObject({
          defaultProvider: 'openai',
          defaultModel: 'gpt-6.1-sol',
        });
        expect(await readFile(userConfigPath, 'utf8')).toBe(originalConfig);
      } finally {
        await chmod(userRoot, 0o700);
      }
    },
  );
});

async function hasCaseInsensitiveDirectoryNames(
  parent: string,
  existingDirectory: string,
): Promise<boolean> {
  const directoryName = existingDirectory.slice(parent.length + 1);
  const alternateName = directoryName.replace(/[a-z]/, (letter) => letter.toUpperCase());
  if (alternateName === directoryName) return false;

  try {
    const [original, alternate] = await Promise.all([
      stat(existingDirectory),
      stat(join(parent, alternateName)),
    ]);
    return original.dev === alternate.dev && original.ino === alternate.ino;
  } catch {
    return false;
  }
}
