import { compile, merge } from '@modular-prompt/core';
import type { PromptModule } from '@modular-prompt/core';
import type {
  EnsembleSessionState,
  ResolvedProfileMaterial,
} from '../profile/types.js';
import { filterMaterialsForKind } from '../profile/types.js';
import type { WorkerDispatchContext } from './contexts/kind.js';
import { ensembleContext } from './contexts/kind.js';
import { mergeWorkerSystemPrompt } from './modules/ensemble/index.js';
import { profilePromptModule } from './modules/shared/profile-prompt-module.js';
import { renderCompiledPrompt } from './render-compiled-prompt.js';
import { parseWorkspaceSessionUrl } from '../workspace-run/session-url.js';
import { workspaceEnsembleContext } from './contexts/workspace-kind.js';
import { mergeRunWorkerSystemPrompt } from './modules/ensemble/run-ensemble-index.js';

export interface WorkerPromptOptions {
  issueUrl: string;
  kind: string;
  worktreePath?: string;
  sessionState: EnsembleSessionState;
  userInstructions?: ResolvedProfileMaterial;
  /** profile の `agents.<kind>` から構築した PromptModule。 */
  agentModule?: PromptModule;
}

const workerDispatchModule: PromptModule<WorkerDispatchContext> = {
  instructions: [
    (ctx) => (ctx.worktreePath ? `作業 worktree: ${ctx.worktreePath}` : null),
  ],
};

export function buildWorkerPrompt(options: WorkerPromptOptions): string {
  const profileModule = profilePromptModule({
    agentModule: options.agentModule,
    materials: [
      ...(options.userInstructions ? [options.userInstructions] : []),
      ...filterMaterialsForKind(options.sessionState.materials, options.kind),
    ],
  });
  const workspace = parseWorkspaceSessionUrl(options.issueUrl);
  if (workspace) {
    const module = merge(mergeRunWorkerSystemPrompt(profileModule), {
      instructions: options.worktreePath ? [`作業ディレクトリ: ${options.worktreePath}`] : [],
    });
    return renderCompiledPrompt(
      compile(module, workspaceEnsembleContext(options.kind, workspace.slugKey, options.sessionState)),
    );
  }
  const module = merge(mergeWorkerSystemPrompt(profileModule), workerDispatchModule);
  return renderCompiledPrompt(
    compile(module, {
      ...ensembleContext(options.kind, options.issueUrl, options.sessionState),
      worktreePath: options.worktreePath,
    }),
  );
}
