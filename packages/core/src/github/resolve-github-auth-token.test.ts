import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENSEMBLE_CONFIG } from '../config/defaults.js';
import { resolveGitHubAuthToken } from './resolve-github-auth-token.js';

describe('resolveGitHubAuthToken', () => {
  it('prefers GITHUB_TOKEN over GH_TOKEN and gh auth token', async () => {
    const runGhFn = vi.fn();

    const result = await resolveGitHubAuthToken({
      config: DEFAULT_ENSEMBLE_CONFIG,
      env: {
        GITHUB_TOKEN: ' github-token ',
        GH_TOKEN: 'gh-token',
      },
      runGhFn,
    });

    expect(result).toEqual({ token: 'github-token', source: 'GITHUB_TOKEN' });
    expect(runGhFn).not.toHaveBeenCalled();
  });

  it('uses GH_TOKEN when GITHUB_TOKEN is absent', async () => {
    const runGhFn = vi.fn();

    const result = await resolveGitHubAuthToken({
      config: DEFAULT_ENSEMBLE_CONFIG,
      env: {
        GH_TOKEN: 'gh-token',
      },
      runGhFn,
    });

    expect(result).toEqual({ token: 'gh-token', source: 'GH_TOKEN' });
    expect(runGhFn).not.toHaveBeenCalled();
  });

  it('falls back to gh auth token when env tokens are absent', async () => {
    const runGhFn = vi.fn().mockResolvedValue('gh-cli-token\n');

    const result = await resolveGitHubAuthToken({
      config: DEFAULT_ENSEMBLE_CONFIG,
      env: {},
      runGhFn,
    });

    expect(result).toEqual({ token: 'gh-cli-token', source: 'gh_auth_token' });
    expect(runGhFn).toHaveBeenCalledWith(['auth', 'token']);
  });


  it('returns empty result when gh auth token fails (best-effort fallback)', async () => {
    const runGhFn = vi.fn().mockRejectedValue(new Error('gh auth token failed'));

    const result = await resolveGitHubAuthToken({
      config: DEFAULT_ENSEMBLE_CONFIG,
      env: {},
      runGhFn,
    });

    expect(result).toEqual({});
  });
  it('does not call gh auth token when allowGhAuthTokenFallback is false', async () => {
    const runGhFn = vi.fn();

    const result = await resolveGitHubAuthToken({
      config: {
        github: {
          auth: {
            allowGhAuthTokenFallback: false,
          },
        },
      },
      env: {},
      runGhFn,
    });

    expect(result).toEqual({});
    expect(runGhFn).not.toHaveBeenCalled();
  });

  it('env tokens override config even when allowGhAuthTokenFallback is false', async () => {
    const runGhFn = vi.fn();

    const result = await resolveGitHubAuthToken({
      config: {
        github: {
          auth: {
            allowGhAuthTokenFallback: false,
          },
        },
      },
      env: {
        GH_TOKEN: 'env-token',
      },
      runGhFn,
    });

    expect(result).toEqual({ token: 'env-token', source: 'GH_TOKEN' });
    expect(runGhFn).not.toHaveBeenCalled();
  });
});
