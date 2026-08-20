import type { EnsembleConfig } from './types.js';

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * YAML から既知スキーマのみ抽出する。未知キーは無視（将来拡張用）。
 * 無効な型の既知キーは無視し、下位層 / デフォルトにフォールバックする。
 */
export function parseEnsembleConfig(raw: unknown): Partial<EnsembleConfig> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const githubRaw = (raw as Record<string, unknown>).github;
  if (!githubRaw || typeof githubRaw !== 'object') {
    return {};
  }

  const authRaw = (githubRaw as Record<string, unknown>).auth;
  if (!authRaw || typeof authRaw !== 'object') {
    return {};
  }

  const allowGhAuthTokenFallback = readBoolean(
    (authRaw as Record<string, unknown>).allowGhAuthTokenFallback,
  );
  if (allowGhAuthTokenFallback === undefined) {
    return {};
  }

  return {
    github: {
      auth: {
        allowGhAuthTokenFallback,
      },
    },
  };
}
