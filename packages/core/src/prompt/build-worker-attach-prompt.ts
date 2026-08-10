import { compile, merge } from '@modular-prompt/core';
import type { PromptModule } from '@modular-prompt/core';
import type { EnsembleSessionState } from '../profile/types.js';
import type { WorkerDispatchContext } from './contexts/kind.js';
import { ensembleContext } from './contexts/kind.js';
import { mergeWorkerSystemPrompt } from './modules/ensemble/index.js';
import { profilePromptModule } from './modules/shared/profile-prompt-module.js';
import { renderCompiledPrompt } from './render-compiled-prompt.js';

export interface WorkerAttachPromptOptions {
  issueUrl: string;
  kind: string;
  worktreePath?: string;
  worktreeInRepo?: boolean;
  sessionState: EnsembleSessionState;
  systemPrompt?: string;
}

const workerAttachModule: PromptModule<WorkerDispatchContext> = {
  instructions: [
    (ctx) =>
      ctx.worktreeInRepo
        ? '⚠️ 特別モード: メイン worktree（リポジトリルート）で直接作業する。通常の isolated worktree は使わない。'
        : ctx.worktreePath
          ? `作業 worktree: ${ctx.worktreePath}`
          : null,
    '- セッションに attach 済み。conductor からの作業指示（次の session/prompt）を待つ',
    '- 本 prompt は attach 用。実作業の開始は conductor の指示が届いてから',
  ],
};

/** attach 時の待機 prompt（役割・permission・team.md。実作業は sendWorkerMessage 側）。 */
export function buildWorkerAttachPrompt(
  options: WorkerAttachPromptOptions,
): string {
  const profileModule = profilePromptModule({
    roleBootstrap: options.systemPrompt,
    materials: options.sessionState.materials,
  });
  const module = merge(mergeWorkerSystemPrompt(profileModule), workerAttachModule);
  return renderCompiledPrompt(
    compile(module, {
      ...ensembleContext(options.kind, options.issueUrl, options.sessionState),
      worktreePath: options.worktreePath,
      worktreeInRepo: options.worktreeInRepo,
    }),
  );
}
