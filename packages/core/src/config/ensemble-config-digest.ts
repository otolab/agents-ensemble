import { createHash } from 'node:crypto';
import type { EnsembleConfig } from './types.js';

/**
 * Return a stable digest for the resolved ensemble config.
 *
 * The session sidecar stores this digest instead of config values, which may
 * include credentials in ACP environment variables. Object keys are sorted;
 * array order is preserved.
 */
export function computeEnsembleConfigDigest(config: EnsembleConfig): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeConfigValue(config)))
    .digest('hex');
}

function canonicalizeConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeConfigValue(entry));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonicalizeConfigValue((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}
