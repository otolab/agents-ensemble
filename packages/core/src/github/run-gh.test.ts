import { describe, expect, it } from 'vitest';
import { RunGhError, classifyRunGhFailure } from './run-gh.js';

describe('classifyRunGhFailure', () => {
  it('classifies auth failures', () => {
    const error = classifyRunGhFailure(['auth', 'token'], 'not logged in to github.com');
    expect(error).toBeInstanceOf(RunGhError);
    expect(error.cause).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('gh auth login');
  });

  it('classifies rate limit failures as retryable', () => {
    const error = classifyRunGhFailure(['api', 'repos/o/r'], 'API rate limit exceeded');
    expect(error.cause).toBe('rate_limit');
    expect(error.retryable).toBe(true);
  });

  it('classifies repository access failures', () => {
    const error = classifyRunGhFailure(
      ['pr', 'view', '1'],
      'Could not resolve to a Repository with the name org/missing',
    );
    expect(error.cause).toBe('repo_access');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('リポジトリアクセス');
  });
});
