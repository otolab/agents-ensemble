import { createHash } from 'node:crypto';
import type { EnsembleConfig } from './types.js';

export type ResumeFeasibilityConfigClassification = 'critical' | 'neutral';

type EnsembleConfigLeafPath<T, Prefix extends string = ''> =
  [NonNullable<T>] extends [
    string | number | boolean | bigint | symbol | null,
  ]
    ? Prefix
    : NonNullable<T> extends readonly unknown[]
      ? Prefix
      : NonNullable<T> extends object
        ? string extends keyof NonNullable<T>
          ? Prefix
          : {
              [K in keyof NonNullable<T> & string]-?: EnsembleConfigLeafPath<
                NonNullable<T>[K],
                Prefix extends '' ? K : `${Prefix}.${K}`
              >;
            }[keyof NonNullable<T> & string]
        : Prefix;

/**
 * Every statically declared config leaf must have an explicit resume
 * classification. Dynamic maps such as `acp.env` and `acp.models` are
 * classified at the map path.
 */
export const RESUME_FEASIBILITY_CONFIG_CLASSIFICATION = {
  'config.loadProjectConfig': 'neutral',
  'profile.default': 'neutral',
  'conductor.model': 'neutral',
  'conductor.backend': 'neutral',
  'conductor.verbose': 'neutral',
  'conductor.pi.agentDir': 'neutral',
  'conductor.pi.projectDir': 'neutral',
  'acp.defaultPreset': 'critical',
  'acp.env': 'neutral',
  'acp.models': 'neutral',
  'acp.tags.high': 'neutral',
  'acp.tags.default': 'neutral',
  'acp.tags.low': 'neutral',
  'acp.tags.fast': 'neutral',
  'session.worktree': 'critical',
  'session.lazyWorkers': 'neutral',
  'session.maxTurns.tty': 'neutral',
  'session.maxTurns.nonTty': 'neutral',
  'session.postLoop.wait': 'neutral',
  'github.auth.allowGhAuthTokenFallback': 'neutral',
  'github.monitor.enabled': 'neutral',
  'github.monitor.debounceMs': 'neutral',
  'github.monitor.pollIntervalMs': 'neutral',
  'github.monitor.activePollIntervalMs': 'neutral',
  'github.monitor.stopPollWaitMs': 'neutral',
  'tui.layout': 'neutral',
  'tui.forceHyperlink': 'neutral',
} as const satisfies Record<
  EnsembleConfigLeafPath<EnsembleConfig>,
  ResumeFeasibilityConfigClassification
>;

/**
 * Return a stable digest for the full resolved ensemble config (scheme v1).
 *
 * The session sidecar stores this digest instead of config values, which may
 * include credentials in ACP environment variables. Object keys are sorted;
 * array order is preserved.
 */
export function computeEnsembleConfigDigest(config: EnsembleConfig): string {
  return computeCanonicalDigest(config);
}

/**
 * Return a stable digest for worker ACP model routing inputs. Values such as
 * API tokens may be present in `acp.env`; only the digest is persisted.
 */
export function computeAcpModelConfigDigest(config: EnsembleConfig): string {
  return computeCanonicalDigest({
    env: config.acp.env,
    models: config.acp.models,
    tags: config.acp.tags,
  });
}

/**
 * Return a stable digest for the config values that determine whether an
 * existing session can be reconnected (scheme v2).
 */
export function computeResumeFeasibilityConfigDigest(
  config: EnsembleConfig,
): string {
  const criticalConfig = Object.fromEntries(
    Object.entries(RESUME_FEASIBILITY_CONFIG_CLASSIFICATION)
      .filter(([, classification]) => classification === 'critical')
      .map(([path]) => [path, getConfigValueAtPath(config, path)]),
  );
  return computeCanonicalDigest(criticalConfig);
}

function computeCanonicalDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeConfigValue(value)))
    .digest('hex');
}

function getConfigValueAtPath(config: EnsembleConfig, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (typeof value !== 'object' || value === null) return undefined;
    return (value as Record<string, unknown>)[key];
  }, config);
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
