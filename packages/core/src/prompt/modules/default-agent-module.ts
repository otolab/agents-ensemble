import type { PromptModule } from '@modular-prompt/core';

export interface DefaultAgentPromptContext {
  issueUrl: string;
  worktreePath?: string;
  kind: string;
  systemPrompt?: string;
}

/** 全 worker 共通のフォールバック system prompt（Skill 固定なし）。 */
export const defaultAgentModule: PromptModule<DefaultAgentPromptContext> = {
  objective: ['与えられた GitHub Issue に対応する。'],
  methodology: [
    '- 作業ブランチを切り、worktree を作成して作業する',
    '- materials や Issue の指示に沿って作業する',
    '- 必要に応じて Skill を読み込む',
  ],
  guidelines: [
    '- 調査結果や作業方針決定のタイミングで、Issue に小さく報告する',
  ],
  inputs: [
    (ctx) => ctx.issueUrl,
    (ctx) => `agent kind: ${ctx.kind}`,
    (ctx) =>
      ctx.worktreePath ? `作業 worktree: ${ctx.worktreePath}` : null,
    (ctx) => (ctx.systemPrompt ? `起動指示:\n${ctx.systemPrompt}` : null),
  ],
};
