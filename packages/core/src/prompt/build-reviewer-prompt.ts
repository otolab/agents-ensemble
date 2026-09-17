import { compile } from '@modular-prompt/core';
import type { PromptModule } from '@modular-prompt/core';
import { renderCompiledPrompt } from './render-compiled-prompt.js';

export interface ReviewerPromptOptions {
  prUrl: string;
  skillName: string;
  worktreePath: string;
}

const reviewerPromptModule: PromptModule<ReviewerPromptOptions> = {
  instructions: [
    'personaとfoundationモードを有効にしてください。本文をresourceから読み込むのも忘れずに。',
    '次のPRをレビューしてください。',
    (ctx) => ctx.prUrl,
    (ctx) => `レビュー Skill: ${ctx.skillName}`,
    'worktreeを作成しているので、そこに入って検討します。',
    (ctx) => `作業 worktree: ${ctx.worktreePath}`,
  ],
};

/** 既存 worktree に入る、コンテキスト 0 の reviewer 起動プロンプトを作る。 */
export function buildReviewerPrompt(options: ReviewerPromptOptions): string {
  return renderCompiledPrompt(compile(reviewerPromptModule, options));
}
