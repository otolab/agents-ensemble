import type { PromptModule } from '@modular-prompt/core';
import type { SessionUpdateHandler } from '../acp/acp-client.js';
import type { SpawnAcpProcessOptions } from '../acp/acp-process.js';
import type { PermissionHandler } from '../acp/types.js';
import type { EnsembleSessionState } from '../profile/types.js';
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
  worktree: WorktreeRef;
  resumeAcpSessionId?: string;
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
  if (options.resumeAcpSessionId) {
    return WORKER_RESUME_PROMPT;
  }
  return compileWorkerAttachPrompt({
    issueUrl: session.issue.url,
    kind: options.kind,
    agentModule: options.prompt,
    worktreePath: session.worktree.path,
    worktreeInRepo: session.worktree.inRepo,
    sessionState: options.sessionState,
  });
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
