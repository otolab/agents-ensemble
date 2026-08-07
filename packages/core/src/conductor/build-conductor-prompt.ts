import type { IssueContext } from '../github/issue-context.js';
import { compileConductorSessionStart } from './prompt/compile-conductor-prompt.js';
import { mergeConductorMaterials } from './prompt/materials.js';
import type { ConductorMaterial } from './prompt/types.js';
import type { WorkerStartedInfo } from '../runtime/types.js';

export type { ConductorMaterial } from './prompt/types.js';
export { loadConductorMaterialFromFile } from './prompt/materials.js';

export interface BuildConductorPromptOptions {
  issueContext: IssueContext;
  repoRoot: string;
  materials?: ConductorMaterial[];
  briefing?: string;
  followUp?: string;
  turn?: number;
  maxTurns?: number;
  runningWorkers?: WorkerStartedInfo[];
}

export function buildConductorPrompt(
  options: BuildConductorPromptOptions,
): string {
  return compileConductorSessionStart({
    repoRoot: options.repoRoot,
    issueContext: options.issueContext,
    materials: mergeConductorMaterials(options.materials, options.briefing),
    followUp: options.followUp,
    turn: options.turn ?? 1,
    maxTurns: options.maxTurns,
    runningWorkers: options.runningWorkers,
  });
}
