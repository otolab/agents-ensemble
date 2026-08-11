import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGit } from '../git/run-git.js';
import {
  parseGitHubRemoteUrl,
  resolveIssueUrl,
} from './resolve-issue-url.js';

describe('parseGitHubRemoteUrl', () => {
  it('parses HTTPS origin', () => {
    expect(parseGitHubRemoteUrl('https://github.com/otolab/agents-ensemble.git')).toEqual({
      owner: 'otolab',
      repo: 'agents-ensemble',
    });
  });

  it('parses HTTPS origin without .git suffix', () => {
    expect(parseGitHubRemoteUrl('https://github.com/org/repo')).toEqual({
      owner: 'org',
      repo: 'repo',
    });
  });

  it('parses SSH origin', () => {
    expect(parseGitHubRemoteUrl('git@github.com:otolab/agents-ensemble.git')).toEqual({
      owner: 'otolab',
      repo: 'agents-ensemble',
    });
  });

  it('parses SSH origin without .git suffix', () => {
    expect(parseGitHubRemoteUrl('git@github.com:org/repo')).toEqual({
      owner: 'org',
      repo: 'repo',
    });
  });

  it('returns null for non-GitHub remotes', () => {
    expect(parseGitHubRemoteUrl('git@gitlab.com:org/repo.git')).toBeNull();
    expect(parseGitHubRemoteUrl('https://example.com/org/repo.git')).toBeNull();
  });
});

describe('resolveIssueUrl', () => {
  let repoRoot = '';

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-resolve-issue-'));
    await runGit(['init'], repoRoot);
    await runGit(['config', 'user.email', 'test@example.com'], repoRoot);
    await runGit(['config', 'user.name', 'test'], repoRoot);
    await runGit(['commit', '--allow-empty', '-m', 'init'], repoRoot);
  });

  afterEach(async () => {
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
  });

  async function withOrigin(remoteUrl: string): Promise<void> {
    await runGit(['remote', 'add', 'origin', remoteUrl], repoRoot);
  }

  it('resolves issue number shorthand', async () => {
    await withOrigin('https://github.com/otolab/agents-ensemble.git');
    await expect(resolveIssueUrl('31', repoRoot)).resolves.toBe(
      'https://github.com/otolab/agents-ensemble/issues/31',
    );
  });

  it('resolves #number shorthand', async () => {
    await withOrigin('git@github.com:otolab/agents-ensemble.git');
    await expect(resolveIssueUrl('#31', repoRoot)).resolves.toBe(
      'https://github.com/otolab/agents-ensemble/issues/31',
    );
  });

  it('passes through full GitHub Issue URLs', async () => {
    await withOrigin('https://github.com/otolab/agents-ensemble.git');
    await expect(
      resolveIssueUrl('https://github.com/other/repo/issues/9', repoRoot),
    ).resolves.toBe('https://github.com/other/repo/issues/9');
  });

  it('normalizes trailing slash on full URLs', async () => {
    await withOrigin('https://github.com/otolab/agents-ensemble.git');
    await expect(
      resolveIssueUrl('https://github.com/otolab/agents-ensemble/issues/3/', repoRoot),
    ).resolves.toBe('https://github.com/otolab/agents-ensemble/issues/3');
  });

  it('rejects non-git directories', async () => {
    const nonGitDir = await mkdtemp(join(tmpdir(), 'ensemble-non-git-'));
    try {
      await expect(resolveIssueUrl('31', nonGitDir)).rejects.toThrow(
        /not a git repository or origin remote is missing/,
      );
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });

  it('rejects non-GitHub origin', async () => {
    await withOrigin('git@gitlab.com:org/repo.git');
    await expect(resolveIssueUrl('31', repoRoot)).rejects.toThrow(
      /expected a github.com remote URL/,
    );
  });

  it('rejects invalid issue references', async () => {
    await withOrigin('https://github.com/otolab/agents-ensemble.git');
    await expect(resolveIssueUrl('not-a-url', repoRoot)).rejects.toThrow(
      /Invalid issue reference/,
    );
  });
});
