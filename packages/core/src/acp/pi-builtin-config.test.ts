import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureBuiltinPiConfig } from './pi-builtin-config.js';

describe('ensureBuiltinPiConfig', () => {
  let tempRoot = '';

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  });

  it('installs the packaged defaults into a new custom Pi agent root', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-config-'));
    const agentDir = join(tempRoot, 'custom-pi-agent');

    ensureBuiltinPiConfig({ agentDir });

    await expect(
      readFile(join(agentDir, 'settings.json'), 'utf8').then(JSON.parse),
    ).resolves.toEqual({
      defaultThinkingLevel: 'medium',
      enableSkillCommands: true,
    });
  });

  it('preserves existing user settings', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-config-'));
    const agentDir = join(tempRoot, 'custom-pi-agent');
    const settingsPath = join(agentDir, 'settings.json');
    const userSettings = '{"defaultThinkingLevel":"high","custom":true}\n';
    const defaultsPath = join(tempRoot, 'defaults.json');
    await writeFile(defaultsPath, '{"defaultThinkingLevel":"medium"}\n');
    await mkdir(agentDir, { recursive: true });
    await writeFile(settingsPath, userSettings);

    ensureBuiltinPiConfig({ agentDir, defaultsPath });

    await expect(readFile(settingsPath, 'utf8')).resolves.toBe(userSettings);
  });
});
