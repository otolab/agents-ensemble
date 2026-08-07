import { AcpBridge } from '../acp/acp-bridge.js';
import type { SessionUpdateHandler } from '../acp/acp-client.js';
import type { SpawnAcpProcessOptions } from '../acp/acp-process.js';
import type { PermissionHandler } from '../acp/types.js';
import { parseIssueUrl } from '../issue/issue-ref.js';
import { buildWorkerPrompt } from '../prompt/build-prompt.js';
import type { PromptResult } from '../acp/types.js';
import type { IssueRef } from '../issue/issue-ref.js';
import type { WorktreeRef } from '../worktree/worktree.js';
import { createWorkerWorktree } from '../worktree/worktree.js';

export interface WorkerDispatchOptions {
  issueUrl: string;
  skillName: string;
  repoRoot: string;
  spawn?: SpawnAcpProcessOptions;
  onUpdate?: SessionUpdateHandler;
  permissionHandler?: PermissionHandler;
}

export interface WorkerDispatchResult {
  issue: IssueRef;
  worktree: WorktreeRef;
  prompt: string;
  promptResult: PromptResult;
}

export async function dispatchWorker(
  options: WorkerDispatchOptions,
): Promise<WorkerDispatchResult> {
  const issue = parseIssueUrl(options.issueUrl);
  const worktree = await createWorkerWorktree(options.repoRoot, issue);
  const prompt = buildWorkerPrompt({
    issueUrl: issue.url,
    skillName: options.skillName,
    worktreePath: worktree.path,
  });

  const bridge = await AcpBridge.connect({
    cwd: worktree.path,
    permissionHandler: options.permissionHandler,
    ...options.spawn,
  });

  try {
    const promptResult = await bridge.runSession({
      cwd: worktree.path,
      prompt,
      onUpdate: options.onUpdate,
    });

    return { issue, worktree, prompt, promptResult };
  } finally {
    await bridge.close();
  }
}
