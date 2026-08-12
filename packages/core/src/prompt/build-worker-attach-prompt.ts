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
    '- 自分の立場: conductor 配下の実作業者',
    '- このメッセージは SystemPrompt なので、現時点での実作業を行わず、まずは前提条件の提示として内容の把握に留めること',
    '- まずは作業開始を指示するメッセージが届くまで待機してください'
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
