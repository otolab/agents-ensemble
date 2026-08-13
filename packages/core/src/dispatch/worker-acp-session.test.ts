import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openWorkerAcpSession } from './worker-acp-session.js';

const TEST_WORKTREE = {
  path: '/tmp/issue-worktree',
  branch: 'ensemble/issue-1',
  issue: {
    owner: 'org',
    repo: 'repo',
    number: 1,
    url: 'https://github.com/org/repo/issues/1',
  },
};

describe('openWorkerAcpSession', () => {
  let workspaceDir = '';

  afterEach(() => {
    if (workspaceDir) {
      rmSync(workspaceDir, { recursive: true, force: true });
      workspaceDir = '';
    }
    vi.restoreAllMocks();
  });

  it('uses custom acpCwd for connect and newSession', async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'ensemble-acp-cwd-'));
    const newSession = vi.fn().mockResolvedValue('sess-1');
    const connectAcp = vi.fn().mockResolvedValue({
      newSession,
      loadSession: vi.fn(),
      promptSession: vi.fn(),
      close: vi.fn(),
    });

    const session = await openWorkerAcpSession({
      issueUrl: TEST_WORKTREE.issue.url,
      worktree: TEST_WORKTREE,
      acpCwd: workspaceDir,
      workerName: 'librarian',
      connectAcp,
      ownsBridge: false,
    });

    expect(connectAcp).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: workspaceDir }),
    );
    expect(newSession).toHaveBeenCalledWith(workspaceDir);
    expect(session.acpCwd).toBe(workspaceDir);
  });

  it('fails when workspace path does not exist', async () => {
    await expect(
      openWorkerAcpSession({
        issueUrl: TEST_WORKTREE.issue.url,
        worktree: TEST_WORKTREE,
        acpCwd: '/no/such/workspace',
        workerName: 'librarian',
        connectAcp: vi.fn(),
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('fails on resume cwd mismatch', async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'ensemble-acp-cwd-'));

    await expect(
      openWorkerAcpSession({
        issueUrl: TEST_WORKTREE.issue.url,
        worktree: TEST_WORKTREE,
        acpCwd: workspaceDir,
        workerName: 'librarian',
        expectedResumeAcpCwd: '/other/cwd',
        resumeAcpSessionId: 'sess-old',
        connectAcp: vi.fn(),
      }),
    ).rejects.toThrow(/resume cwd mismatch/);
  });
});
