import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConductorInbox } from '../../src/runtime/conductor-inbox.js';
import { WorkerRuntime } from '../../src/runtime/worker-runtime.js';
import { resolveWorkspaceIssueRef } from '../workspace-run/issue-ref.js';

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

  it.each([false, true])('keeps workspace attach and dispatch independent of Issue defaults (resume=%s)', async (resume) => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ensemble-workspace-worker-'));
    const issue = resolveWorkspaceIssueRef('research');
    const promptSession = vi.fn().mockResolvedValue({ stopReason: 'end_turn', responseText: 'ok' });
    const runtime = new WorkerRuntime({
      inbox: new ConductorInbox(),
      repoRoot,
      connectAcp: async () => ({
        newSession: vi.fn().mockResolvedValue('sess-1'),
        loadSession: vi.fn().mockResolvedValue(undefined),
        promptSession,
        close: vi.fn().mockResolvedValue(undefined),
      }) as never,
    });
    runtime.start({
      name: 'explore', kind: 'explore', issueUrl: issue.url,
      worktree: { path: repoRoot, branch: '', issue, inRepo: true },
      sessionState: { workers: [{ name: 'explore', kind: 'explore' }], kinds: ['explore'] },
      ...(resume ? { resumeAcpSessionId: 'previous' } : {}),
    });
    await runtime.waitForIdle();
    expect(promptSession).toHaveBeenCalledTimes(1);
    expect(promptSession.mock.calls[0][1]).not.toMatch(/Issue|\bPR\b/);
    expect(runtime.sendWorkerMessage('explore', '調査してください')).toMatchObject({ status: 'sent' });
    await runtime.waitForIdle();
    expect(promptSession.mock.calls[1][1]).toBe('調査してください');
    await runtime.shutdown();
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
