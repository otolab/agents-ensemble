import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpBridge } from '../acp/acp-bridge.js';
import * as worktreeModule from '../worktree/worktree.js';
import {
  createReviewerDispatchTool,
  dispatchReviewer,
} from './reviewer-dispatch.js';

const ISSUE = {
  owner: 'org',
  repo: 'repo',
  number: 14,
  url: 'https://github.com/org/repo/issues/14',
};

describe('dispatchReviewer', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
    );
  });

  async function createWorktreePath(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'ensemble-reviewer-'));
    temporaryDirectories.push(path);
    return path;
  }

  function createBridge() {
    const bridge = {
      newSession: vi.fn().mockResolvedValue('review-session'),
      promptSession: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpBridge;
    return bridge;
  }

  it('opens a new independent ACP session in a direct existing worktree', async () => {
    const worktreePath = await createWorktreePath();
    const bridge = createBridge();
    const connectAcp = vi.fn().mockResolvedValue(bridge);

    const result = await dispatchReviewer({
      prUrl: 'https://github.com/org/repo/pull/2',
      skillName: 'pr-review',
      worktreePath,
      connectAcp,
    });

    expect(connectAcp).toHaveBeenCalledWith({
      cwd: worktreePath,
      spawn: undefined,
      permissionHandler: undefined,
    });
    expect(bridge.newSession).toHaveBeenCalledWith(worktreePath);
    expect(bridge.promptSession).toHaveBeenCalledWith(
      'review-session',
      expect.stringContaining('https://github.com/org/repo/pull/2'),
      { permissionHandler: undefined, onUpdate: undefined },
    );
    expect(bridge.close).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      prUrl: 'https://github.com/org/repo/pull/2',
      worktreePath,
      promptResult: { stopReason: 'end_turn' },
    });
  });

  it('resolves an existing worktree from issueUrl and repoRoot', async () => {
    const worktreePath = await createWorktreePath();
    const bridge = createBridge();
    const connectAcp = vi.fn().mockResolvedValue(bridge);
    const worktree = {
      path: worktreePath,
      branch: 'ensemble/issue-14',
      issue: ISSUE,
    };
    vi.spyOn(worktreeModule, 'resolveWorkerWorktree').mockResolvedValue(worktree);

    const result = await dispatchReviewer({
      prUrl: 'https://github.com/org/repo/pull/2',
      skillName: 'pr-review',
      issueUrl: ISSUE.url,
      repoRoot: '/repo',
      connectAcp,
    });

    expect(worktreeModule.resolveWorkerWorktree).toHaveBeenCalledWith(
      '/repo',
      ISSUE,
    );
    expect(result.worktreePath).toBe(worktreePath);
  });

  it('closes the independent session when the review prompt fails', async () => {
    const worktreePath = await createWorktreePath();
    const bridge = createBridge();
    bridge.promptSession = vi.fn().mockRejectedValue(new Error('prompt failed'));
    const connectAcp = vi.fn().mockResolvedValue(bridge);

    await expect(
      dispatchReviewer({
        prUrl: 'https://github.com/org/repo/pull/2',
        skillName: 'pr-review',
        worktreePath,
        connectAcp,
      }),
    ).rejects.toThrow('prompt failed');
    expect(bridge.close).toHaveBeenCalledOnce();
  });

  it('requires an existing worktree when no path or issue is supplied', async () => {
    await expect(
      dispatchReviewer({
        prUrl: 'https://github.com/org/repo/pull/2',
        skillName: 'pr-review',
      }),
    ).rejects.toThrow('worktreePath or issueUrl with repoRoot');
  });

  it('reports a missing resolved worktree', async () => {
    vi.spyOn(worktreeModule, 'resolveWorkerWorktree').mockResolvedValue(undefined);

    await expect(
      dispatchReviewer({
        prUrl: 'https://github.com/org/repo/pull/2',
        skillName: 'pr-review',
        issueUrl: ISSUE.url,
        repoRoot: '/repo',
      }),
    ).rejects.toThrow('Worker worktree not found');
  });
});

describe('createReviewerDispatchTool', () => {
  it('returns JSON result and forwards the supported worktree inputs', async () => {
    const dispatch = vi.fn().mockResolvedValue({
      prUrl: 'https://github.com/org/repo/pull/2',
      worktreePath: '/repo/.ensemble/worktrees/issue-14',
      prompt: 'review',
      promptResult: { stopReason: 'end_turn' },
    });
    const tools = createReviewerDispatchTool({
      repoRoot: '/repo',
      dispatch,
    });

    const result = await tools.dispatch_reviewer.execute({
      prUrl: 'https://github.com/org/repo/pull/2',
      skillName: 'pr-review',
      worktreePath: '/repo/.ensemble/worktrees/issue-14',
    });

    expect(dispatch).toHaveBeenCalledWith({
      prUrl: 'https://github.com/org/repo/pull/2',
      skillName: 'pr-review',
      worktreePath: '/repo/.ensemble/worktrees/issue-14',
      issueUrl: undefined,
      repoRoot: '/repo',
      spawn: undefined,
      permissionHandler: undefined,
    });
    expect(result.structuredContent).toEqual({
      prUrl: 'https://github.com/org/repo/pull/2',
      worktree: '/repo/.ensemble/worktrees/issue-14',
      stopReason: 'end_turn',
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('"stopReason": "end_turn"'),
    });
  });

  it('rejects a tool call without a worktree selector', async () => {
    const tools = createReviewerDispatchTool({ repoRoot: '/repo' });

    await expect(
      tools.dispatch_reviewer.execute({
        prUrl: 'https://github.com/org/repo/pull/2',
        skillName: 'pr-review',
      }),
    ).rejects.toThrow('worktreePath or issueUrl with repoRoot');
  });
});
