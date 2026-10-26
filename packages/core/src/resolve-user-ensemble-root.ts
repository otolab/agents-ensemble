import { homedir } from 'node:os';
import { join } from 'node:path';

export const ENSEMBLE_USER_ROOT_ENV = 'ENSEMBLE_USER_ROOT';
export const DEFAULT_USER_ENSEMBLE_DIRECTORY = '.ensemble';

export interface ResolveUserEnsembleRootOptions {
  /** Explicit user root, primarily for isolated callers and tests. */
  userEnsembleRoot?: string;
  /** Legacy home override; takes precedence over the process environment. */
  home?: string;
}

/**
 * Resolve the user-level Ensemble directory.
 *
 * An explicit root wins, followed by the legacy home override, then
 * ENSEMBLE_USER_ROOT, and finally ~/.ensemble.
 */
export function resolveUserEnsembleRoot(
  options: ResolveUserEnsembleRootOptions = {},
): string {
  if (options.userEnsembleRoot !== undefined) {
    return options.userEnsembleRoot;
  }
  if (options.home !== undefined) {
    return join(options.home, DEFAULT_USER_ENSEMBLE_DIRECTORY);
  }
  const configuredRoot = process.env[ENSEMBLE_USER_ROOT_ENV];
  if (configuredRoot !== undefined && configuredRoot !== '') {
    return configuredRoot;
  }
  return join(homedir(), DEFAULT_USER_ENSEMBLE_DIRECTORY);
}
