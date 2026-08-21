import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bundledModule from './resolve-bundled-acp-bin.js';
import {
  AcpPresetPrerequisiteError,
  finalizeResolvedAcpSpawn,
  formatAcpExternalCliInstallHint,
  formatAcpPresetInstallHint,
  validateAcpPresetPrerequisites,
} from './validate-acp-preset-prerequisites.js';

describe('validate-acp-preset-prerequisites', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes install guidance for missing optional adapter', () => {
    expect(formatAcpPresetInstallHint('codex')).toContain('codex-acp');
    expect(formatAcpPresetInstallHint('codex')).toContain('pnpm install');
    expect(formatAcpPresetInstallHint('codex')).toContain(
      '@agentclientprotocol/codex-acp',
    );
  });

  it('includes Agent CLI guidance for cursor preset', () => {
    expect(formatAcpPresetInstallHint('cursor')).toContain('agent');
    expect(formatAcpPresetInstallHint('cursor')).toContain('cursor.com/docs/cli');
  });

  it('uses a distinct message when pi CLI is missing but pi-acp exists', () => {
    const hint = formatAcpExternalCliInstallHint('pi', 'pi');
    expect(hint).toContain('`pi` CLI');
    expect(hint).toContain('pi-acp');
    expect(hint).toContain('@earendil-works/pi-coding-agent');
  });

  it('throws before spawn when bundled and PATH both miss', () => {
    vi.spyOn(bundledModule, 'resolveBundledAcpBin').mockReturnValue(undefined);
    vi.spyOn(bundledModule, 'resolveAcpBinFromPath').mockReturnValue(undefined);

    expect(() =>
      validateAcpPresetPrerequisites({
        preset: 'codex',
        command: 'codex-acp',
        args: [],
      }),
    ).toThrow(AcpPresetPrerequisiteError);
  });

  it('throws when cursor preset lacks agent on PATH', () => {
    vi.spyOn(bundledModule, 'resolveAcpBinFromPath').mockReturnValue(undefined);

    expect(() =>
      validateAcpPresetPrerequisites({
        preset: 'cursor',
        command: 'agent',
        args: ['acp'],
      }),
    ).toThrow(/Cursor Agent CLI/);
  });

  it('throws a separate message when pi CLI is missing', () => {
    vi.spyOn(bundledModule, 'resolveBundledAcpBin').mockReturnValue(
      '/opt/pi-acp',
    );
    vi.spyOn(bundledModule, 'resolveAcpBinFromPath').mockImplementation((name) =>
      name === 'pi-acp' ? '/opt/pi-acp' : undefined,
    );

    expect(() =>
      validateAcpPresetPrerequisites({
        preset: 'pi',
        command: 'pi-acp',
        args: [],
      }),
    ).toThrow(/`pi` CLI/);
  });

  it('finalizes spawn to an absolute executable path', () => {
    vi.spyOn(bundledModule, 'resolveBundledAcpBin').mockReturnValue(
      '/opt/codex-acp',
    );
    vi.spyOn(bundledModule, 'resolveAcpBinFromPath').mockReturnValue(undefined);
    vi.spyOn(bundledModule, 'resolveAcpBin').mockReturnValue('/opt/codex-acp');

    expect(
      finalizeResolvedAcpSpawn({
        preset: 'codex',
        command: 'codex-acp',
        args: [],
      }),
    ).toEqual({
      preset: 'codex',
      command: '/opt/codex-acp',
      args: [],
    });
  });
});
