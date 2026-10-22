import { describe, expect, it } from 'vitest';
import {
  ENSEMBLE_DEFAULT_ACP_CLI_ENV,
  acpSpawnFingerprint,
  assertAcpSpawnMatchesResume,
  mergeAcpSpawnEnv,
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

describe('mergeAcpSpawnEnv', () => {
  it('merges builtin preset env, then config env', () => {
    expect(
      mergeAcpSpawnEnv('codex', {
        MODEL_PROVIDER: 'litellm',
        INITIAL_AGENT_MODE: 'override',
      }),
    ).toEqual({
      INITIAL_AGENT_MODE: 'override',
      MODEL_PROVIDER: 'litellm',
    });
  });

  it('returns undefined when all layers are empty', () => {
    expect(mergeAcpSpawnEnv('cursor')).toBeUndefined();
  });
});

describe('resolveDefaultAcpSpawn with config acp.env', () => {
  it('merges config env over builtin codex preset env', () => {
    expect(
      resolveDefaultAcpSpawn({
        env: {},
        config: {
          acp: {
            defaultPreset: 'codex',
            env: { MODEL_PROVIDER: 'litellm', CODEX_CONFIG: '/path/to/litellm.config.toml' },
          },
        } as import('../config/types.js').EnsembleConfig,
      }),
    ).toMatchObject({
      preset: 'codex',
      env: {
        INITIAL_AGENT_MODE: 'agent',
        MODEL_PROVIDER: 'litellm',
        CODEX_CONFIG: '/path/to/litellm.config.toml',
      },
    });
  });

  it('applies config env when preset comes from CLI', () => {
    expect(
      resolveDefaultAcpSpawn({
        defaultAcpCli: 'codex',
        config: {
          acp: {
            defaultPreset: 'cursor',
            env: { MODEL_PROVIDER: 'litellm' },
          },
        } as import('../config/types.js').EnsembleConfig,
      }),
    ).toMatchObject({
      preset: 'codex',
      env: {
        INITIAL_AGENT_MODE: 'agent',
        MODEL_PROVIDER: 'litellm',
      },
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

  it('starts Codex ACP in the normal Agent mode', () => {
    expect(resolveBuiltinAcpPreset('codex')).toMatchObject({
      command: 'codex-acp',
      args: [],
      env: { INITIAL_AGENT_MODE: 'agent' },
    });
  });
});

describe('resolveWorkerAcpSpawn', () => {
  it('merges config acp.env with builtin preset env', () => {
    const resolved = resolveWorkerAcpSpawn({
      defaultOptions: {
        config: {
          acp: {
            defaultPreset: 'codex',
            env: { MODEL_PROVIDER: 'litellm' },
          },
        } as import('../config/types.js').EnsembleConfig,
      },
    });
    expect(resolved.env).toEqual({
      INITIAL_AGENT_MODE: 'agent',
      MODEL_PROVIDER: 'litellm',
    });
  });

  it('delegates to default resolution options', () => {
    expect(
      resolveWorkerAcpSpawn({
        defaultOptions: { defaultAcpCli: 'claude' },
      }),
    ).toMatchObject({ preset: 'claude', command: 'claude-agent-acp' });
  });
});

describe('profileWorkersToSessionSpecs', () => {
  const baseProfile: ResolvedProfile = {
    workers: [
      { name: 'implementer', kind: 'implementer' },
      { name: 'reviewer', kind: 'reviewer' },
    ],
  };

  it('resolves the same spawn for every worker from defaultAcp options', () => {
    const specs = profileWorkersToSessionSpecs(baseProfile, {
      defaultAcp: { defaultAcpCli: 'codex' },
    });
    expect(specs[0]?.spawn).toMatchObject({
      command: 'codex-acp',
      args: [],
      authenticate: { kind: 'skip' },
      env: { INITIAL_AGENT_MODE: 'agent' },
    });
    expect(specs[1]?.spawn).toMatchObject({
      command: 'codex-acp',
      args: [],
      authenticate: { kind: 'skip' },
      env: { INITIAL_AGENT_MODE: 'agent' },
    });
    expect(specs[0]?.acpFingerprint?.preset).toBe('codex');
    expect(specs[1]?.acpFingerprint?.preset).toBe('codex');
  });
});

describe('acpSpawnFingerprint', () => {
  it('includes env in fingerprint', () => {
    expect(
      acpSpawnFingerprint({
        preset: 'codex',
        command: 'codex-acp',
        args: [],
        env: { MODEL_PROVIDER: 'litellm' },
      }),
    ).toEqual({
      preset: 'codex',
      command: 'codex-acp',
      args: [],
      env: { MODEL_PROVIDER: 'litellm' },
    });
  });
});

describe('assertAcpSpawnMatchesResume', () => {
  it('throws on env mismatch during resume', () => {
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected: {
          preset: 'codex',
          command: 'codex-acp',
          args: [],
          env: { MODEL_PROVIDER: 'litellm' },
        },
        actual: {
          preset: 'codex',
          command: 'codex-acp',
          args: [],
          env: { MODEL_PROVIDER: 'openai' },
        },
      }),
    ).toThrow(/resume ACP spawn mismatch/);
  });

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

  it('skips when expected fingerprint is absent (legacy resume store)', () => {
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

  it('accepts a legacy Codex record without env when the current preset provides it', () => {
    const legacyResumeStore = {
      preset: 'codex' as const,
      command: 'codex-acp',
      args: [] as string[],
    };
    const currentSpawn = resolveWorkerAcpSpawn({
      defaultOptions: {
        config: {
          acp: { defaultPreset: 'codex' },
        } as import('../config/types.js').EnsembleConfig,
      },
    });
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected: legacyResumeStore,
        actual: acpSpawnFingerprint(currentSpawn),
        workerName: 'implementer',
      }),
    ).not.toThrow();
    expect(currentSpawn.env).toEqual({ INITIAL_AGENT_MODE: 'agent' });
  });

  it('compares env when saved resume store fingerprint includes env', () => {
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected: {
          preset: 'codex',
          command: 'codex-acp',
          args: [],
          env: { INITIAL_AGENT_MODE: 'agent', MODEL_PROVIDER: 'litellm' },
        },
        actual: {
          preset: 'codex',
          command: 'codex-acp',
          args: [],
          env: { INITIAL_AGENT_MODE: 'agent', MODEL_PROVIDER: 'litellm' },
        },
      }),
    ).not.toThrow();
  });
});

describe('resolveWorkerAcpSpawns', () => {
  it('returns a spawn map for every worker', () => {
    const map = resolveWorkerAcpSpawns({
      workers: [
        { name: 'a' },
        { name: 'b' },
      ],
    });
    expect(map.size).toBe(2);
    expect(map.get('a')?.preset).toBe('cursor');
    expect(map.get('b')?.preset).toBe('cursor');
  });
});
