/** harness が worker ラウンド完了時に保持する結果型。 */

import type { PromptResult } from '../acp/types.js';
import type { IssueRef } from '../issue/issue-ref.js';
import type { WorktreeRef } from '../worktree/worktree.js';
import type { WorkerAcpSession } from './worker-acp-session.js';

/** harness 起因の init prompt か、conductor 指示の prompt か。 */
export type WorkerPromptSource = 'harness' | 'conductor';

export interface WorkerDispatchResult {
  name: string;
  kind: string;
  issue: IssueRef;
  worktree: WorktreeRef;
  prompt: string;
  promptResult: PromptResult;
  acpSessionId: string;
  source?: WorkerPromptSource;
}

export function buildWorkerDispatchResult(input: {
  name: string;
  kind: string;
  session: WorkerAcpSession;
  prompt: string;
  promptResult: PromptResult;
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
