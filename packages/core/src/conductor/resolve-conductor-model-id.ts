/** `ensemble models list` の default（Auto）と一致する conductor 用 model id。 */
export const DEFAULT_CONDUCTOR_MODEL_ID = 'default';

/** e2e / integration と本番 CLI で共有する環境変数名。 */
export const CONDUCTOR_MODEL_ID_ENV = 'CONDUCTOR_MODEL_ID';

/** `auto` はカタログ上の `default`（Auto）と同義。 */
export function normalizeConductorModelId(modelId: string): string {
  return modelId === 'auto' ? DEFAULT_CONDUCTOR_MODEL_ID : modelId;
}

/**
 * conductor の model id を解決する。
 * 優先順位: 明示指定 → `CONDUCTOR_MODEL_ID` → `default`。
 */
export function resolveConductorModelId(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') {
    return normalizeConductorModelId(explicit);
  }

  const fromEnv = process.env[CONDUCTOR_MODEL_ID_ENV];
  if (fromEnv !== undefined && fromEnv !== '') {
    return normalizeConductorModelId(fromEnv);
  }

  return DEFAULT_CONDUCTOR_MODEL_ID;
}
