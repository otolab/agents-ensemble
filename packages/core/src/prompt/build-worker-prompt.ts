import { compile, merge } from '@modular-prompt/core';
import type { PromptModule } from '@modular-prompt/core';
import type { EnsembleSessionState } from '../profile/types.js';
import type { WorkerDispatchContext } from './contexts/kind.js';
import { ensembleContext } from './contexts/kind.js';
import { mergeWorkerSystemPrompt } from './modules/ensemble/index.js';
import { profilePromptModule } from './modules/shared/profile-prompt-module.js';
import { renderCompiledPrompt } from './render-compiled-prompt.js';

export interface WorkerPromptOptions {
  issueUrl: string;
  kind: string;
  worktreePath?: string;
  sessionState: EnsembleSessionState;
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
    materials: options.sessionState.materials,
  });
  const module = merge(mergeWorkerSystemPrompt(profileModule), workerDispatchModule);
  return renderCompiledPrompt(
    compile(module, {
      ...ensembleContext(options.kind, options.issueUrl, options.sessionState),
      worktreePath: options.worktreePath,
    }),
  );
}
