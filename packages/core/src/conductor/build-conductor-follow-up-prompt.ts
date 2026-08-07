import type { LibrarianDispatchResult } from '../dispatch/librarian-dispatch.js';
import type { ReviewerDispatchResult } from '../dispatch/reviewer-dispatch.js';
import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import type { EscalationRecord } from '../escalation/human-inquiry.js';
import type { IssueContext } from '../github/issue-context.js';
import { compileConductorTurnUpdate } from './prompt/compile-conductor-prompt.js';
import type { WorkerFailureRecord, WorkerStartedInfo } from '../runtime/types.js';

export interface BuildConductorFollowUpPromptOptions {
  issueContext: IssueContext;
  repoRoot: string;
  turn: number;
  maxTurns: number;
  workerDispatches: WorkerDispatchResult[];
  workerFailures?: WorkerFailureRecord[];
  reviewerDispatches: ReviewerDispatchResult[];
  librarianDispatches?: LibrarianDispatchResult[];
  escalations?: EscalationRecord[];
  runningWorkers?: WorkerStartedInfo[];
}

export function buildConductorFollowUpPrompt(
  options: BuildConductorFollowUpPromptOptions,
): string {
  return compileConductorTurnUpdate({
    repoRoot: options.repoRoot,
    issueContext: options.issueContext,
    turn: options.turn,
    maxTurns: options.maxTurns,
    workerDispatches: options.workerDispatches,
    workerFailures: options.workerFailures ?? [],
    reviewerDispatches: options.reviewerDispatches,
    librarianDispatches: options.librarianDispatches ?? [],
    escalations: options.escalations ?? [],
    runningWorkers: options.runningWorkers,
  });
}
