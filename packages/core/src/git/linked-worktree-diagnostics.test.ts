import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runGit } from './run-git.js';
import {
  diagnoseLinkedWorktreeGitFailure,
  formatLinkedWorktreeGitDiagnostic,
  isGitSandboxPermissionError,
} from './linked-worktree-diagnostics.js';

describe('linked worktree Git diagnostics', () => {
  it('records linked-worktree metadata paths outside the worker cwd', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-git-diagnostic-'));
    const linkedPath = join(repoRoot, 'linked');

    try {
      await runGit(['init'], repoRoot);
      await runGit(['config', 'user.email', 'test@example.com'], repoRoot);
      await runGit(['config', 'user.name', 'test'], repoRoot);
      await runGit(['commit', '--allow-empty', '-m', 'init'], repoRoot);
      await runGit(['worktree', 'add', '-b', 'diagnostic', linkedPath], repoRoot);
      const resolvedRepoRoot = await realpath(repoRoot);

      const diagnostic = await diagnoseLinkedWorktreeGitFailure({
        cwd: linkedPath,
        error:
          "fatal: Unable to create '.git/worktrees/linked/index.lock': Operation not permitted",
      });

      expect(diagnostic.type).toBe('linked-worktree-git-sandbox');
      expect(diagnostic.cwd).toBe(await realpath(linkedPath));
      expect(diagnostic.gitPaths.commonDir).toBe(await realpath(join(repoRoot, '.git')));
      expect(diagnostic.gitPaths.gitDir).toContain(join(resolvedRepoRoot, '.git', 'worktrees'));
      expect(diagnostic.gitPaths.index).toContain(join(resolvedRepoRoot, '.git', 'worktrees'));
      expect(diagnostic.gitPaths.objects).toBe(join(resolvedRepoRoot, '.git', 'objects'));
      expect(diagnostic.pathsOutsideWorkerCwd).toEqual(
        expect.arrayContaining([
          diagnostic.gitPaths.commonDir,
          diagnostic.gitPaths.index,
          diagnostic.gitPaths.objects,
        ]),
      );
      expect(JSON.parse(formatLinkedWorktreeGitDiagnostic(diagnostic))).toEqual(diagnostic);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('recognizes Git permission errors without classifying unrelated stderr', () => {
    expect(
      isGitSandboxPermissionError(
        "fatal: Unable to create '.git/worktrees/linked/index.lock': Operation not permitted",
      ),
    ).toBe(true);
    expect(isGitSandboxPermissionError('permission denied reading a document')).toBe(false);
  });
});
