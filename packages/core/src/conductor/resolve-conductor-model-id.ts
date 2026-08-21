import { resolveConductorModelSetting } from '../config/resolve-settings.js';
import type { EnsembleConfig } from '../config/types.js';

/** `ensemble models list` の default（Auto）と一致する conductor 用 model id。 */
export const DEFAULT_CONDUCTOR_MODEL_ID = 'default';

/** e2e / integration と本番 CLI で共有する環境変数名。 */
export { CONDUCTOR_MODEL_ID_ENV } from '../config/resolve-settings.js';

/** `auto` はカタログ上の `default`（Auto）と同義。 */
export function normalizeConductorModelId(modelId: string): string {
  return modelId === 'auto' ? DEFAULT_CONDUCTOR_MODEL_ID : modelId;
}

/**
 * conductor の model id を解決する。
 * 優先順位: CLI 明示 > `CONDUCTOR_MODEL_ID` > config > `default`。
 */
export function resolveConductorModelId(
  explicit?: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    config?: EnsembleConfig;
  },
): string {
  return resolveConductorModelSetting({
    cliModel: explicit,
    env: options?.env ?? process.env,
    config: options?.config,
  });
}
