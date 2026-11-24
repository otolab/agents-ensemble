import type { PromptModule } from '@modular-prompt/core';
import { parseWorkspaceSessionUrl } from '../workspace-run/session-url.js';
import type { SessionUpdateHandler } from '../acp/acp-client.js';
import type { SpawnAcpProcessOptions } from '../acp/acp-process.js';
import type { AcpSpawnFingerprint } from '../acp/resolve-acp-spawn.js';
import type { PermissionHandler } from '../acp/types.js';
import type {
  EnsembleSessionState,
  ResolvedProfileMaterial,
} from '../profile/types.js';
import { buildWorkerAttachPrompt as compileWorkerAttachPrompt } from '../prompt/build-worker-attach-prompt.js';
import type { WorktreeRef } from '../worktree/worktree.js';
import {
  openWorkerAcpSession,
  runWorkerAcpPrompt,
  type ConnectWorkerAcpFn,
  type WorkerAcpSession,
  mergeWorkerSpawn,
} from './worker-acp-session.js';
import {
  buildWorkerDispatchResult,
  type WorkerDispatchResult,
} from './worker-dispatch.js';

const WORKER_RESUME_PROMPT =
  '前回の続きです。Issue / worktree の最新状態を踏まえ、中断していた作業を再開してください。';

export interface AttachWorkerOptions {
  name: string;
  issueUrl: string;
  kind: string;
  prompt?: PromptModule;
  sessionState: EnsembleSessionState;
  userInstructions?: ResolvedProfileMaterial;
  worktree: WorktreeRef;
  resolvedWorkspacePath?: string;
  expectedResumeAcpCwd?: string;
  expectedResumeAcpSpawn?: AcpSpawnFingerprint;
  currentAcpSpawn?: AcpSpawnFingerprint;
  resumeAcpSessionId?: string;
  handoffPending?: boolean;
  spawn?: SpawnAcpProcessOptions;
  connectAcp?: ConnectWorkerAcpFn;
  permissionHandler?: PermissionHandler;
  ownsBridge?: boolean;
}

export interface AttachedWorker {
  name: string;
  kind: string;
  session: WorkerAcpSession;
}

/** worker を attach する（ACP 接続 + session 確立。プロセスは close しない）。 */
export async function attachWorker(
  options: AttachWorkerOptions,
): Promise<AttachedWorker> {
  const session = await openWorkerAcpSession({
    issueUrl: options.issueUrl,
    worktree: options.worktree,
    acpCwd: options.resolvedWorkspacePath,
    workerName: options.name,
    expectedResumeAcpCwd: options.expectedResumeAcpCwd,
    expectedResumeAcpSpawn: options.expectedResumeAcpSpawn,
    currentAcpSpawn: options.currentAcpSpawn,
    resumeAcpSessionId: options.resumeAcpSessionId,
    connectAcp: options.connectAcp,
    spawn: mergeWorkerSpawn(options.spawn, options.name),
    permissionHandler: options.permissionHandler,
    ownsBridge: options.ownsBridge,
  });

  return {
    name: options.name,
    kind: options.kind,
    session,
  };
}

export function buildWorkerAttachPrompt(
  options: AttachWorkerOptions,
  session: WorkerAcpSession,
): string {
  if (session.resumed) {
    if (options.handoffPending) {
      return parseWorkspaceSessionUrl(options.issueUrl)
        ? '前回の切替後の引き継ぎ確認が完了していません。新しい作業は行わず、Notes、作業ディレクトリ、open questions と中断操作の状態を確認し、conductor に報告して指示を待ってください。'
        : '前回の切替後の引き継ぎ確認が完了していません。新しい作業は行わず、Notes、Issue、作業ディレクトリ、open questions と中断操作の状態を確認し、conductor に報告して指示を待ってください。';
    }
    return parseWorkspaceSessionUrl(options.issueUrl)
      ? '前回の続きです。作業ディレクトリの最新状態を踏まえ、中断していた作業を再開してください。'
      : WORKER_RESUME_PROMPT;
  }
  const prompt = compileWorkerAttachPrompt({
    issueUrl: session.issue.url,
    kind: options.kind,
    agentModule: options.prompt,
    worktreePath: session.worktree.path,
    workspacePath: session.acpCwd,
    worktreeInRepo: session.worktree.inRepo,
    sessionState: options.sessionState,
    userInstructions: options.userInstructions,
  });
  if (!session.recovery) return prompt;
  const sources = parseWorkspaceSessionUrl(options.issueUrl) ? 'Notes、作業ディレクトリ' : 'Notes、Issue、作業ディレクトリ';
  return `${prompt}\n\n以前の会話はこの session に引き継がれていません。${sources}と open questions を確認し、中断した操作の副作用を調べてください。必要な情報が不足する場合は作業を停止して conductor に報告してください。旧指示を自動的に再実行せず、確認結果を報告して次の指示を待ってください。`;
}

/** @deprecated 互換名。`buildWorkerAttachPrompt` を使う。 */
export const buildBootstrapWorkerPrompt = buildWorkerAttachPrompt;

export async function runAttachedWorkerPrompt(
  attached: AttachedWorker,
  prompt: string,
  options?: {
    permissionHandler?: PermissionHandler;
    onUpdate?: SessionUpdateHandler;
  },
): Promise<WorkerDispatchResult> {
  const promptResult = await runWorkerAcpPrompt(attached.session, prompt, {
    permissionHandler: options?.permissionHandler,
    onUpdate: options?.onUpdate,
  });
  return buildWorkerDispatchResult({
    name: attached.name,
    kind: attached.kind,
    session: attached.session,
    prompt,
    promptResult,
  });
}
