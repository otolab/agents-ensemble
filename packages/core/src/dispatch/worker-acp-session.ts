import type { SessionUpdateHandler } from '../acp/acp-client.js';
import { AcpBridge } from '../acp/acp-bridge.js';
import type { SpawnAcpProcessOptions } from '../acp/acp-process.js';
import type { PermissionHandler, PromptResult } from '../acp/types.js';
import type { IssueRef } from '../issue/issue-ref.js';
import { assertWorkerWorkspaceDirectory } from '../profile/resolve-worker-workspace.js';
import type { WorktreeRef } from '../worktree/worktree.js';

/** attach / dispatch 時に worker 名を spawn オプションへマージする。 */
export function mergeWorkerSpawn(
  spawn: SpawnAcpProcessOptions | undefined,
  workerName: string,
): SpawnAcpProcessOptions {
  return {
    ...spawn,
    workerName,
  };
}

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
  /** Conductor が事前に resolve した作業ディレクトリ（Issue worktree）。 */
  worktree: WorktreeRef;
  /** ACP spawn / session cwd。未指定時は `worktree.path`。 */
  acpCwd?: string;
  workerName?: string;
  /** resume 時に sidecar が記録した cwd。不一致なら attach 失敗。 */
  expectedResumeAcpCwd?: string;
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
  /** 実際に ACP に渡した cwd（`session/new` / `session/load`）。 */
  acpCwd: string;
}

export async function openWorkerAcpSession(
  options: OpenWorkerAcpSessionOptions,
): Promise<WorkerAcpSession> {
  const worktree = options.worktree;
  const issue = worktree.issue;
  const acpCwd = options.acpCwd ?? worktree.path;

  if (
    options.expectedResumeAcpCwd &&
    options.expectedResumeAcpCwd !== acpCwd
  ) {
    const label = options.workerName ? `Worker "${options.workerName}"` : 'Worker';
    throw new Error(
      `${label} resume cwd mismatch: sidecar has ${options.expectedResumeAcpCwd}, current profile resolves to ${acpCwd}`,
    );
  }

  if (options.acpCwd !== undefined) {
    assertWorkerWorkspaceDirectory(acpCwd, options.workerName);
  }

  let ownsBridge = false;
  let bridge = options.bridge;
  if (!bridge) {
    if (options.connectAcp) {
      bridge = await options.connectAcp({
        cwd: acpCwd,
        spawn: options.spawn,
        permissionHandler: options.permissionHandler,
      });
      ownsBridge = options.ownsBridge ?? true;
    } else {
      bridge = await AcpBridge.connect({
        cwd: acpCwd,
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
        acpCwd,
        options.permissionHandler,
      );
    } catch {
      sessionId = undefined;
    }
  }
  if (!sessionId) {
    sessionId = await bridge.newSession(acpCwd);
  }

  return {
    bridge,
    ownsBridge,
    sessionId,
    worktree,
    issue,
    acpCwd,
  };
}

export async function runWorkerAcpPrompt(
  session: WorkerAcpSession,
  prompt: string,
  options?: {
    permissionHandler?: PermissionHandler;
    onUpdate?: SessionUpdateHandler;
  },
): Promise<PromptResult> {
  return session.bridge.promptSession(session.sessionId, prompt, options);
}

/** 進行中の prompt ターンを `session/cancel` で中止する。 */
export function cancelWorkerAcpPrompt(session: WorkerAcpSession): void {
  session.bridge.cancelSession(session.sessionId);
}

export async function closeWorkerAcpSession(
  session: WorkerAcpSession,
): Promise<void> {
  if (session.ownsBridge) {
    await session.bridge.close();
  }
}
