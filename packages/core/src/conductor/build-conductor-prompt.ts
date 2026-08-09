import type { IssueContext } from '../github/issue-context.js';
import { compileConductorSessionStart } from './prompt/compile-conductor-prompt.js';
import { mergeConductorMaterials } from './prompt/materials.js';
import type { ConductorMaterial } from './prompt/types.js';
import type { WorkerFailureRecord, WorkerStartedInfo } from '../runtime/types.js';
import type { PendingPermission } from '../permission/pending-permission.js';

export type { ConductorMaterial } from './prompt/types.js';
export { loadConductorMaterialFromFile } from './prompt/materials.js';

export interface BuildConductorPromptOptions {
  issueContext: IssueContext;
  repoRoot: string;
  /** profile の `agents.conductor` から解決した起動文書。 */
  roleSystemPrompt?: string;
  materials?: ConductorMaterial[];
  briefing?: string;
  followUp?: string;
  turn?: number;
  autonomousTurns?: number;
  maxTurns?: number;
  runningWorkers?: WorkerStartedInfo[];
  pendingPermissions?: PendingPermission[];
}

export function buildConductorPrompt(
  options: BuildConductorPromptOptions,
): string {
  return compileConductorSessionStart({
    repoRoot: options.repoRoot,
    issueContext: options.issueContext,
    roleSystemPrompt: options.roleSystemPrompt,
    materials: mergeConductorMaterials(options.materials, options.briefing),
    followUp: options.followUp,
    turn: options.turn ?? 1,
    autonomousTurns: options.autonomousTurns,
    maxTurns: options.maxTurns,
    runningWorkers: options.runningWorkers,
    pendingPermissions: options.pendingPermissions,
  });
}
