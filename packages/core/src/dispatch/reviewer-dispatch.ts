import { AcpBridge } from '../acp/acp-bridge.js';
import type { SessionUpdateHandler } from '../acp/acp-client.js';
import type { SpawnAcpProcessOptions } from '../acp/acp-process.js';
import type { PermissionHandler, PromptResult } from '../acp/types.js';
import { parseIssueUrl } from '../issue/issue-ref.js';
import { buildReviewerPrompt } from '../prompt/build-prompt.js';
import { resolveWorkerWorktree } from '../worktree/worktree.js';

export interface ReviewerDispatchOptions {
  prUrl: string;
  skillName: string;
  /** Existing worker worktree path. */
  worktreePath?: string;
  /** Resolve worktree from issue when worktreePath is omitted. */
  issueUrl?: string;
  repoRoot?: string;
  spawn?: SpawnAcpProcessOptions;
  onUpdate?: SessionUpdateHandler;
  permissionHandler?: PermissionHandler;
}

export interface ReviewerDispatchResult {
  prUrl: string;
  worktreePath: string;
  prompt: string;
  promptResult: PromptResult;
}

export async function dispatchReviewer(
  options: ReviewerDispatchOptions,
): Promise<ReviewerDispatchResult> {
  const worktreePath = await resolveReviewerWorktreePath(options);
  const prompt = buildReviewerPrompt({
    prUrl: options.prUrl,
    skillName: options.skillName,
    worktreePath,
  });

  const bridge = await AcpBridge.connect({
    cwd: worktreePath,
    permissionHandler: options.permissionHandler,
    ...options.spawn,
  });

  try {
    const promptResult = await bridge.runSession({
      cwd: worktreePath,
      prompt,
      onUpdate: options.onUpdate,
    });

    return { prUrl: options.prUrl, worktreePath, prompt, promptResult };
  } finally {
    await bridge.close();
  }
}

async function resolveReviewerWorktreePath(
  options: ReviewerDispatchOptions,
): Promise<string> {
  if (options.worktreePath) {
    return options.worktreePath;
  }

  if (!options.issueUrl || !options.repoRoot) {
    throw new Error(
      'Reviewer dispatch requires worktreePath or issueUrl with repoRoot',
    );
  }

  const issue = parseIssueUrl(options.issueUrl);
  const worktree = await resolveWorkerWorktree(options.repoRoot, issue);
  if (!worktree) {
    throw new Error(
      `Worker worktree not found for ${options.issueUrl}. Dispatch worker first.`,
    );
  }

  return worktree.path;
}
