import type { EnsembleConfig } from '../config/types.js';
import { runGh } from './run-gh.js';

export type GitHubAuthTokenSource = 'GITHUB_TOKEN' | 'GH_TOKEN' | 'gh_auth_token';

export interface ResolveGitHubAuthTokenResult {
  token?: string;
  source?: GitHubAuthTokenSource;
}

export interface ResolveGitHubAuthTokenOptions {
  config: EnsembleConfig;
  env?: NodeJS.ProcessEnv;
  runGhFn?: typeof runGh;
}

/**
 * GitHub API 用トークンを解決する。
 * 解決順: `GITHUB_TOKEN` → `GH_TOKEN` →（config 許可時のみ）`gh auth token`。
 * 環境変数は config より優先する。
 */
export async function resolveGitHubAuthToken(
  options: ResolveGitHubAuthTokenOptions,
): Promise<ResolveGitHubAuthTokenResult> {
  const env = options.env ?? process.env;
  const githubToken = env.GITHUB_TOKEN?.trim();
  if (githubToken) {
    return { token: githubToken, source: 'GITHUB_TOKEN' };
  }

  const ghToken = env.GH_TOKEN?.trim();
  if (ghToken) {
    return { token: ghToken, source: 'GH_TOKEN' };
  }

  if (!options.config.github.auth.allowGhAuthTokenFallback) {
    return {};
  }

  const runGhFn = options.runGhFn ?? runGh;
  const token = (await runGhFn(['auth', 'token'])).trim();
  if (!token) {
    return {};
  }

  return { token, source: 'gh_auth_token' };
}
