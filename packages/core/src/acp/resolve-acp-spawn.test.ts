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
        env: {},
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

  it('injects a Pi model through its ACP session config option', () => {
    expect(
      resolveWorkerAcpSpawn({
        modelTag: 'high',
        defaultOptions: {
          defaultAcpCli: 'pi',
          env: {},
          config: {
            acp: {
              models: { opus: 'gateway/opus' },
              tags: { high: 'opus' },
            },
          } as import('../config/types.js').EnsembleConfig,
        },
      }),
    ).toMatchObject({
      preset: 'pi',
      modelTag: 'high',
      model: 'gateway/opus',
      sessionConfigOptionOverrides: [{ id: 'model', value: 'gateway/opus' }],
    });
  });

  it.each([
    {
      preset: 'cursor' as const,
      expected: {
        args: ['--model', 'gateway/opus', 'acp'],
      },
    },
    {
      preset: 'claude' as const,
      expected: {
        sessionMeta: {
          claudeCode: { options: { settings: { model: 'gateway/opus' } } },
        },
        sessionConfigOptionOverrides: [
          { id: 'model', value: 'gateway/opus' },
        ],
      },
    },
    {
      preset: 'codex' as const,
      expected: { env: { CODEX_CONFIG: '{"model":"gateway/opus"}' } },
    },
    {
      preset: 'pi' as const,
      expected: {
        sessionConfigOptionOverrides: [{ id: 'model', value: 'gateway/opus' }],
      },
    },
  ])('injects a configured model for $preset', ({ preset, expected }) => {
    const resolved = resolveWorkerAcpSpawn({
      modelTag: 'high',
      defaultOptions: {
        defaultAcpCli: preset,
        env: {},
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
    if (preset === 'cursor') {
      expect(resolved.clientCapabilitiesMeta).toBeUndefined();
    }
  });

  it('keeps Cursor defaults when cursorFast is omitted and fails fast on unverified options', () => {
    const resolve = (definition: {
      model: string;
      reasoning?: string;
      cursorFast?: boolean;
    }) =>
      resolveWorkerAcpSpawn({
        defaultOptions: {
          defaultAcpCli: 'cursor',
          env: {},
          config: {
            acp: {
              models: { selected: definition },
              tags: { default: 'selected' },
            },
          } as import('../config/types.js').EnsembleConfig,
        },
      });

    const modelOnly = resolve({ model: 'cursor-grok-4.6-high' });
    expect(modelOnly.args).toEqual([
      '--model',
      'cursor-grok-4.6-high',
      'acp',
    ]);
    expect(modelOnly.clientCapabilitiesMeta).toBeUndefined();
    expect(modelOnly.sessionConfigOptionOverrides).toBeUndefined();

    expect(() =>
      resolve({ model: 'cursor-grok-4.6-high', reasoning: 'high' }),
    ).toThrow(/Cursor ACP cannot verify.*reasoning.*runtime model/);
    expect(() =>
      resolve({ model: 'cursor-grok-4.6-high', cursorFast: false }),
    ).toThrow(/Cursor ACP cannot verify.*cursorFast.*runtime model/);
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

  it('preserves MODEL_PROVIDER precedence and fingerprints inherited providers separately', () => {
    const resolve = (provider: string, configProvider?: string) =>
      resolveWorkerAcpSpawn({
        modelTag: 'high',
        defaultOptions: {
          env: {
            MODEL_PROVIDER: provider,
            CODEX_CONFIG: JSON.stringify({ model_provider: 'codex-config-provider' }),
          },
          config: {
            acp: {
              defaultPreset: 'codex',
              ...(configProvider
                ? { env: { MODEL_PROVIDER: configProvider } }
                : {}),
              models: { high: { model: 'gateway/opus', reasoning: 'high' } },
              tags: { high: 'high' },
            },
          } as import('../config/types.js').EnsembleConfig,
        },
      });

    const inherited = resolve('ambient-provider');
    const configured = resolve('ambient-provider', 'config-provider');
    const inheritedFingerprint = acpSpawnFingerprint(inherited);
    const changedFingerprint = acpSpawnFingerprint(
      resolve('different-provider'),
    );
    const configuredFingerprint = acpSpawnFingerprint(configured);

    expect(inherited.env?.MODEL_PROVIDER).toBeUndefined();
    expect(configured.env?.MODEL_PROVIDER).toBe('config-provider');
    expect(JSON.parse(inherited.env?.CODEX_CONFIG ?? '{}')).toEqual({
      model_provider: 'codex-config-provider',
      model: 'gateway/opus',
      model_reasoning_effort: 'high',
    });
    expect(inheritedFingerprint.envDigest).toBeDefined();
    expect(inheritedFingerprint.envDigest).toBe(changedFingerprint.envDigest);
    expect(inheritedFingerprint.modelProviderDigest).not.toBe(
      changedFingerprint.modelProviderDigest,
    );
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected: inheritedFingerprint,
        actual: changedFingerprint,
      }),
    ).not.toThrow();
    expect(configuredFingerprint.modelProviderDigest).toBe(
      acpSpawnFingerprint(resolve('another-ambient-provider', 'config-provider'))
        .modelProviderDigest,
    );
    expect(configuredFingerprint.envDigest).not.toBe(inheritedFingerprint.envDigest);
  });

  it('fingerprints MODEL_PROVIDER being added to or removed from a resumed worker', () => {
    const config = {
      acp: {
        defaultPreset: 'codex',
        models: { high: { model: 'gateway/opus', reasoning: 'high' } },
        tags: { high: 'high' },
      },
    } as import('../config/types.js').EnsembleConfig;
    const resolve = (modelProvider?: string) =>
      resolveWorkerAcpSpawn({
        modelTag: 'high',
        defaultOptions: {
          env: {
            CODEX_CONFIG: JSON.stringify({ model_provider: 'codex-config-provider' }),
            ...(modelProvider !== undefined
              ? { MODEL_PROVIDER: modelProvider }
              : {}),
          },
          config,
        },
      });

    const withoutProvider = acpSpawnFingerprint(resolve());
    const withProvider = acpSpawnFingerprint(resolve('ambient-provider'));

    expect(withoutProvider.modelProviderDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(withoutProvider.modelProviderDigest).not.toBe(
      withProvider.modelProviderDigest,
    );
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected: withoutProvider,
        actual: withProvider,
      }),
    ).not.toThrow();
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected: withProvider,
        actual: withoutProvider,
      }),
    ).not.toThrow();
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

  it.each([
    {
      preset: 'claude' as const,
      expected: {
        sessionConfigOptionOverrides: [
          { id: 'model', value: 'gateway/opus' },
          { id: 'effort', value: 'high' },
        ],
      },
    },
    {
      preset: 'pi' as const,
      expected: {
        sessionConfigOptionOverrides: [
          { id: 'model', value: 'gateway/opus' },
          { id: 'thought_level', value: 'high' },
        ],
      },
    },
  ])('resolves configured reasoning for $preset', ({ preset, expected }) => {
    const resolved = resolveWorkerAcpSpawn({
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
    });
    expect(resolved).toMatchObject({
      preset,
      modelTag: 'default',
      model: 'gateway/opus',
      reasoning: 'high',
      ...expected,
    });
  });

  it('rejects cursorFast for non-Cursor presets', () => {
    expect(() =>
      resolveWorkerAcpSpawn({
        defaultOptions: {
          defaultAcpCli: 'codex',
          env: {},
          config: {
            acp: {
              models: {
                selected: { model: 'gateway/model', cursorFast: false },
              },
              tags: { default: 'selected' },
            },
          } as import('../config/types.js').EnsembleConfig,
        },
      }),
    ).toThrow(
      /cursorFast is supported only by the "cursor" ACP preset.*0051-cursor-acp-runtime-verification\.md/,
    );
  });

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

  it('rejects model injection for custom before spawn with documentation links', () => {
    expect(() =>
      resolveWorkerAcpSpawn({
        defaultOptions: {
          defaultAcpCommand: 'custom-agent',
          env: {},
          config: {
            acp: {
              models: { high: { model: 'gateway/opus', reasoning: 'high' } },
              tags: { default: 'high' },
            },
          } as import('../config/types.js').EnsembleConfig,
        },
      }),
    ).toThrow(/does not support configured model injection.*docs\/config\.md.*0049-acp-model-injection-by-preset\.md/);
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
      clientCapabilitiesMeta: spawn?.clientCapabilitiesMeta,
      fingerprint: acpFingerprint,
    }))).toEqual([
      {
        modelTag: 'high',
        args: ['--model', 'cursor/strong', 'acp'],
        clientCapabilitiesMeta: undefined,
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
        clientCapabilitiesMeta: undefined,
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

  it('records worker modelTag changes without rejecting resume', () => {
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
    const expected = acpSpawnFingerprint(high);
    const actual = acpSpawnFingerprint(standard);
    expect(expected.modelTag).toBe('high');
    expect(actual.modelTag).toBe('default');
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected,
        actual,
        workerName: 'implementer',
      }),
    ).not.toThrow();
  });

  it('records a Codex reasoning change in the spawn env digest without rejecting resume', () => {
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
    expect(saved.reasoning).toBe('low');
    expect(() => assertAcpSpawnMatchesResume({ expected: saved, actual: same })).not.toThrow();
    expect(() =>
      assertAcpSpawnMatchesResume({ expected: saved, actual: changed }),
    ).not.toThrow();
  });

  it('accepts a legacy Codex fingerprint without reasoning or provider digest fields', () => {
    const spawn = resolveWorkerAcpSpawn({
      defaultOptions: {
        env: { MODEL_PROVIDER: 'legacy-provider' },
        config: {
          acp: {
            defaultPreset: 'codex',
            models: { shared: { model: 'gateway/shared', reasoning: 'high' } },
            tags: { default: 'shared' },
          },
        } as import('../config/types.js').EnsembleConfig,
      },
    });
    const current = acpSpawnFingerprint(spawn);
    const legacy = {
      preset: current.preset,
      command: current.command,
      args: current.args,
      modelTag: current.modelTag,
      model: current.model,
      envDigest: current.envDigest,
    };

    expect(() =>
      assertAcpSpawnMatchesResume({ expected: legacy, actual: current }),
    ).not.toThrow();
  });
});

describe('assertAcpSpawnMatchesResume', () => {
  it('records built-in model and env fields without using them to reject resume', () => {
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected: {
          preset: 'codex',
          command: 'codex-acp',
          args: ['--model', 'old-model'],
          envDigest: computeAcpSpawnEnvDigest({ MODEL_PROVIDER: 'litellm' }),
          modelProviderDigest: 'a'.repeat(64),
          modelTag: 'high',
          model: 'old-model',
          reasoning: 'low',
          cursorFast: false,
        },
        actual: {
          preset: 'codex',
          command: 'codex-acp',
          args: ['--model', 'new-model'],
          envDigest: computeAcpSpawnEnvDigest({ MODEL_PROVIDER: 'openai' }),
          modelProviderDigest: 'b'.repeat(64),
          modelTag: 'low',
          model: 'new-model',
          reasoning: 'high',
          cursorFast: true,
        },
      }),
    ).not.toThrow();

    expect(() =>
      assertAcpSpawnMatchesResume({
        expected: {
          preset: 'codex',
          command: 'codex-acp',
          args: ['--model', 'old-model'],
          modelTag: 'high',
          model: 'model',
          reasoning: 'high',
        },
        actual: {
          preset: 'codex',
          command: 'codex-acp',
          args: ['--model', 'new-model'],
          modelTag: 'high',
          model: 'model',
          reasoning: 'high',
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

  it('compares custom command and args while allowing model and env changes', () => {
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

  it('records a change in the saved reasoning effort without rejecting resume', () => {
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected: {
          preset: 'claude',
          command: 'claude-agent-acp',
          args: [],
          modelTag: 'high',
          model: 'provider/opus',
          reasoning: 'low',
        },
        actual: {
          preset: 'claude',
          command: 'claude-agent-acp',
          args: [],
          modelTag: 'high',
          model: 'provider/opus',
          reasoning: 'high',
        },
      }),
    ).not.toThrow();
  });

  it('records a change in the saved Cursor fast mode without rejecting resume', () => {
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected: {
          preset: 'cursor',
          command: 'agent',
          args: ['--model', 'cursor-grok-4.6-high', 'acp'],
          model: 'cursor-grok-4.6-high',
          cursorFast: false,
        },
        actual: {
          preset: 'cursor',
          command: 'agent',
          args: ['--model', 'cursor-grok-4.6-high', 'acp'],
          model: 'cursor-grok-4.6-high',
          cursorFast: true,
        },
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

  it('records env digest changes in a saved resume store fingerprint', () => {
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
    const changedEnvFingerprint = {
      preset: 'codex' as const,
      command: 'codex-acp',
      args: [],
      envDigest: computeAcpSpawnEnvDigest({
        ...env,
        MODEL_PROVIDER: 'openai',
      }),
    };
    expect(changedEnvFingerprint.envDigest).not.toBe(
      computeAcpSpawnEnvDigest(env),
    );
    expect(() =>
      assertAcpSpawnMatchesResume({
        expected: {
          preset: 'codex',
          command: 'codex-acp',
          args: [],
          envDigest: computeAcpSpawnEnvDigest(env),
        },
        actual: changedEnvFingerprint,
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
