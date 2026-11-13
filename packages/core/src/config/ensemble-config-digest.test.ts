import { describe, expect, it } from 'vitest';
import { DEFAULT_ENSEMBLE_CONFIG } from './defaults.js';
import {
  computeAcpModelConfigDigest,
  computeEnsembleConfigDigest,
  computeResumeFeasibilityConfigDigest,
  RESUME_FEASIBILITY_CONFIG_CLASSIFICATION,
} from './ensemble-config-digest.js';
import type { EnsembleConfig } from './types.js';

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseObjectKeys);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
    );
  }
  return value;
}

function changeConfigPath(
  config: EnsembleConfig,
  path: string,
): EnsembleConfig {
  const changed = structuredClone(config) as unknown as Record<
    string,
    unknown
  >;
  const segments = path.split('.');
  let parent = changed;
  for (const segment of segments.slice(0, -1)) {
    const value = parent[segment];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      parent[segment] = {};
    }
    parent = parent[segment] as Record<string, unknown>;
  }

  const key = segments.at(-1)!;
  const value = parent[key];
  if (path === 'acp.env') {
    parent[key] = { ADDED_FOR_TEST: 'changed' };
  } else if (path === 'acp.models') {
    parent[key] = { addedForTest: 'changed-model' };
  } else if (path === 'acp.defaultPreset') {
    parent[key] = 'claude';
  } else if (path === 'session.worktree') {
    parent[key] = 'in-repo';
  } else if (typeof value === 'boolean') {
    parent[key] = !value;
  } else if (typeof value === 'number') {
    parent[key] = value + 1;
  } else if (value === 'cursor') {
    parent[key] = 'pi';
  } else if (typeof value === 'string') {
    parent[key] = `${value}-changed`;
  } else {
    parent[key] = 'changed';
  }
  return changed as unknown as EnsembleConfig;
}

describe('computeEnsembleConfigDigest', () => {
  it('is canonical and does not expose config values', () => {
    const config: EnsembleConfig = {
      ...DEFAULT_ENSEMBLE_CONFIG,
      conductor: {
        ...DEFAULT_ENSEMBLE_CONFIG.conductor,
        model: 'litellm/model-a',
      },
      acp: {
        ...DEFAULT_ENSEMBLE_CONFIG.acp,
        env: { PROVIDER_TOKEN: 'private-test-value' },
      },
    };

    const digest = computeEnsembleConfigDigest(config);
    const reordered = computeEnsembleConfigDigest(
      reverseObjectKeys(config) as EnsembleConfig,
    );
    const changed = computeEnsembleConfigDigest({
      ...config,
      conductor: { ...config.conductor, model: 'litellm/model-b' },
    });

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).toBe(reordered);
    expect(digest).not.toBe(changed);
    expect(digest).not.toContain('private-test-value');
  });

  it('includes configured ACP model, reasoning, and Cursor fast setting in the full config digest', () => {
    const config: EnsembleConfig = {
      ...DEFAULT_ENSEMBLE_CONFIG,
      acp: {
        ...DEFAULT_ENSEMBLE_CONFIG.acp,
        models: {
          standard: {
            model: 'gateway/model',
            reasoning: 'low',
            cursorFast: false,
          },
        },
        tags: { default: 'standard' },
      },
    };
    const changedReasoning: EnsembleConfig = {
      ...config,
      acp: {
        ...config.acp,
        models: {
          standard: {
            model: 'gateway/model',
            reasoning: 'high',
            cursorFast: false,
          },
        },
      },
    };
    const changedModel: EnsembleConfig = {
      ...config,
      acp: {
        ...config.acp,
        models: {
          standard: {
            model: 'gateway/other-model',
            reasoning: 'low',
            cursorFast: false,
          },
        },
      },
    };
    const changedCursorFast: EnsembleConfig = {
      ...config,
      acp: {
        ...config.acp,
        models: {
          standard: {
            model: 'gateway/model',
            reasoning: 'low',
            cursorFast: true,
          },
        },
      },
    };

    expect(computeEnsembleConfigDigest(config)).not.toBe(
      computeEnsembleConfigDigest(changedReasoning),
    );
    expect(computeEnsembleConfigDigest(config)).not.toBe(
      computeEnsembleConfigDigest(changedModel),
    );
    expect(computeEnsembleConfigDigest(config)).not.toBe(
      computeEnsembleConfigDigest(changedCursorFast),
    );
  });
});

describe('computeAcpModelConfigDigest', () => {
  it('tracks model routing inputs canonically without exposing env values', () => {
    const config: EnsembleConfig = {
      ...DEFAULT_ENSEMBLE_CONFIG,
      acp: {
        ...DEFAULT_ENSEMBLE_CONFIG.acp,
        env: { MODEL_PROVIDER: 'litellm', API_TOKEN: 'private-test-value' },
        models: {
          strong: {
            model: 'gateway/model-a',
            reasoning: 'high',
            cursorFast: false,
          },
        },
        tags: { high: 'strong', lite: 'short', urgent: 'priority' },
      },
    };
    const digest = computeAcpModelConfigDigest(config);
    const reordered = computeAcpModelConfigDigest(
      reverseObjectKeys(config) as EnsembleConfig,
    );
    const changedReasoning: EnsembleConfig = {
      ...config,
      acp: {
        ...config.acp,
        models: {
          strong: {
            model: 'gateway/model-a',
            reasoning: 'low',
            cursorFast: false,
          },
        },
      },
    };
    const changedModel: EnsembleConfig = {
      ...config,
      acp: {
        ...config.acp,
        models: {
          strong: {
            model: 'gateway/model-b',
            reasoning: 'high',
            cursorFast: false,
          },
        },
      },
    };
    const changedEnv: EnsembleConfig = {
      ...config,
      acp: {
        ...config.acp,
        env: { MODEL_PROVIDER: 'openai', API_TOKEN: 'private-test-value' },
      },
    };
    const changedTag: EnsembleConfig = {
      ...config,
      acp: {
        ...config.acp,
        tags: { high: 'strong', lite: 'short', urgent: 'other-model' },
      },
    };

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).toBe(reordered);
    expect(digest).not.toContain('private-test-value');
    expect(digest).not.toBe(computeAcpModelConfigDigest(changedReasoning));
    expect(digest).not.toBe(computeAcpModelConfigDigest(changedModel));
    expect(digest).not.toBe(computeAcpModelConfigDigest(changedEnv));
    expect(digest).not.toBe(computeAcpModelConfigDigest(changedTag));
  });

  it('keeps conductor reasoning out of the resume digest and in the legacy full digest', () => {
    const config: EnsembleConfig = {
      ...DEFAULT_ENSEMBLE_CONFIG,
      conductor: {
        ...DEFAULT_ENSEMBLE_CONFIG.conductor,
        reasoning: 'low',
      },
    };
    const changed: EnsembleConfig = {
      ...config,
      conductor: { ...config.conductor, reasoning: 'high' },
    };

    expect(computeResumeFeasibilityConfigDigest(config)).toBe(
      computeResumeFeasibilityConfigDigest(changed),
    );
    expect(computeEnsembleConfigDigest(config)).not.toBe(
      computeEnsembleConfigDigest(changed),
    );
  });
});

describe('computeResumeFeasibilityConfigDigest', () => {
  it('keeps every explicitly classified neutral config leaf out of the digest', () => {
    const digest = computeResumeFeasibilityConfigDigest(
      DEFAULT_ENSEMBLE_CONFIG,
    );
    const neutralPaths = Object.entries(
      RESUME_FEASIBILITY_CONFIG_CLASSIFICATION,
    )
      .filter(([, classification]) => classification === 'neutral')
      .map(([path]) => path);

    expect(neutralPaths.length).toBeGreaterThan(0);
    for (const path of neutralPaths) {
      expect(
        computeResumeFeasibilityConfigDigest(
          changeConfigPath(DEFAULT_ENSEMBLE_CONFIG, path),
        ),
        path,
      ).toBe(digest);
    }
  });

  it('keeps arbitrary ACP tag mappings out of the resume feasibility digest', () => {
    const config: EnsembleConfig = {
      ...DEFAULT_ENSEMBLE_CONFIG,
      acp: {
        ...DEFAULT_ENSEMBLE_CONFIG.acp,
        tags: { lite: 'short', urgent: 'priority' },
      },
    };
    const changed: EnsembleConfig = {
      ...config,
      acp: {
        ...config.acp,
        tags: { lite: 'shorter', urgent: 'different' },
      },
    };

    expect(computeResumeFeasibilityConfigDigest(changed)).toBe(
      computeResumeFeasibilityConfigDigest(config),
    );
  });

  it('changes when any critical config leaf changes', () => {
    const digest = computeResumeFeasibilityConfigDigest(
      DEFAULT_ENSEMBLE_CONFIG,
    );
    const criticalPaths = Object.entries(
      RESUME_FEASIBILITY_CONFIG_CLASSIFICATION,
    )
      .filter(([, classification]) => classification === 'critical')
      .map(([path]) => path);

    expect(criticalPaths.sort()).toEqual([
      'acp.defaultPreset',
      'session.worktree',
    ]);
    for (const path of criticalPaths) {
      expect(
        computeResumeFeasibilityConfigDigest(
          changeConfigPath(DEFAULT_ENSEMBLE_CONFIG, path),
        ),
        path,
      ).not.toBe(digest);
    }
  });

  it('canonicalizes the critical projection independently of neutral config', () => {
    const changedNeutral = changeConfigPath(
      DEFAULT_ENSEMBLE_CONFIG,
      'conductor.model',
    );
    expect(
      computeResumeFeasibilityConfigDigest(changedNeutral),
    ).toBe(computeResumeFeasibilityConfigDigest(DEFAULT_ENSEMBLE_CONFIG));
    expect(
      computeResumeFeasibilityConfigDigest(
        reverseObjectKeys(DEFAULT_ENSEMBLE_CONFIG) as EnsembleConfig,
      ),
    ).toBe(computeResumeFeasibilityConfigDigest(DEFAULT_ENSEMBLE_CONFIG));
  });
});
