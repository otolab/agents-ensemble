import { AuthenticationError, Cursor, type ModelListItem } from '@cursor/sdk';
import {
  CONDUCTOR_AUTH_HINT,
  resolveConductorApiKey,
  resolveConductorAuthBackend,
  type ConductorAuthOptions,
} from './conductor-auth.js';
import { listPiConductorModels } from './conductor-pi-auth.js';

export interface ListConductorModelsOptions extends ConductorAuthOptions {
  apiKey?: string;
}

/** `Cursor.models.list()` のラッパー。conductor と同じ認証解決を使う。 */
export async function listConductorModels(
  options: ListConductorModelsOptions = {},
): Promise<Array<ModelListItem | { id: string; displayName: string; description?: string }>> {
  if (resolveConductorAuthBackend(options) === 'pi') {
    return listPiConductorModels({
      ...(options.pi ?? { cwd: process.cwd() }),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.modelId ? { modelId: options.modelId } : {}),
    });
  }

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
