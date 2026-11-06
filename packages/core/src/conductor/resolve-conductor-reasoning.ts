import { resolveConductorReasoningSetting } from '../config/resolve-settings.js';
import type { EnsembleConfig } from '../config/types.js';

/** Conductor の reasoning override に使う環境変数。 */
export { CONDUCTOR_REASONING_ENV } from '../config/resolve-settings.js';

/**
 * conductor の reasoning / thinking level を解決する。
 * 優先順位: CLI 明示 > `CONDUCTOR_REASONING` > config > backend default。
 * CLI 明示値は `ensemble issue` の invocation override に使う。
 */
export function resolveConductorReasoning(
  explicit?: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    config?: EnsembleConfig;
  },
): string | undefined {
  return resolveConductorReasoningSetting({
    cliReasoning: explicit,
    env: options?.env ?? process.env,
    config: options?.config,
  });
}
