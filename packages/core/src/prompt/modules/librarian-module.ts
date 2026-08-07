import type { PromptModule } from '@modular-prompt/core';

export interface LibrarianPromptContext {
  skillName: string;
  repoRoot: string;
  issueUrl?: string;
  prUrl?: string;
}

/** librarian 起動プロンプト。ドキュメント整備等は Skill が正本。 */
export const librarianPromptModule: PromptModule<LibrarianPromptContext> = {
  objective: ['指定された librarian Skill に沿って、対象リポジトリのドキュメント整備等を行う。'],
  methodology: [
    '- 対象 clone 上で独立 session として作業する',
    '- worker / reviewer の worktree には依存しない（必要なら Skill 内で判断）',
    '- 成果は Issue / PR コメント等、Skill が定める正本に書く',
  ],
  inputs: [
    (ctx) => `librarian Skill: ${ctx.skillName}`,
    (ctx) => `対象 clone: ${ctx.repoRoot}`,
    (ctx) => (ctx.issueUrl ? `関連 Issue: ${ctx.issueUrl}` : null),
    (ctx) => (ctx.prUrl ? `関連 PR: ${ctx.prUrl}` : null),
  ],
};
