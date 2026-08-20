import { describe, expect, it } from 'vitest';
import { DEFAULT_ENSEMBLE_CONFIG } from '../config/defaults.js';
import {
  formatGitHubAuthRecoveryHint,
  formatGitHubErrorMessage,
  hasGitHubAuth,
  isGitHubAuthError,
} from './github-auth.js';
import { GitHubApiError } from './github-client.js';

describe('github-auth', () => {
  it('hasGitHubAuth detects env tokens', () => {
    expect(hasGitHubAuth({ GITHUB_TOKEN: 'token' })).toBe(true);
    expect(hasGitHubAuth({ GH_TOKEN: 'token' })).toBe(true);
    expect(hasGitHubAuth({})).toBe(false);
  });

  it('isGitHubAuthError detects GitHubApiError 401/403', () => {
    expect(isGitHubAuthError(new GitHubApiError('bad', { status: 401 }))).toBe(true);
    expect(isGitHubAuthError(new GitHubApiError('bad', { status: 403 }))).toBe(true);
    expect(isGitHubAuthError(new GitHubApiError('bad', { status: 500 }))).toBe(false);
  });

  it('formatGitHubAuthRecoveryHint mentions gh auth when fallback enabled', () => {
    const hint = formatGitHubAuthRecoveryHint(DEFAULT_ENSEMBLE_CONFIG);
    expect(hint).toContain('[github-auth]');
    expect(hint).toContain('gh auth login');
    expect(hint).toContain('conductor 認証');
  });

  it('formatGitHubErrorMessage appends recovery hint for auth errors', () => {
    const message = formatGitHubErrorMessage(
      new GitHubApiError('GitHub API 401: Bad credentials', { status: 401 }),
      DEFAULT_ENSEMBLE_CONFIG,
    );
    expect(message).toContain('Bad credentials');
    expect(message).toContain('[github-auth]');
  });
});
