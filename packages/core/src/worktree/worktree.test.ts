import { mkdtemp, readFile, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGit } from '../git/run-git.js';
import { parseIssueUrl } from '../issue/issue-ref.js';
import {
  createWorkerWorktree,
  resolveInRepoWorkspace,
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

  it('attaches worktree when branch already exists', async () => {
    const issue = parseIssueUrl('https://github.com/org/repo/issues/10');
    await runGit(['branch', workerBranchName(issue)], repoRoot);
    const worktree = await createWorkerWorktree(repoRoot, issue);
    expect(worktree.path).toBe(resolve(workerWorktreePath(repoRoot, issue)));
  });

  it('uses repo root in in_repo mode', async () => {
    const issue = parseIssueUrl('https://github.com/org/repo/issues/11');
    const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
    const worktree = await resolveInRepoWorkspace(repoRoot, issue);
    expect(worktree.path).toBe(await realpath(repoRoot));
    expect(worktree.inRepo).toBe(true);
    expect(worktree.branch).toBe(stdout.trim());
  });

  it('bases a new branch on fetched origin/main when local HEAD differs', async () => {
    const bareRoot = await mkdtemp(join(tmpdir(), 'ensemble-worktree-bare-'));
    await runGit(['init', '--bare'], bareRoot);

    const originMain = join(repoRoot, 'main.txt');
    await writeFile(originMain, 'origin-main\n');
    await runGit(['add', 'main.txt'], repoRoot);
    await runGit(['commit', '-m', 'origin main'], repoRoot);
    await runGit(['branch', '-M', 'main'], repoRoot);
    await runGit(['remote', 'add', 'origin', bareRoot], repoRoot);
    await runGit(['push', '-u', 'origin', 'main'], repoRoot);

    await writeFile(originMain, 'local-only\n');
    await runGit(['commit', '-am', 'local only'], repoRoot);

    const { stdout: originMainSha } = await runGit(
      ['rev-parse', 'origin/main'],
      repoRoot,
    );
    const { stdout: localHeadSha } = await runGit(
      ['rev-parse', 'HEAD'],
      repoRoot,
    );
    expect(localHeadSha.trim()).not.toBe(originMainSha.trim());

    const issue = parseIssueUrl('https://github.com/org/repo/issues/12');
    const worktree = await createWorkerWorktree(repoRoot, issue);
    const { stdout: worktreeHeadSha } = await runGit(
      ['rev-parse', 'HEAD'],
      worktree.path,
    );
    expect(worktreeHeadSha.trim()).toBe(originMainSha.trim());
    expect(await readFile(join(worktree.path, 'main.txt'), 'utf8')).toBe(
      'origin-main\n',
    );

    await rm(bareRoot, { recursive: true, force: true });
  });

  it('falls back to local HEAD when origin remote is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issue = parseIssueUrl('https://github.com/org/repo/issues/13');
    const worktree = await createWorkerWorktree(repoRoot, issue);
    const { stdout: localHeadSha } = await runGit(['rev-parse', 'HEAD'], repoRoot);
    const { stdout: worktreeHeadSha } = await runGit(
      ['rev-parse', 'HEAD'],
      worktree.path,
    );

    expect(worktreeHeadSha.trim()).toBe(localHeadSha.trim());
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('falls back to local HEAD when fetch fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runGit(['remote', 'add', 'origin', '/nonexistent/remote.git'], repoRoot);

    const issue = parseIssueUrl('https://github.com/org/repo/issues/14');
    const worktree = await createWorkerWorktree(repoRoot, issue);
    const { stdout: localHeadSha } = await runGit(['rev-parse', 'HEAD'], repoRoot);
    const { stdout: worktreeHeadSha } = await runGit(
      ['rev-parse', 'HEAD'],
      worktree.path,
    );

    expect(worktreeHeadSha.trim()).toBe(localHeadSha.trim());
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[worktree] origin/main の同期に失敗しました'),
    );

    warnSpy.mockRestore();
  });
});
