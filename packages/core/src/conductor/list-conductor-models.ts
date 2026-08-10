import { AuthenticationError, Cursor, type ModelListItem } from '@cursor/sdk';
import { CONDUCTOR_AUTH_HINT, resolveConductorApiKey } from './conductor-auth.js';

export interface ListConductorModelsOptions {
  apiKey?: string;
}

/** `Cursor.models.list()` のラッパー。conductor と同じ認証解決を使う。 */
export async function listConductorModels(
  options: ListConductorModelsOptions = {},
): Promise<ModelListItem[]> {
  const apiKey = resolveConductorApiKey(options.apiKey);
  try {
    return await Cursor.models.list(apiKey !== undefined ? { apiKey } : {});
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw new Error(`${error.message}\n\n${CONDUCTOR_AUTH_HINT}`);
    }
    throw error;
  }
}
