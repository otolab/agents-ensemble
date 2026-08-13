import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConductorInbox } from '../../src/runtime/conductor-inbox.js';
import { WorkerRuntime } from '../../src/runtime/worker-runtime.js';

describe('WorkerRuntime workspace', () => {
  let repoRoot = '';
  let docsWorkspace = '';

  afterEach(async () => {
    if (repoRoot) {
      rmSync(repoRoot, { recursive: true, force: true });
      repoRoot = '';
      docsWorkspace = '';
    }
    vi.restoreAllMocks();
  });

  it('exposes summarized workspacePath in worker status', async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ensemble-ws-status-'));
    docsWorkspace = join(repoRoot, 'docs-repo');
    mkdirSync(docsWorkspace, { recursive: true });
    const issueWorktree = {
      path: join(repoRoot, 'issue-worktree'),
      branch: 'ensemble/issue-1',
      issue: {
        owner: 'org',
        repo: 'repo',
        number: 1,
        url: 'https://github.com/org/repo/issues/1',
      },
    };
    mkdirSync(issueWorktree.path, { recursive: true });

    const inbox = new ConductorInbox();
    const runtime = new WorkerRuntime({
      inbox,
      repoRoot,
      connectAcp: async ({ cwd }) =>
        ({
          newSession: vi.fn().mockResolvedValue('sess-1'),
          loadSession: vi.fn(),
          promptSession: vi.fn().mockResolvedValue({
            stopReason: 'end_turn',
            responseText: 'ok',
          }),
          close: vi.fn().mockResolvedValue(undefined),
          _cwd: cwd,
        }) as never,
    });

    runtime.start({
      name: 'librarian',
      issueUrl: issueWorktree.issue.url,
      kind: 'librarian',
      worktree: issueWorktree,
      resolvedWorkspacePath: docsWorkspace,
      sessionState: { workers: [], kinds: [] },
    });

    await runtime.waitForIdle();

    const status = runtime.getWorkerStatus('librarian');
    expect(status?.workspacePath).toBe('docs-repo');
    expect(status?.worktreePath).toBe(issueWorktree.path);

    await runtime.shutdown();
  });
});
