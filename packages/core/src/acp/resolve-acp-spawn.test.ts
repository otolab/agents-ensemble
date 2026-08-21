import { describe, expect, it } from 'vitest';
import {
  ENSEMBLE_DEFAULT_ACP_CLI_ENV,
  acpSpawnFingerprint,
  assertAcpSpawnMatchesResume,
  resolveAcpConfig,
  resolveBuiltinAcpPreset,
  resolveDefaultAcpSpawn,
  resolveWorkerAcpSpawn,
  resolveWorkerAcpSpawns,
} from './resolve-acp-spawn.js';
import { profileWorkersToSessionSpecs } from '../profile/types.js';
import type { ResolvedProfile } from '../profile/types.js';

describe('resolveDefaultAcpSpawn', () => {
  it('defaults to cursor agent acp', () => {
    expect(resolveDefaultAcpSpawn({ env: {} })).toEqual({
      preset: 'cursor',
      command: 'agent',
      args: ['acp'],
    });
  });

  it('prefers CLI over env', () => {
    expect(
      resolveDefaultAcpSpawn({
        defaultAcpCli: 'claude',
        env: { [ENSEMBLE_DEFAULT_ACP_CLI_ENV]: 'codex' },
      }),
    ).toMatchObject({ preset: 'claude', command: 'claude-agent-acp', args: [] });
  });

  it('uses env when CLI is unset', () => {
    expect(
      resolveDefaultAcpSpawn({
        env: { [ENSEMBLE_DEFAULT_ACP_CLI_ENV]: 'codex' },
      }),
    ).toMatchObject({ preset: 'codex', command: 'codex-acp', args: [] });
  });

  it('prefers env over config when CLI is unset', () => {
    expect(
      resolveDefaultAcpSpawn({
        env: { [ENSEMBLE_DEFAULT_ACP_CLI_ENV]: 'codex' },
        config: {
          acp: { defaultPreset: 'claude' },
        } as import('../config/types.js').EnsembleConfig,
      }),
    ).toMatchObject({ preset: 'codex' });
  });

  it('uses config preset when CLI and env are unset', () => {
    expect(
      resolveDefaultAcpSpawn({
        env: {},
        config: {
          acp: { defaultPreset: 'claude' },
        } as import('../config/types.js').EnsembleConfig,
      }),
    ).toMatchObject({ preset: 'claude' });
  });

  it('resolves pi preset via CLI', () => {
    expect(
      resolveDefaultAcpSpawn({
        defaultAcpCli: 'pi',
      }),
    ).toEqual({
      preset: 'pi',
      command: 'pi-acp',
      args: [],
    });
  });

  it('resolves pi preset via env', () => {
    expect(
      resolveDefaultAcpSpawn({
        env: { [ENSEMBLE_DEFAULT_ACP_CLI_ENV]: 'pi' },
      }),
    ).toMatchObject({
      preset: 'pi',
      command: 'pi-acp',
      args: [],
    });
  });

  it('supports custom command + args from CLI', () => {
    expect(
      resolveDefaultAcpSpawn({
        defaultAcpCommand: 'my-agent',
        defaultAcpArgs: ['acp', '--verbose'],
      }),
    ).toEqual({
      preset: 'custom',
      command: 'my-agent',
      args: ['acp', '--verbose'],
    });
  });
});

describe('resolveBuiltinAcpPreset', () => {
  it('does not use npx for built-in presets', () => {
    for (const preset of ['claude', 'codex', 'pi'] as const) {
      const resolved = resolveBuiltinAcpPreset(preset);
      expect(resolved.command).not.toBe('npx');
      expect(resolved.args).not.toContain('-y');
    }
  });
});

describe('resolveWorkerAcpSpawn', () => {
  it('uses profile worker acp over profile default and CLI', () => {
    expect(
      resolveWorkerAcpSpawn({
        profileAcp: { preset: 'codex' },
        workerAcp: { preset: 'claude' },
        defaultOptions: { defaultAcpCli: 'cursor' },
      }),
    ).toMatchObject({ preset: 'claude', command: 'claude-agent-acp' });
  });

  it('inherits profile acp when worker has no acp block', () => {
    expect(
      resolveWorkerAcpSpawn({
        profileAcp: { preset: 'codex' },
        defaultOptions: { defaultAcpCli: 'cursor' },
      }),
    ).toMatchObject({ preset: 'codex', command: 'codex-acp' });
  });

  it('merges profile and worker args for built-in preset', () => {
    const resolved = resolveWorkerAcpSpawn({
      profileAcp: { preset: 'cursor' },
      workerAcp: { args: ['--flag'] },
    });
    expect(resolved.args).toEqual(['acp', '--flag']);
  });

  it('falls back to default resolution when profile has no acp', () => {
    expect(
      resolveWorkerAcpSpawn({
        defaultOptions: { defaultAcpCli: 'claude' },
      }),
    ).toMatchObject({ preset: 'claude', command: 'claude-agent-acp' });
  });
});

describe('resolveAcpConfig custom', () => {
  it('requires command for custom preset', () => {
    expect(() => resolveAcpConfig({ preset: 'custom' })).toThrow(/command/);
  });
});

describe('profileWorkersToSessionSpecs', () => {
  const baseProfile: ResolvedProfile = {
    workers: [
      { name: 'implementer', kind: 'implementer' },
      { name: 'reviewer', kind: 'reviewer', acp: { preset: 'codex' } },
    ],
    acp: { preset: 'claude' },
  };

  it('resolves per-worker spawn with profile priority', () => {
    const specs = profileWorkersToSessionSpecs(baseProfile, {
      defaultAcp: { defaultAcpCli: 'cursor' },
    });
    expect(specs[0]?.spawn).toMatchObject({
      command: 'claude-agent-acp',
      args: [],
    });
    expect(specs[1]?.spawn).toMatchObject({
      command: 'codex-acp',
      args: [],
    });
    expect(specs[0]?.acpFingerprint?.preset).toBe('claude');
    expect(specs[1]?.acpFingerprint?.preset).toBe('codex');
  });
});

describe('assertAcpSpawnMatchesResume', () => {
  it('throws on preset/command mismatch during resume', () => {
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected: acpSpawnFingerprint({
          preset: 'cursor',
          command: 'agent',
          args: ['acp'],
        }),
        actual: {
          preset: 'claude',
          command: 'claude-agent-acp',
          args: [],
        },
        workerName: 'implementer',
      }),
    ).toThrow(/resume ACP spawn mismatch/);
  });

  it('accepts matching pi preset during resume', () => {
    const piSpawn = {
      preset: 'pi' as const,
      command: 'pi-acp',
      args: [],
    };
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected: piSpawn,
        actual: piSpawn,
        workerName: 'implementer',
      }),
    ).not.toThrow();
  });

  it('skips when expected fingerprint is absent (legacy sidecar)', () => {
    expect(() =>
      assertAcpSpawnMatchesResume({
        actual: {
          preset: 'cursor',
          command: 'agent',
          args: ['acp'],
        },
      }),
    ).not.toThrow();
  });
});

describe('resolveWorkerAcpSpawns', () => {
  it('returns a spawn map for every worker', () => {
    const map = resolveWorkerAcpSpawns({
      profile: {
        workers: [
          { name: 'a', kind: 'implementer' },
          { name: 'b', kind: 'reviewer' },
        ],
      },
    });
    expect(map.size).toBe(2);
    expect(map.get('a')?.preset).toBe('cursor');
  });
});
