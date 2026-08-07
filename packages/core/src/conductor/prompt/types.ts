import type { MaterialElement } from '@modular-prompt/core';
import type { ReviewerDispatchResult } from '../../dispatch/reviewer-dispatch.js';
import type { WorkerDispatchResult } from '../../dispatch/worker-dispatch.js';
import type { EscalationRecord } from '../../escalation/human-inquiry.js';
import type { IssueContext } from '../../github/issue-context.js';
import type { WorkerFailureRecord, WorkerStartedInfo } from '../../runtime/types.js';

export interface ConductorMaterial {
  id: string;
  title: string;
  content: string;
}

export interface ConductorPromptContext {
  repoRoot: string;
  issueContext: IssueContext;
  materials?: ConductorMaterial[];
  briefing?: string;
  followUp?: string;
  turn?: number;
  maxTurns?: number;
  workerDispatches?: WorkerDispatchResult[];
  reviewerDispatches?: ReviewerDispatchResult[];
  workerFailures?: WorkerFailureRecord[];
  runningWorkers?: WorkerStartedInfo[];
  escalations?: EscalationRecord[];
  humanGuidance?: string;
}

export function toMaterialElement(material: ConductorMaterial): MaterialElement {
  return {
    type: 'material',
    id: material.id,
    title: material.title,
    content: material.content,
  };
}
