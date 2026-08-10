import type { SessionUpdateHandler } from '../acp/acp-client.js';
import { AcpBridge } from '../acp/acp-bridge.js';
import type { SpawnAcpProcessOptions } from '../acp/acp-process.js';
import type { PermissionHandler } from '../acp/types.js';
import { parseIssueUrl } from '../issue/issue-ref.js';
import type { IssueRef } from '../issue/issue-ref.js';
import { createWorkerWorktree, type WorktreeRef } from '../worktree/worktree.js';

export interface ConnectWorkerAcpOptions {
  cwd: string;
  spawn?: SpawnAcpProcessOptions;
  permissionHandler?: PermissionHandler;
}

export type ConnectWorkerAcpFn = (
  options: ConnectWorkerAcpOptions,
) => Promise<AcpBridge>;

export interface OpenWorkerAcpSessionOptions {
  issueUrl: string;
  repoRoot: string;
  resumeAcpSessionId?: string;
  bridge?: AcpBridge;
  connectAcp?: ConnectWorkerAcpFn;
  spawn?: SpawnAcpProcessOptions;
  permissionHandler?: PermissionHandler;
  /** `connectAcp` 利用時に harness が close するか。integration の共有 bridge は false。 */
  ownsBridge?: boolean;
}

/** ensemble 存続中に維持する worker の ACP 接続。 */
export interface WorkerAcpSession {
  bridge: AcpBridge;
  ownsBridge: boolean;
  sessionId: string;
  worktree: WorktreeRef;
  issue: IssueRef;
}

export async function openWorkerAcpSession(
  options: OpenWorkerAcpSessionOptions,
): Promise<WorkerAcpSession> {
  const issue = parseIssueUrl(options.issueUrl);
  const worktree = await createWorkerWorktree(options.repoRoot, issue);

  let ownsBridge = false;
  let bridge = options.bridge;
  if (!bridge) {
    if (options.connectAcp) {
      bridge = await options.connectAcp({
        cwd: worktree.path,
        spawn: options.spawn,
        permissionHandler: options.permissionHandler,
      });
      ownsBridge = options.ownsBridge ?? true;
    } else {
      bridge = await AcpBridge.connect({
        cwd: worktree.path,
        permissionHandler: options.permissionHandler,
        ...options.spawn,
      });
      ownsBridge = true;
    }
  }

  let sessionId = options.resumeAcpSessionId;
  if (sessionId) {
    try {
      await bridge.loadSession(
        sessionId,
        worktree.path,
        options.permissionHandler,
      );
    } catch {
      sessionId = undefined;
    }
  }
  if (!sessionId) {
    sessionId = await bridge.newSession(worktree.path);
  }

  return {
    bridge,
    ownsBridge,
    sessionId,
    worktree,
    issue,
  };
}

export async function runWorkerAcpPrompt(
  session: WorkerAcpSession,
  prompt: string,
  options?: {
    permissionHandler?: PermissionHandler;
    onUpdate?: SessionUpdateHandler;
  },
): Promise<import('../acp/types.js').PromptResult> {
  return session.bridge.promptSession(session.sessionId, prompt, options);
}

export async function closeWorkerAcpSession(
  session: WorkerAcpSession,
): Promise<void> {
  if (session.ownsBridge) {
    await session.bridge.close();
  }
}
