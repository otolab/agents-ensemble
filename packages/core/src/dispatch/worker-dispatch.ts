import { AcpBridge } from '../acp/acp-bridge.js';
import type { SessionUpdateHandler } from '../acp/acp-client.js';
import type { SpawnAcpProcessOptions } from '../acp/acp-process.js';
import type { PermissionHandler } from '../acp/types.js';
import type { EnsembleSessionState } from '../profile/types.js';
import { buildWorkerPrompt } from '../prompt/build-worker-prompt.js';
import { parseIssueUrl } from '../issue/issue-ref.js';
import {
  resolveWorkerWorkspace,
  type WorkerWorktreeMode,
} from '../worktree/worktree.js';
import {
  closeWorkerAcpSession,
  openWorkerAcpSession,
  runWorkerAcpPrompt,
} from './worker-acp-session.js';

export interface WorkerDispatchOptions {
  name: string;
  issueUrl: string;
  kind: string;
  systemPrompt?: string;
  sessionState: EnsembleSessionState;
  repoRoot: string;
  /** sidecar から復元する ACP session id。 */
  resumeAcpSessionId?: string;
  worktreeMode?: WorkerWorktreeMode;
  spawn?: SpawnAcpProcessOptions;
  /** integration 用: 接続済み bridge を注入（未指定時は spawn して接続）。 */
  bridge?: AcpBridge;
  onUpdate?: SessionUpdateHandler;
  permissionHandler?: PermissionHandler;
}

export interface WorkerDispatchResult {
  name: string;
  kind: string;
  issue: import('../issue/issue-ref.js').IssueRef;
  worktree: import('../worktree/worktree.js').WorktreeRef;
  prompt: string;
  promptResult: import('../acp/types.js').PromptResult;
  acpSessionId: string;
}

const WORKER_RESUME_PROMPT =
  '前回の続きです。Issue / worktree の最新状態を踏まえ、中断していた作業を再開してください。';

/** CLI 等の one-shot。session 終了後に bridge を閉じる。 */
export async function dispatchWorker(
  options: WorkerDispatchOptions,
): Promise<WorkerDispatchResult> {
  const issue = parseIssueUrl(options.issueUrl);
  const worktree = await resolveWorkerWorkspace(
    options.repoRoot,
    issue,
    options.worktreeMode,
  );
  const session = await openWorkerAcpSession({
    issueUrl: options.issueUrl,
    worktree,
    resumeAcpSessionId: options.resumeAcpSessionId,
    bridge: options.bridge,
    spawn: options.spawn,
    permissionHandler: options.permissionHandler,
  });

  const prompt = options.resumeAcpSessionId
    ? WORKER_RESUME_PROMPT
    : buildWorkerPrompt({
        issueUrl: session.issue.url,
        kind: options.kind,
        systemPrompt: options.systemPrompt,
        worktreePath: session.worktree.path,
        sessionState: options.sessionState,
      });

  try {
    const promptResult = await runWorkerAcpPrompt(session, prompt, {
      permissionHandler: options.permissionHandler,
      onUpdate: options.onUpdate,
    });
    return buildWorkerDispatchResult({
      name: options.name,
      kind: options.kind,
      session,
      prompt,
      promptResult,
    });
  } finally {
    await closeWorkerAcpSession(session);
  }
}

export function buildWorkerDispatchResult(input: {
  name: string;
  kind: string;
  session: import('./worker-acp-session.js').WorkerAcpSession;
  prompt: string;
  promptResult: import('../acp/types.js').PromptResult;
}): WorkerDispatchResult {
  return {
    name: input.name,
    kind: input.kind,
    issue: input.session.issue,
    worktree: input.session.worktree,
    prompt: input.prompt,
    promptResult: input.promptResult,
    acpSessionId: input.session.sessionId,
  };
}

export {
  closeWorkerAcpSession,
  openWorkerAcpSession,
  runWorkerAcpPrompt,
  type ConnectWorkerAcpFn,
  type WorkerAcpSession,
} from './worker-acp-session.js';
