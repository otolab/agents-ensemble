import type { SpawnAcpProcessOptions } from '../acp/acp-process.js';
import type { PermissionHandler } from '../acp/types.js';
import type { EnsembleSessionState } from '../profile/types.js';
import { buildWorkerPrompt } from '../prompt/build-worker-prompt.js';
import {
  openWorkerAcpSession,
  runWorkerAcpPrompt,
  type ConnectWorkerAcpFn,
  type WorkerAcpSession,
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
  systemPrompt?: string;
  sessionState: EnsembleSessionState;
  repoRoot: string;
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
    repoRoot: options.repoRoot,
    resumeAcpSessionId: options.resumeAcpSessionId,
    connectAcp: options.connectAcp,
    spawn: options.spawn,
    permissionHandler: options.permissionHandler,
    ownsBridge: options.ownsBridge,
  });

  return {
    name: options.name,
    kind: options.kind,
    session,
  };
}

export function buildBootstrapWorkerPrompt(
  options: AttachWorkerOptions,
  session: WorkerAcpSession,
): string {
  if (options.resumeAcpSessionId) {
    return WORKER_RESUME_PROMPT;
  }
  return buildWorkerPrompt({
    issueUrl: session.issue.url,
    kind: options.kind,
    systemPrompt: options.systemPrompt,
    worktreePath: session.worktree.path,
    sessionState: options.sessionState,
  });
}

export async function runAttachedWorkerPrompt(
  attached: AttachedWorker,
  prompt: string,
  permissionHandler?: PermissionHandler,
): Promise<WorkerDispatchResult> {
  const promptResult = await runWorkerAcpPrompt(attached.session, prompt, {
    permissionHandler,
  });
  return buildWorkerDispatchResult({
    name: attached.name,
    kind: attached.kind,
    session: attached.session,
    prompt,
    promptResult,
  });
}
