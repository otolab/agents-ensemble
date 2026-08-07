import type { PromptModule } from '@modular-prompt/core';

export interface ReviewerPromptContext {
  prUrl: string;
  skillName: string;
  worktreePath: string;
}

/** reviewer 起動プロンプト。PR URL 等は Data 系 inputs に置く。 */
export const reviewerPromptModule: PromptModule<ReviewerPromptContext> = {
  objective: ['与えられた PR を独立した視点でレビューする。'],
  methodology: [
    '- 既存の worker worktree に入って検討する',
    '- 指定されたレビュー SKILL に沿って検証する',
  ],
  inputs: [
    (ctx) => ctx.prUrl,
    (ctx) => `レビュー Skill: ${ctx.skillName}`,
    (ctx) => `作業 worktree: ${ctx.worktreePath}`,
  ],
};
