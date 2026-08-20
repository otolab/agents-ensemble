import { DEFAULT_ENSEMBLE_CONFIG } from '../config/defaults.js';
import type { EnsembleConfig } from '../config/types.js';
import { GitHubApiError } from './github-client.js';

/**
 * GitHub API 用トークンの解決順に沿ったヒント。
 * conductor 認証（ensemble auth login / CURSOR_API_KEY）とは別系統。
 */
export const GITHUB_AUTH_HINT =
  'GitHub API の認証が見つかりません。export GITHUB_TOKEN=... または export GH_TOKEN=... を設定するか、' +
  '（config で許可されている場合）gh auth login を実行してください。';

/** 環境変数に GitHub トークンがあるか（同期チェック）。gh フォールバックは非同期解決のみ。 */
export function hasGitHubAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim());
}

/** GitHub API エラーが認証失敗か判定する。 */
export function isGitHubAuthError(error: unknown): boolean {
  if (error instanceof GitHubApiError) {
    return error.status === 401 || error.status === 403;
  }
  if (error instanceof Error) {
    return /authentication token not found|bad credentials|requires authentication/i.test(
      error.message,
    );
  }
  return false;
}

/** GitHub 認証エラー時に stderr へ出す短い復旧手順。 */
export function formatGitHubAuthRecoveryHint(
  config: EnsembleConfig = DEFAULT_ENSEMBLE_CONFIG,
): string {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
    return (
      '[github-auth] GitHub API 認証エラー。GITHUB_TOKEN / GH_TOKEN を確認するか、' +
      'トークンのスコープ（repo 等）と有効期限を確認してください。'
    );
  }

  if (config.github.auth.allowGhAuthTokenFallback) {
    return (
      '[github-auth] GitHub API 認証エラー。export GITHUB_TOKEN=... または gh auth login を実行してください。' +
      '（conductor 認証の ensemble auth login とは別です。）'
    );
  }

  return (
    '[github-auth] GitHub API 認証エラー。export GITHUB_TOKEN=... または export GH_TOKEN=... を設定してください。' +
    '（本リポジトリの config で gh auth token フォールバックは無効です。）'
  );
}

/** monitor / fetch エラーメッセージに GitHub 復旧ヒントを付与する。 */
export function formatGitHubErrorMessage(
  error: unknown,
  config: EnsembleConfig = DEFAULT_ENSEMBLE_CONFIG,
): string {
  const base = error instanceof Error ? error.message : String(error);
  if (!isGitHubAuthError(error)) {
    return base;
  }
  return `${base}\n\n${formatGitHubAuthRecoveryHint(config)}`;
}
