import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readDoctorConfigSettings,
  writeDoctorConfigSetting,
} from './doctor-settings.js';

describe('doctor config settings', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns only allowlisted effective values and their source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ensemble-doctor-config-read-'));
    const repoRoot = join(root, 'repo');
    const userRoot = join(root, 'user');
    const projectConfigDir = join(repoRoot, '.ensemble');
    const secret = 'doctor-config-secret-sentinel';
    await mkdir(userRoot, { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(
      join(userRoot, 'config.yaml'),
      [
        'config:',
        '  loadProjectConfig: true',
        'acp:',
        '  defaultPreset: claude',
        '  env:',
        `    API_KEY: ${secret}`,
        'session:',
        '  worktree: isolated',
        '  lazyWorkers: true',
        'github:',
        '  auth:',
        '    allowGhAuthTokenFallback: false',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(projectConfigDir, 'config.yaml'),
      [
        'acp:',
        '  defaultPreset: codex',
        'session:',
        '  worktree: in_repo',
        '',
      ].join('\n'),
    );

    const snapshot = await readDoctorConfigSettings({
      repoRoot,
      userEnsembleRoot: userRoot,
    });

    expect(snapshot.projectConfigEnabled).toBe(true);
    expect(snapshot.settings).toEqual([
      { key: 'acp.defaultPreset', value: 'codex', source: 'project' },
      { key: 'session.worktree', value: 'in_repo', source: 'project' },
      { key: 'session.lazyWorkers', value: true, source: 'user' },
      {
        key: 'github.auth.allowGhAuthTokenFallback',
        value: false,
        source: 'user',
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(secret);

    await rm(root, { recursive: true, force: true });
  });

  it('reports the worker preset environment override without exposing other env values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ensemble-doctor-config-env-'));
    const repoRoot = join(root, 'repo');
    const userRoot = join(root, 'user');
    await mkdir(userRoot, { recursive: true });
    await writeFile(
      join(userRoot, 'config.yaml'),
      'acp:\n  defaultPreset: cursor\n',
    );

    const snapshot = await readDoctorConfigSettings({
      repoRoot,
      userEnsembleRoot: userRoot,
      env: { ENSEMBLE_DEFAULT_ACP_CLI: 'pi', SECRET: 'env-secret-sentinel' },
    });

    expect(snapshot.settings[0]).toEqual({
      key: 'acp.defaultPreset',
      value: 'pi',
      source: 'environment',
    });
    expect(JSON.stringify(snapshot)).not.toContain('env-secret-sentinel');

    await rm(root, { recursive: true, force: true });
  });

  it('writes one allowlisted user setting after explicit consent and preserves other config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ensemble-doctor-config-write-'));
    const repoRoot = join(root, 'repo');
    const userRoot = join(root, 'user');
    const userConfigPath = join(userRoot, 'config.yaml');
    const projectConfigPath = join(repoRoot, '.ensemble', 'config.yaml');
    await mkdir(userRoot, { recursive: true });
    await mkdir(join(repoRoot, '.ensemble'), { recursive: true });
    await writeFile(
      userConfigPath,
      [
        '# Keep unrelated config.',
        'config:',
        '  loadProjectConfig: true',
        'acp:',
        '  defaultPreset: cursor',
        '  env:',
        '    API_KEY: never-return-this-value',
        'session:',
        '  lazyWorkers: true',
        '',
      ].join('\n'),
    );
    await writeFile(projectConfigPath, 'session:\n  worktree: isolated\n');
    const confirm = vi.fn().mockResolvedValue(true);

    const result = await writeDoctorConfigSetting({
      repoRoot,
      userEnsembleRoot: userRoot,
      key: 'acp.defaultPreset',
      value: 'codex',
      target: 'user',
      confirm,
    });

    expect(result).toMatchObject({
      written: true,
      key: 'acp.defaultPreset',
      value: 'codex',
      target: 'user',
      path: userConfigPath,
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        current: {
          key: 'acp.defaultPreset',
          value: 'cursor',
          source: 'user',
        },
        value: 'codex',
        target: 'user',
        path: userConfigPath,
      }),
    );
    const updatedUserConfig = await readFile(userConfigPath, 'utf8');
    expect(updatedUserConfig).toContain('# Keep unrelated config.');
    expect(updatedUserConfig).toContain('defaultPreset: codex');
    expect(updatedUserConfig).toContain('API_KEY: never-return-this-value');
    expect(await readFile(projectConfigPath, 'utf8')).toBe(
      'session:\n  worktree: isolated\n',
    );
    expect(JSON.stringify(result)).not.toContain('never-return-this-value');

    await rm(root, { recursive: true, force: true });
  });

  it('does not write when consent is declined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ensemble-doctor-config-decline-'));
    const repoRoot = join(root, 'repo');
    const userRoot = join(root, 'user');
    const userConfigPath = join(userRoot, 'config.yaml');
    await mkdir(userRoot, { recursive: true });
    await writeFile(userConfigPath, 'acp:\n  defaultPreset: cursor\n');
    const confirm = vi.fn().mockResolvedValue(false);

    await expect(
      writeDoctorConfigSetting({
        repoRoot,
        userEnsembleRoot: userRoot,
        key: 'acp.defaultPreset',
        value: 'codex',
        target: 'user',
        confirm,
      }),
    ).resolves.toMatchObject({ written: false });
    await expect(readFile(userConfigPath, 'utf8')).resolves.toContain(
      'defaultPreset: cursor',
    );

    await rm(root, { recursive: true, force: true });
  });

  it('requires project config to be enabled in the user layer before project writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ensemble-doctor-project-disabled-'));
    const repoRoot = join(root, 'repo');
    const userRoot = join(root, 'user');
    const projectConfigPath = join(repoRoot, '.ensemble', 'config.yaml');
    await mkdir(userRoot, { recursive: true });
    await writeFile(
      join(userRoot, 'config.yaml'),
      'config:\n  loadProjectConfig: false\n',
    );
    const confirm = vi.fn();

    await expect(
      writeDoctorConfigSetting({
        repoRoot,
        userEnsembleRoot: userRoot,
        key: 'session.lazyWorkers',
        value: true,
        target: 'project',
        confirm,
      }),
    ).rejects.toThrow('Project config is disabled');
    expect(confirm).not.toHaveBeenCalled();
    await expect(readFile(projectConfigPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await rm(root, { recursive: true, force: true });
  });

  it('rejects unsupported settings before asking for consent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ensemble-doctor-invalid-write-'));
    const repoRoot = join(root, 'repo');
    const userRoot = join(root, 'user');
    await mkdir(userRoot, { recursive: true });
    const confirm = vi.fn();

    await expect(
      writeDoctorConfigSetting({
        repoRoot,
        userEnsembleRoot: userRoot,
        key: 'acp.env.API_KEY' as never,
        value: 'secret' as never,
        target: 'user',
        confirm,
      }),
    ).rejects.toThrow('Unsupported doctor config setting or value');
    expect(confirm).not.toHaveBeenCalled();

    await rm(root, { recursive: true, force: true });
  });
});
