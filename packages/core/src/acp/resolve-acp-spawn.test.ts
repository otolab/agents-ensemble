import { describe, expect, it } from 'vitest';
import {
  ENSEMBLE_DEFAULT_ACP_CLI_ENV,
  acpSpawnFingerprint,
  assertAcpSpawnMatchesResume,
  computeAcpSpawnEnvDigest,
  mergeAcpSpawnEnv,
  resolveBuiltinAcpPreset,
  resolveDefaultAcpSpawn,
  resolveWorkerAcpSpawn,
  resolveWorkerAcpSpawns,
} from './resolve-acp-spawn.js';
import {
  normalizeProfileWorker,
  profileWorkersToSessionSpecs,
} from '../profile/types.js';
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

  it('resolves each worker tag through the shared config catalog', () => {
    const workers = resolveWorkerAcpSpawns({
      workers: [
        { name: 'implementer', modelTag: 'high' },
        { name: 'reviewer' },
      ],
      defaultOptions: {
        defaultAcpCli: 'codex',
        config: {
          acp: {
            defaultPreset: 'cursor',
            models: { opus: 'gateway/opus', sonnet: 'gateway/sonnet' },
            tags: { high: 'opus', default: 'sonnet' },
          },
        } as import('../config/types.js').EnsembleConfig,
      },
    });

    expect(workers.get('implementer')).toMatchObject({
      preset: 'codex',
      modelTag: 'high',
      model: 'gateway/opus',
      env: {
        INITIAL_AGENT_MODE: 'agent',
        CODEX_CONFIG: '{"model":"gateway/opus"}',
      },
    });
    expect(workers.get('reviewer')).toMatchObject({
      preset: 'codex',
      modelTag: 'default',
      model: 'gateway/sonnet',
      env: {
        INITIAL_AGENT_MODE: 'agent',
        CODEX_CONFIG: '{"model":"gateway/sonnet"}',
      },
    });
  });

  it('rejects tags that reference an undefined model key before spawn', () => {
    expect(() =>
      resolveWorkerAcpSpawn({
        modelTag: 'high',
        defaultOptions: {
          config: {
            acp: {
              defaultPreset: 'codex',
              tags: { high: 'missing' },
            },
          } as import('../config/types.js').EnsembleConfig,
        },
      }),
    ).toThrow(/undefined acp\.models key "missing"/);
  });

  it('leaves the preset default in place when the worker tag has no mapping', () => {
    const resolved = resolveWorkerAcpSpawn({
      modelTag: 'high',
      defaultOptions: {
        defaultAcpCli: 'cursor',
        config: {
          acp: {
            defaultPreset: 'cursor',
            models: { standard: 'cursor/standard' },
            tags: { default: 'standard' },
          },
        } as import('../config/types.js').EnsembleConfig,
      },
    });

    expect(resolved).toMatchObject({
      preset: 'cursor',
      args: ['acp'],
      modelTag: 'high',
    });
    expect(resolved.model).toBeUndefined();
  });

  it('rejects model injection for unsupported presets before spawn', () => {
    expect(() =>
      resolveWorkerAcpSpawn({
        modelTag: 'high',
        defaultOptions: {
          defaultAcpCli: 'pi',
          config: {
            acp: {
              defaultPreset: 'cursor',
              models: { opus: 'gateway/opus' },
              tags: { high: 'opus' },
            },
          } as import('../config/types.js').EnsembleConfig,
        },
      }),
    ).toThrow(/preset "pi" does not support configured model injection/);
  });

  it.each([
    {
      preset: 'cursor' as const,
      expected: { args: ['--model', 'gateway/opus', 'acp'] },
    },
    {
      preset: 'claude' as const,
      expected: {
        sessionMeta: {
          claudeCode: { options: { settings: { model: 'gateway/opus' } } },
        },
      },
    },
    {
      preset: 'codex' as const,
      expected: { env: { CODEX_CONFIG: '{"model":"gateway/opus"}' } },
    },
  ])('injects a configured model for $preset', ({ preset, expected }) => {
    const resolved = resolveWorkerAcpSpawn({
      modelTag: 'high',
      defaultOptions: {
        defaultAcpCli: preset,
        config: {
          acp: {
            defaultPreset: 'cursor',
            models: { opus: 'gateway/opus' },
            tags: { high: 'opus' },
          },
        } as import('../config/types.js').EnsembleConfig,
      },
    });
    expect(resolved).toMatchObject({
      preset,
      modelTag: 'high',
      model: 'gateway/opus',
      ...expected,
    });
  });

  it('merges a model into the existing Codex session config', () => {
    const resolved = resolveWorkerAcpSpawn({
      modelTag: 'high',
      defaultOptions: {
        defaultAcpCli: 'codex',
        config: {
          acp: {
            defaultPreset: 'codex',
            env: { CODEX_CONFIG: '{"approval_policy":"on-request"}' },
            models: { opus: 'gateway/opus' },
            tags: { high: 'opus' },
          },
        } as import('../config/types.js').EnsembleConfig,
      },
    });

    expect(JSON.parse(resolved.env?.CODEX_CONFIG ?? '{}')).toEqual({
      approval_policy: 'on-request',
      model: 'gateway/opus',
    });
  });

  it('overrides Codex model and effort while preserving the rest of CODEX_CONFIG', () => {
    const resolved = resolveWorkerAcpSpawn({
      modelTag: 'high',
      defaultOptions: {
        env: { CODEX_CONFIG: '{"source":"parent"}' },
        config: {
          acp: {
            defaultPreset: 'codex',
            env: {
              CODEX_CONFIG: JSON.stringify({
                model: 'old-model',
                model_reasoning_effort: 'low',
                approval_policy: 'on-request',
                model_providers: { gateway: { base_url: 'https://example.test' } },
              }),
            },
            models: { high: { model: 'gateway/opus', reasoning: 'high' } },
            tags: { high: 'high' },
          },
        } as import('../config/types.js').EnsembleConfig,
      },
    });

    expect(JSON.parse(resolved.env?.CODEX_CONFIG ?? '{}')).toEqual({
      model: 'gateway/opus',
      model_reasoning_effort: 'high',
      approval_policy: 'on-request',
      model_providers: { gateway: { base_url: 'https://example.test' } },
    });
  });

  it.each([
    'gateway/opus',
    { model: 'gateway/opus' },
  ])('keeps inherited Codex effort when the catalog entry has no reasoning: %s', (entry) => {
    const resolved = resolveWorkerAcpSpawn({
      defaultOptions: {
        env: { CODEX_CONFIG: '{"model_reasoning_effort":"medium","other":true}' },
        config: {
          acp: {
            defaultPreset: 'codex',
            models: { standard: entry },
            tags: { default: 'standard' },
          },
        } as import('../config/types.js').EnsembleConfig,
      },
    });

    expect(JSON.parse(resolved.env?.CODEX_CONFIG ?? '{}')).toEqual({
      model: 'gateway/opus',
      model_reasoning_effort: 'medium',
      other: true,
    });
  });

  it.each(['not-json', 'null', '[]', '"string"'])('rejects invalid Codex JSON %s before spawn', (value) => {
    expect(() =>
      resolveWorkerAcpSpawn({
        defaultOptions: {
          env: { CODEX_CONFIG: value },
          config: {
            acp: {
              defaultPreset: 'codex',
              models: { high: { model: 'gateway/opus', reasoning: 'high' } },
              tags: { default: 'high' },
            },
          } as import('../config/types.js').EnsembleConfig,
        },
      }),
    ).toThrow(/CODEX_CONFIG to be a JSON object/);
  });

  it.each(['cursor', 'claude'] as const)(
    'rejects configured reasoning for %s rather than silently ignoring it',
    (preset) => {
      expect(() =>
        resolveWorkerAcpSpawn({
          defaultOptions: {
            env: {},
            config: {
              acp: {
                defaultPreset: preset,
                models: { high: { model: 'gateway/opus', reasoning: 'high' } },
                tags: { default: 'high' },
              },
            } as import('../config/types.js').EnsembleConfig,
          },
        }),
      ).toThrow(new RegExp(`preset "${preset}" does not support configured reasoning injection`));
    },
  );

  it.each([
    { defaultAcpCli: 'cursor' },
    { defaultAcpCli: 'claude' },
    { defaultAcpCli: 'pi' },
    { defaultAcpCommand: 'custom-agent' },
  ])('uses the native default when the selected tag is unmapped', (options) => {
    const resolved = resolveWorkerAcpSpawn({
      defaultOptions: {
        ...options,
        env: {},
        config: {
          acp: {
            defaultPreset: 'codex',
            models: { high: { model: 'gateway/opus', reasoning: 'high' } },
            tags: { high: 'high' },
          },
        } as import('../config/types.js').EnsembleConfig,
      },
    });

    expect(resolved.modelTag).toBe('default');
    expect(resolved.model).toBeUndefined();
  });

  it.each([
    { defaultAcpCli: 'pi' },
    { defaultAcpCommand: 'custom-agent' },
  ])('rejects model injection for unsupported preset $defaultAcpCli$defaultAcpCommand', (options) => {
    expect(() =>
      resolveWorkerAcpSpawn({
        defaultOptions: {
          ...options,
          env: {},
          config: {
            acp: {
              defaultPreset: 'codex',
              models: { high: { model: 'gateway/opus', reasoning: 'high' } },
              tags: { default: 'high' },
            },
          } as import('../config/types.js').EnsembleConfig,
        },
      }),
    ).toThrow(/does not support configured model injection/);
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
    expect(specs[0]?.acpFingerprint).toMatchObject({
      preset: 'codex',
      modelTag: 'default',
    });
    expect(specs[1]?.acpFingerprint).toMatchObject({
      preset: 'codex',
      modelTag: 'default',
    });
  });

  it('resolves different model tiers per worker while shorthand uses default', () => {
    const specs = profileWorkersToSessionSpecs(
      {
        workers: [
          { name: 'implementer', kind: 'implementer', modelTag: 'high' },
          normalizeProfileWorker('reviewer', 'test profile', 1),
        ],
      },
      {
        defaultAcp: {
          defaultAcpCli: 'cursor',
          config: {
            acp: {
              defaultPreset: 'cursor',
              models: { strong: 'cursor/strong', standard: 'cursor/standard' },
              tags: { high: 'strong', default: 'standard' },
            },
          } as import('../config/types.js').EnsembleConfig,
        },
      },
    );

    expect(specs.map(({ modelTag, spawn, acpFingerprint }) => ({
      modelTag,
      args: spawn?.args,
      fingerprint: acpFingerprint,
    }))).toEqual([
      {
        modelTag: 'high',
        args: ['--model', 'cursor/strong', 'acp'],
        fingerprint: {
          preset: 'cursor',
          command: 'agent',
          args: ['--model', 'cursor/strong', 'acp'],
          modelTag: 'high',
          model: 'cursor/strong',
        },
      },
      {
        modelTag: 'default',
        args: ['--model', 'cursor/standard', 'acp'],
        fingerprint: {
          preset: 'cursor',
          command: 'agent',
          args: ['--model', 'cursor/standard', 'acp'],
          modelTag: 'default',
          model: 'cursor/standard',
        },
      },
    ]);
  });
});

describe('acpSpawnFingerprint', () => {
  it('stores only a canonical env digest in the fingerprint', () => {
    const env = { MODEL_PROVIDER: 'litellm', API_TOKEN: 'private-marker' };
    expect(
      acpSpawnFingerprint({
        preset: 'codex',
        command: 'codex-acp',
        args: [],
        env,
      }),
    ).toEqual({
      preset: 'codex',
      command: 'codex-acp',
      args: [],
      envDigest: computeAcpSpawnEnvDigest(env),
    });
    expect(
      acpSpawnFingerprint({
        preset: 'codex',
        command: 'codex-acp',
        args: [],
        env: { API_TOKEN: 'private-marker', MODEL_PROVIDER: 'litellm' },
      }).envDigest,
    ).toBe(computeAcpSpawnEnvDigest(env));
  });

  it('retains worker model metadata without using it to reject resume', () => {
    const high = resolveWorkerAcpSpawn({
      modelTag: 'high',
      defaultOptions: {
        config: {
          acp: {
            defaultPreset: 'claude',
            models: { shared: 'provider/shared' },
            tags: { high: 'shared', default: 'shared' },
          },
        } as import('../config/types.js').EnsembleConfig,
      },
    });
    const standard = resolveWorkerAcpSpawn({
      modelTag: 'default',
      defaultOptions: {
        config: {
          acp: {
            defaultPreset: 'claude',
            models: { shared: 'provider/shared' },
            tags: { high: 'shared', default: 'shared' },
          },
        } as import('../config/types.js').EnsembleConfig,
      },
    });
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected: acpSpawnFingerprint(high),
        actual: acpSpawnFingerprint(standard),
        workerName: 'implementer',
      }),
    ).not.toThrow();
  });

  it('does not reject a reasoning change represented in the spawn env digest', () => {
    const resolve = (reasoning: string) =>
      resolveWorkerAcpSpawn({
        defaultOptions: {
          env: {},
          config: {
            acp: {
              defaultPreset: 'codex',
              models: { shared: { model: 'gateway/shared', reasoning } },
              tags: { default: 'shared' },
            },
          } as import('../config/types.js').EnsembleConfig,
        },
      });
    const saved = acpSpawnFingerprint(resolve('low'));
    const same = acpSpawnFingerprint(resolve('low'));
    const changed = acpSpawnFingerprint(resolve('high'));

    expect(saved.envDigest).toBe(same.envDigest);
    expect(saved.envDigest).not.toBe(changed.envDigest);
    expect(() => assertAcpSpawnMatchesResume({ expected: saved, actual: same })).not.toThrow();
    expect(() => assertAcpSpawnMatchesResume({ expected: saved, actual: changed })).not.toThrow();
    expect(saved).not.toHaveProperty('reasoning');
  });
});

describe('assertAcpSpawnMatchesResume', () => {
  it('ignores env digest, modelTag, model, and built-in model args during resume', () => {
    const savedEnv = { MODEL_PROVIDER: 'litellm' };
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected: {
          preset: 'codex',
          command: 'codex-acp',
          args: ['--model', 'old-model'],
          envDigest: computeAcpSpawnEnvDigest(savedEnv),
          modelTag: 'high',
          model: 'old-model',
        },
        actual: {
          preset: 'codex',
          command: 'codex-acp',
          args: ['--model', 'new-model'],
          envDigest: computeAcpSpawnEnvDigest({ MODEL_PROVIDER: 'openai' }),
          modelTag: 'low',
          model: 'new-model',
        },
      }),
    ).not.toThrow();
  });

  it('throws when the preset changes', () => {
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

  it('compares custom command and args while ignoring model and env metadata', () => {
    const expected: ReturnType<typeof acpSpawnFingerprint> = {
      preset: 'custom',
      command: 'custom-acp',
      args: ['--model', 'before'],
      envDigest: computeAcpSpawnEnvDigest({ TOKEN: 'before' }),
      modelTag: 'high',
      model: 'before',
    };
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected,
        actual: {
          ...expected,
          envDigest: computeAcpSpawnEnvDigest({ TOKEN: 'after' }),
          modelTag: 'low',
          model: 'after',
        },
      }),
    ).not.toThrow();

    expect(() =>
      assertAcpSpawnMatchesResume({
        expected,
        actual: { ...expected, args: ['--model', 'after'] },
      }),
    ).toThrow(/resume ACP spawn mismatch/);
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected,
        actual: { ...expected, command: 'different-acp' },
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

  it('does not reject on env digest changes in a saved resume store fingerprint', () => {
    const env = {
      INITIAL_AGENT_MODE: 'agent',
      MODEL_PROVIDER: 'litellm',
    };
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected: {
          preset: 'codex',
          command: 'codex-acp',
          args: [],
          envDigest: computeAcpSpawnEnvDigest(env),
        },
        actual: {
          preset: 'codex',
          command: 'codex-acp',
          args: [],
          envDigest: computeAcpSpawnEnvDigest(env),
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected: {
          preset: 'codex',
          command: 'codex-acp',
          args: [],
          envDigest: computeAcpSpawnEnvDigest(env),
        },
        actual: {
          preset: 'codex',
          command: 'codex-acp',
          args: [],
          envDigest: computeAcpSpawnEnvDigest({
            ...env,
            MODEL_PROVIDER: 'openai',
          }),
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
