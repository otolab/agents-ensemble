import { AcpSessionConfigOptionError } from '../acp/acp-client.js';
import type { SessionUpdateHandler } from '../acp/acp-client.js';
import { AcpBridge } from '../acp/acp-bridge.js';
import type { SpawnAcpProcessOptions } from '../acp/acp-process.js';
import {
  assertAcpSpawnMatchesResume,
  type AcpSpawnFingerprint,
} from '../acp/resolve-acp-spawn.js';
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
  /** resume 時に SessionResumeStore に記録した cwd。不一致なら attach 失敗。 */
  expectedResumeAcpCwd?: string;
  /** resume 時に SessionResumeStore に記録した ACP spawn metadata。 */
  expectedResumeAcpSpawn?: AcpSpawnFingerprint;
  /** 現在の profile / CLI から解決した ACP spawn（resume 検証用）。 */
  currentAcpSpawn?: AcpSpawnFingerprint;
  resumeAcpSessionId?: string;
  bridge?: AcpBridge;
  connectAcp?: ConnectWorkerAcpFn;
  spawn?: SpawnAcpProcessOptions;
  permissionHandler?: PermissionHandler;
  /** `connectAcp` 利用時に harness が close するか。integration の共有 bridge は false。 */
  ownsBridge?: boolean;
}

export type WorkerSessionRecoveryReason =
  | 'session_load_failed'
  | 'prompt_history_unreadable';

export interface WorkerSessionRecovery {
  reason: WorkerSessionRecoveryReason;
  previousSessionId: string;
  newSessionId: string;
}

/** ensemble 存続中に維持する worker の ACP 接続。 */
export interface WorkerAcpSession {
  bridge: AcpBridge;
  ownsBridge: boolean;
  sessionId: string;
  /** 保存済み session の `session/load` が成功したか。 */
  resumed: boolean;
  /** 保存済み thread から新しい thread に切り替えた場合の情報。 */
  recovery?: WorkerSessionRecovery;
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
      `${label} resume cwd mismatch: saved resume store has ${options.expectedResumeAcpCwd}, current profile resolves to ${acpCwd}`,
    );
  }

  if (options.resumeAcpSessionId && options.currentAcpSpawn) {
    assertAcpSpawnMatchesResume({
      expected: options.expectedResumeAcpSpawn,
      actual: options.currentAcpSpawn,
      workerName: options.workerName,
    });
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
  let resumed = false;
  let recoveryReason: WorkerSessionRecoveryReason | undefined;
  const previousSessionId = sessionId;
  try {
    if (sessionId) {
      try {
        await bridge.loadSession(
          sessionId,
          acpCwd,
          options.permissionHandler,
        );
        resumed = true;
      } catch (error) {
        if (error instanceof AcpSessionConfigOptionError) throw error;
        recoveryReason = 'session_load_failed';
        sessionId = undefined;
      }
    }
    if (!sessionId) {
      sessionId = await bridge.newSession(acpCwd);
    }
  } catch (error) {
    if (ownsBridge && bridge) {
      try {
        await bridge.close();
      } catch {
        // Keep the session initialization error as the primary failure.
      }
    }
    throw error;
  }

  return {
    bridge,
    ownsBridge,
    sessionId,
    resumed,
    ...(recoveryReason && previousSessionId
      ? {
          recovery: {
            reason: recoveryReason,
            previousSessionId,
            newSessionId: sessionId,
          },
        }
      : {}),
    worktree,
    issue,
    acpCwd,
  };
}

/**
 * Cursor / Codex ACP prompt error emitted when the active provider cannot read
 * the thread history encrypted by a different provider or account.
 *
 * Keep this deliberately specific: ordinary prompt failures are not evidence
 * that replaying the instruction in a new thread is safe.
 */
export function isUnrecoverableAcpSessionHistoryError(
  error: unknown,
): boolean {
  if (error instanceof AcpSessionConfigOptionError) return false;
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  const message = rawMessage
    .toLowerCase()
    .replace(/[’‘]/g, "'");

  const cannotReadEarlierReasoning =
    /(?:can't|cannot) read this thread's earlier reasoning/.test(message);
  const mentionsEncryption =
    message.includes('encrypt') &&
    /(another|different|previous|old) (?:provider|account)/.test(message);
  return cannotReadEarlierReasoning && mentionsEncryption;
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
