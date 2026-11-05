import { describe, expect, it } from 'vitest';
import { DEFAULT_ENSEMBLE_CONFIG } from './defaults.js';
import {
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

  it('includes configured ACP model reasoning in the full config digest', () => {
    const config: EnsembleConfig = {
      ...DEFAULT_ENSEMBLE_CONFIG,
      acp: {
        ...DEFAULT_ENSEMBLE_CONFIG.acp,
        models: { standard: { model: 'gateway/model', reasoning: 'low' } },
        tags: { default: 'standard' },
      },
    };
    const changed: EnsembleConfig = {
      ...config,
      acp: {
        ...config.acp,
        models: { standard: { model: 'gateway/model', reasoning: 'high' } },
      },
    };

    expect(computeEnsembleConfigDigest(config)).not.toBe(computeEnsembleConfigDigest(changed));
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
