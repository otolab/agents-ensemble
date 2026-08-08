import type { MaterialElement } from '@modular-prompt/core';
import type { WorkerDispatchResult } from '../../dispatch/worker-dispatch.js';
import type { EscalationRecord } from '../../escalation/human-inquiry.js';
import type { IssueContext } from '../../github/issue-context.js';
import type { PendingPermission } from '../../permission/pending-permission.js';
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
  /** 直近オペレータ入力から消費した conductor 自律ターン数。 */
  autonomousTurns?: number;
  maxTurns?: number;
  workerDispatches?: WorkerDispatchResult[];
  workerFailures?: WorkerFailureRecord[];
  runningWorkers?: WorkerStartedInfo[];
  pendingPermissions?: PendingPermission[];
  escalations?: EscalationRecord[];
}

export function toMaterialElement(material: ConductorMaterial): MaterialElement {
  return {
    type: 'material',
    id: material.id,
    title: material.title,
    content: material.content,
  };
}
