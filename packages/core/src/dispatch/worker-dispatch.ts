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
  name: string;
  issueUrl: string;
  kind: string;
  systemPrompt?: string;
  repoRoot: string;
  spawn?: SpawnAcpProcessOptions;
  /** integration 用: 接続済み bridge を注入（未指定時は spawn して接続）。 */
  bridge?: AcpBridge;
  onUpdate?: SessionUpdateHandler;
  permissionHandler?: PermissionHandler;
}

export interface WorkerDispatchResult {
  name: string;
  kind: string;
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
    kind: options.kind,
    systemPrompt: options.systemPrompt,
    worktreePath: worktree.path,
  });

  const bridge =
    options.bridge ??
    (await AcpBridge.connect({
      cwd: worktree.path,
      permissionHandler: options.permissionHandler,
      ...options.spawn,
    }));

  const ownsBridge = !options.bridge;

  try {
    const promptResult = await bridge.runSession({
      cwd: worktree.path,
      prompt,
      onUpdate: options.onUpdate,
      permissionHandler: options.permissionHandler,
    });

    return {
      name: options.name,
      kind: options.kind,
      issue,
      worktree,
      prompt,
      promptResult,
    };
  } finally {
    if (ownsBridge) {
      await bridge.close();
    }
  }
}
