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
  workspacePath?: string;
  worktreeInRepo?: boolean;
  sessionState: EnsembleSessionState;
  agentModule?: PromptModule;
}

const workerAttachModule: PromptModule<WorkerDispatchContext> = {
  instructions: [
    (ctx) =>
      ctx.worktreeInRepo
        ? '⚠️ 特別モード: メイン worktree（リポジトリルート）で直接作業する。通常の isolated worktree は使わない。'
        : ctx.workspacePath && ctx.workspacePath !== ctx.worktreePath
          ? `作業ディレクトリ: ${ctx.workspacePath}（Issue worktree とは別の ACP cwd）`
          : ctx.worktreePath
            ? `作業 worktree: ${ctx.worktreePath}`
            : null,
    '- 自分の立場: conductor 配下の実作業者。Issue / PR 上の記録も成果物',
    '- 届く prompt の種類: **init prompt**（本 prompt・attach 用・待機が目的）と **instruction**（conductor からの本番作業指示）',
    '- セッションに attach 済み。conductor からの作業指示（次の session/prompt）を待つ',
    '- 本 prompt は init prompt（attach）用。実作業の開始は conductor の指示が届いてから',
  ],
};

/** attach 時の待機 prompt（役割・permission・team.md。実作業は sendWorkerMessage 側）。 */
export function buildWorkerAttachPrompt(
  options: WorkerAttachPromptOptions,
): string {
  const profileModule = profilePromptModule({
    agentModule: options.agentModule,
    materials: options.sessionState.materials,
  });
  const module = merge(mergeWorkerSystemPrompt(profileModule), workerAttachModule);
  return renderCompiledPrompt(
    compile(module, {
      ...ensembleContext(options.kind, options.issueUrl, options.sessionState),
      worktreePath: options.worktreePath,
      workspacePath: options.workspacePath,
      worktreeInRepo: options.worktreeInRepo,
    }),
  );
}
