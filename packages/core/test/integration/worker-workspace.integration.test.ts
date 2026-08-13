import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachWorker } from '../../src/dispatch/attach-worker.js';
import { closeWorkerAcpSession } from '../../src/dispatch/worker-acp-session.js';
import * as worktreeModule from '../../src/worktree/worktree.js';
import {
  createInProcessAcpBridge,
  PING_SYSTEM_PROMPT,
  TEST_ISSUE,
  TEST_WORKTREE,
} from './helpers/in-process-acp-bridge.js';

describe('worker workspace integration', () => {
  let repoRoot = '';
  let docsWorkspace = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (repoRoot) {
      rmSync(repoRoot, { recursive: true, force: true });
      repoRoot = '';
      docsWorkspace = '';
    }
  });

  it('starts ACP in custom workspace while keeping issue worktree reference', async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ensemble-ws-int-'));
    docsWorkspace = join(repoRoot, 'docs-repo');
    mkdirSync(docsWorkspace, { recursive: true });
    const issueWorktree = {
      ...TEST_WORKTREE,
      path: join(repoRoot, 'issue-worktree'),
    };
    mkdirSync(issueWorktree.path, { recursive: true });

    vi.spyOn(worktreeModule, 'resolveWorkerWorkspace').mockResolvedValue(
      issueWorktree,
    );

    const connectCalls: Array<{ cwd: string }> = [];
    const bridge = await createInProcessAcpBridge();
    const newSessionSpy = vi.spyOn(bridge, 'newSession');

    const attached = await attachWorker({
      issueUrl: TEST_ISSUE.url,
      name: 'librarian',
      kind: 'ping',
      prompt: { instructions: [PING_SYSTEM_PROMPT] },
      sessionState: {
        workers: [
          { name: 'implementer', kind: 'implementer' },
          { name: 'librarian', kind: 'ping' },
        ],
        kinds: ['ping'],
      },
      worktree: issueWorktree,
      resolvedWorkspacePath: docsWorkspace,
      connectAcp: async (options) => {
        connectCalls.push({ cwd: options.cwd });
        return bridge;
      },
      ownsBridge: false,
    });

    expect(connectCalls).toEqual([{ cwd: docsWorkspace }]);
    expect(newSessionSpy).toHaveBeenCalledWith(docsWorkspace);
    expect(attached.session.worktree.path).toBe(issueWorktree.path);
    expect(attached.session.acpCwd).toBe(docsWorkspace);

    await closeWorkerAcpSession(attached.session);
  });

  it('reports attach failure when workspace path is missing', async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ensemble-ws-int-'));
    const issueWorktree = {
      ...TEST_WORKTREE,
      path: join(repoRoot, 'issue-worktree'),
    };
    mkdirSync(issueWorktree.path, { recursive: true });

    await expect(
      attachWorker({
        issueUrl: TEST_ISSUE.url,
        name: 'librarian',
        kind: 'ping',
        sessionState: { workers: [], kinds: [] },
        worktree: issueWorktree,
        resolvedWorkspacePath: join(repoRoot, 'missing-workspace'),
        connectAcp: async () => createInProcessAcpBridge(),
      }),
    ).rejects.toThrow(/does not exist/);
  });
});
