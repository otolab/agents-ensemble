import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import type { EscalationRecord } from '../escalation/human-inquiry.js';
import type { IssueContext } from '../github/issue-context.js';
import { compileConductorTurnUpdate } from './prompt/compile-conductor-prompt.js';
import type { WorkerFailureRecord, WorkerStartedInfo } from '../runtime/types.js';
import type { PendingPermission } from '../permission/pending-permission.js';

export interface BuildConductorFollowUpPromptOptions {
  issueContext: IssueContext;
  repoRoot: string;
  turn: number;
  maxTurns: number;
  workerDispatches: WorkerDispatchResult[];
  workerFailures?: WorkerFailureRecord[];
  escalations?: EscalationRecord[];
  runningWorkers?: WorkerStartedInfo[];
  pendingPermissions?: PendingPermission[];
  humanGuidance?: string;
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
    escalations: options.escalations ?? [],
    runningWorkers: options.runningWorkers,
    pendingPermissions: options.pendingPermissions,
    humanGuidance: options.humanGuidance,
  });
}
