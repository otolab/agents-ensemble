import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGit } from '../git/run-git.js';
import { parseIssueUrl } from '../issue/issue-ref.js';
import {
  createWorkerWorktree,
  listWorktrees,
  removeWorkerWorktree,
  resolveInRepoWorkspace,
  resolveWorkerWorkspace,
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

  it('warns and recreates a missing resume worktree from the current clone base', async () => {
    const issue = parseIssueUrl('https://github.com/org/repo/issues/43');
    const notices: string[] = [];

    const worktree = await resolveWorkerWorkspace(
      repoRoot,
      issue,
      'isolated',
      {
        resume: true,
        onNotice: (message) => notices.push(message),
      },
    );

    expect(worktree).toMatchObject({
      path: resolve(workerWorktreePath(repoRoot, issue)),
      branch: workerBranchName(issue),
    });
    expect(notices).toEqual(
      expect.arrayContaining([
        expect.stringContaining('この clone に Issue #43'),
        expect.stringContaining('再生成しました'),
      ]),
    );
    await expect(resolveWorkerWorktree(repoRoot, issue)).resolves.toMatchObject({
      branch: workerBranchName(issue),
    });
  });

  it('preserves an occupied resume path and uses a separate recovery path', async () => {
    const issue = parseIssueUrl('https://github.com/org/repo/issues/44');
    const occupiedPath = workerWorktreePath(repoRoot, issue);
    await mkdir(occupiedPath, { recursive: true });
    const marker = join(occupiedPath, 'keep.txt');
    await writeFile(marker, 'keep this directory\n');
    const notices: string[] = [];

    const worktree = await resolveWorkerWorkspace(
      repoRoot,
      issue,
      'isolated',
      {
        resume: true,
        onNotice: (message) => notices.push(message),
      },
    );

    expect(worktree.path).not.toBe(resolve(occupiedPath));
    expect(worktree.branch).toBe(workerBranchName(issue));
    expect(await readFile(marker, 'utf8')).toBe('keep this directory\n');
    expect(notices).toEqual(
      expect.arrayContaining([
        expect.stringContaining('この clone に Issue #44'),
        expect.stringContaining('再生成しました'),
      ]),
    );
  });

  it('keeps an Issue branch attached elsewhere and resumes on a fresh branch', async () => {
    const issue = parseIssueUrl('https://github.com/org/repo/issues/46');
    const occupiedBranch = workerBranchName(issue);
    const otherPath = join(
      repoRoot,
      '.ensemble',
      'worktrees',
      'issue-46-already-open',
    );
    await mkdir(dirname(otherPath), { recursive: true });
    await runGit(
      ['worktree', 'add', '-b', occupiedBranch, otherPath, 'HEAD'],
      repoRoot,
    );
    const marker = join(otherPath, 'keep.txt');
    await writeFile(marker, 'keep this worktree\n');
    const originalHead = await runGit(['rev-parse', 'HEAD'], otherPath);
    const notices: string[] = [];

    const recovered = await resolveWorkerWorkspace(
      repoRoot,
      issue,
      'isolated',
      {
        resume: true,
        onNotice: (message) => notices.push(message),
      },
    );

    expect(recovered.path).toBe(resolve(workerWorktreePath(repoRoot, issue)));
    expect(recovered.branch).not.toBe(occupiedBranch);
    expect(recovered.branch).toMatch(
      /^ensemble\/issue-46-resume-[0-9a-f]{8}$/u,
    );
    expect(await readFile(marker, 'utf8')).toBe('keep this worktree\n');
    await expect(
      runGit(['branch', '--show-current'], otherPath),
    ).resolves.toMatchObject({ stdout: `${occupiedBranch}\n` });
    await expect(runGit(['rev-parse', 'HEAD'], otherPath)).resolves.toMatchObject({
      stdout: originalHead.stdout,
    });
    expect(notices).toEqual(
      expect.arrayContaining([
        expect.stringContaining('この clone に Issue #46'),
        expect.stringContaining('再生成しました'),
      ]),
    );
  });

  it('fails with a reason when an occupied path has no valid base and leaves it intact', async () => {
    const emptyRepo = await mkdtemp(join(tmpdir(), 'ensemble-worktree-empty-'));
    try {
      await runGit(['init', '-b', 'ensemble/issue-45'], emptyRepo);
      await runGit(['config', 'user.email', 'test@example.com'], emptyRepo);
      await runGit(['config', 'user.name', 'test'], emptyRepo);
      const issue = parseIssueUrl('https://github.com/org/repo/issues/45');
      const occupiedPath = workerWorktreePath(emptyRepo, issue);
      await mkdir(occupiedPath, { recursive: true });
      const marker = join(occupiedPath, 'keep.txt');
      await writeFile(marker, 'unmodified\n');
      const branchesBefore = await runGit(
        ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
        emptyRepo,
      );

      await expect(
        resolveWorkerWorkspace(emptyRepo, issue, 'isolated', {
          resume: true,
        }),
      ).rejects.toThrow(
        /could not safely|安全な worktree base|安全に復旧できません/iu,
      );

      expect(await readFile(marker, 'utf8')).toBe('unmodified\n');
      await expect(
        runGit(
          ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
          emptyRepo,
        ),
      ).resolves.toMatchObject({ stdout: branchesBefore.stdout });
    } finally {
      await rm(emptyRepo, { recursive: true, force: true });
    }
  });
});

describe('removeWorkerWorktree', () => {
  let repoRoot = '';

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-worktree-remove-'));
    await runGit(['init'], repoRoot);
    await runGit(['config', 'user.email', 'test@example.com'], repoRoot);
    await runGit(['config', 'user.name', 'test'], repoRoot);
    await runGit(['commit', '--allow-empty', '-m', 'init'], repoRoot);
  });

  afterEach(async () => {
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
  });

  it('removes an existing isolated worktree', async () => {
    const issue = parseIssueUrl('https://github.com/org/repo/issues/20');
    const worktree = await createWorkerWorktree(repoRoot, issue);

    const result = await removeWorkerWorktree(repoRoot, issue);
    expect(result).toEqual({
      status: 'removed',
      path: worktree.path,
      branch: worktree.branch,
    });

    const listed = await listWorktrees(repoRoot);
    expect(listed.some((entry) => entry.path === worktree.path)).toBe(false);
    expect(await resolveWorkerWorktree(repoRoot, issue)).toBeUndefined();
  });

  it('is a no-op when worktree does not exist', async () => {
    const issue = parseIssueUrl('https://github.com/org/repo/issues/21');
    const result = await removeWorkerWorktree(repoRoot, issue);
    expect(result).toEqual({ status: 'not_found' });
  });

  it('skips removal when worktree has uncommitted changes', async () => {
    const issue = parseIssueUrl('https://github.com/org/repo/issues/22');
    const worktree = await createWorkerWorktree(repoRoot, issue);
    await writeFile(join(worktree.path, 'dirty.txt'), 'dirty\n');

    const result = await removeWorkerWorktree(repoRoot, issue);
    expect(result).toEqual({
      status: 'skipped_dirty',
      path: worktree.path,
      branch: worktree.branch,
    });
    expect(await resolveWorkerWorktree(repoRoot, issue)).toBeDefined();
  });

  it('round-trips create and remove', async () => {
    const issue = parseIssueUrl('https://github.com/org/repo/issues/23');
    await createWorkerWorktree(repoRoot, issue);
    await removeWorkerWorktree(repoRoot, issue);

    const recreated = await createWorkerWorktree(repoRoot, issue);
    expect(recreated.path).toBe(resolve(workerWorktreePath(repoRoot, issue)));
    expect(await resolveWorkerWorktree(repoRoot, issue)).toBeDefined();
  });
});
