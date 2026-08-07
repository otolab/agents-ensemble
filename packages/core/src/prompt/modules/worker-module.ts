import type { PromptModule } from '@modular-prompt/core';

export interface WorkerPromptContext {
  issueUrl: string;
  skillName: string;
  worktreePath?: string;
}

/**
 * worker 起動プロンプト。
 * Instructions 系（目的・手順）と Data 系（Issue URL 等）を分離する。
 */
export const workerPromptModule: PromptModule<WorkerPromptContext> = {
  objective: ['与えられた GitHub Issue に対応する。'],
  methodology: [
    '- 作業ブランチを切り、worktreeを作成して作業する',
    '- 指定された SKILL 文書に沿って丁寧に作業する',
  ],
  guidelines: [
    '- 調査結果や作業方針決定のタイミングで、Issueに小さく報告する',
  ],
  inputs: [
    (ctx) => ctx.issueUrl,
    (ctx) => `作業 Skill: ${ctx.skillName}`,
    (ctx) =>
      ctx.worktreePath ? `作業 worktree: ${ctx.worktreePath}` : null,
  ],
};
