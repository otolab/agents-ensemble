import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGit } from '../git/run-git.js';
import { parseIssueUrl } from '../issue/issue-ref.js';
import {
  createWorkerWorktree,
  resolveWorkerWorktree,
  workerBranchName,
  workerWorktreePath,
} from './worktree.js';

describe('worktree naming', () => {
  const issue = parseIssueUrl('https://github.com/org/repo/issues/42');

  it('derives branch and path', () => {
    expect(workerBranchName(issue)).toBe('ensemble/issue-42');
    expect(workerWorktreePath('/repo', issue)).toBe(
      '/repo/.ensemble/worktrees/issue-42',
    );
  });
});

describe('createWorkerWorktree', () => {
  let repoRoot = '';

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-worktree-'));
    await runGit(['init'], repoRoot);
    await runGit(['config', 'user.email', 'test@example.com'], repoRoot);
    await runGit(['config', 'user.name', 'test'], repoRoot);
    await runGit(['commit', '--allow-empty', '-m', 'init'], repoRoot);
  });

  afterEach(async () => {
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
  });

  it('creates a worktree for an issue', async () => {
    const issue = parseIssueUrl('https://github.com/org/repo/issues/7');
    const worktree = await createWorkerWorktree(repoRoot, issue);

    expect(worktree.branch).toBe('ensemble/issue-7');
    expect(worktree.path).toBe(resolve(workerWorktreePath(repoRoot, issue)));

    const again = await createWorkerWorktree(repoRoot, issue);
    expect(again.path).toBe(worktree.path);
  });

  it('resolves an existing worktree', async () => {
    const issue = parseIssueUrl('https://github.com/org/repo/issues/8');
    await createWorkerWorktree(repoRoot, issue);
    const resolved = await resolveWorkerWorktree(repoRoot, issue);
    expect(resolved?.path).toBe(resolve(workerWorktreePath(repoRoot, issue)));
  });
});
