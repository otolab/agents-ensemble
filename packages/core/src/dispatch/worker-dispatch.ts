/** harness が worker ラウンド完了時に保持する結果型。 */

/** harness 起因の init prompt か、conductor 指示の prompt か。 */
export type WorkerPromptSource = 'harness' | 'conductor';

export interface WorkerDispatchResult {
  name: string;
  kind: string;
  issue: import('../issue/issue-ref.js').IssueRef;
  worktree: import('../worktree/worktree.js').WorktreeRef;
  prompt: string;
  promptResult: import('../acp/types.js').PromptResult;
  acpSessionId: string;
  source?: WorkerPromptSource;
}

export function buildWorkerDispatchResult(input: {
  name: string;
  kind: string;
  session: import('./worker-acp-session.js').WorkerAcpSession;
  prompt: string;
  promptResult: import('../acp/types.js').PromptResult;
  source?: WorkerPromptSource;
}): WorkerDispatchResult {
  return {
    name: input.name,
    kind: input.kind,
    issue: input.session.issue,
    worktree: input.session.worktree,
    prompt: input.prompt,
    promptResult: input.promptResult,
    acpSessionId: input.session.sessionId,
    ...(input.source ? { source: input.source } : {}),
  };
}

export {
  closeWorkerAcpSession,
  openWorkerAcpSession,
  runWorkerAcpPrompt,
  type ConnectWorkerAcpFn,
  type WorkerAcpSession,
} from './worker-acp-session.js';
