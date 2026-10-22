import { describe, expect, it } from 'vitest';
import { DEFAULT_ENSEMBLE_CONFIG } from './defaults.js';
import { computeEnsembleConfigDigest } from './ensemble-config-digest.js';
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
});
