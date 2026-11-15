import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDoctorConfigTools } from './doctor/doctor-config-tools.js';

describe('doctor config tools', () => {
  it('exposes only allowlisted read/write tools and returns no secret config values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ensemble-doctor-tools-read-'));
    const repoRoot = join(root, 'repo');
    const userRoot = join(root, 'user');
    const secret = 'doctor-tool-secret-sentinel';
    await mkdir(userRoot, { recursive: true });
    await writeFile(
      join(userRoot, 'config.yaml'),
      [
        'acp:',
        '  defaultPreset: codex',
        '  env:',
        `    API_KEY: ${secret}`,
        'session:',
        '  worktree: isolated',
        '',
      ].join('\n'),
    );
    const tools = createDoctorConfigTools({
      repoRoot,
      userEnsembleRoot: userRoot,
      target: 'user',
      confirm: vi.fn(),
    });

    expect(Object.keys(tools)).toEqual([
      'doctor_read_config',
      'doctor_write_config',
    ]);
    expect(tools.doctor_read_config?.inputSchema).toMatchObject({
      additionalProperties: false,
    });
    expect(tools.doctor_write_config?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['key', 'value'],
    });

    const result = await tools.doctor_read_config!.execute({});
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('acp.defaultPreset');
    expect(serialized).toContain('source');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('API_KEY');

    await rm(root, { recursive: true, force: true });
  });

  it('requires direct consent before writing and fixes the destination in the tool closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ensemble-doctor-tools-write-'));
    const repoRoot = join(root, 'repo');
    const userRoot = join(root, 'user');
    const projectConfigPath = join(repoRoot, '.ensemble', 'config.yaml');
    await mkdir(userRoot, { recursive: true });
    await mkdir(join(repoRoot, '.ensemble'), { recursive: true });
    await writeFile(
      join(userRoot, 'config.yaml'),
      'config:\n  loadProjectConfig: true\nacp:\n  defaultPreset: cursor\n',
    );
    const confirm = vi.fn().mockResolvedValue(true);
    const tools = createDoctorConfigTools({
      repoRoot,
      userEnsembleRoot: userRoot,
      target: 'project',
      confirm,
    });

    const result = await tools.doctor_write_config!.execute({
      key: 'acp.defaultPreset',
      value: 'codex',
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'acp.defaultPreset',
        target: 'project',
        path: projectConfigPath,
        value: 'codex',
      }),
    );
    expect(JSON.stringify(result)).toContain('project');
    await expect(readFile(projectConfigPath, 'utf8')).resolves.toContain(
      'defaultPreset: codex',
    );

    await rm(root, { recursive: true, force: true });
  });

  it('rejects arbitrary keys and extra tool arguments without requesting consent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ensemble-doctor-tools-deny-'));
    const confirm = vi.fn();
    const tools = createDoctorConfigTools({
      repoRoot: join(root, 'repo'),
      userEnsembleRoot: join(root, 'user'),
      target: 'user',
      confirm,
    });

    const invalidKey = await tools.doctor_write_config!.execute({
      key: 'acp.env.API_KEY',
      value: 'secret',
    });
    const extraArgument = await tools.doctor_write_config!.execute({
      key: 'session.lazyWorkers',
      value: true,
      path: '/tmp/unrelated-file',
    });

    expect(JSON.stringify(invalidKey)).toContain('Unsupported');
    expect(JSON.stringify(extraArgument)).toContain('Unsupported');
    expect(confirm).not.toHaveBeenCalled();

    await rm(root, { recursive: true, force: true });
  });
});
