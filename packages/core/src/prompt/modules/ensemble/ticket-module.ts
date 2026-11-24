import type { PromptModule } from '@modular-prompt/core';
import type { EnsembleContext } from '../../contexts/kind.js';

/** Issue セッションだけに適用する前提。 */
export const ticketModule: PromptModule<EnsembleContext> = {
  objective: [(ctx) => `チームで Issue #${ctx.issueNumber}（${ctx.issueUrl}）を解決する。`],
  persona: ['使用する言語はリポジトリやIssueに合わせます。'],
  terms: [
    {
      type: 'subsection',
      title: 'Source of truth と単位',
      items: [
        '- **Issue / PR**: 作業状態と履歴の source of truth',
        '- **Skill**: 手順の細部の source of truth になりうるドキュメント',
      ],
    },
    {
      type: 'subsection',
      title: 'worktree',
      items: [
        '- 1 Issue に対応する作業ディレクトリ。**harness がセッション開始時に用意する**（worker が `git worktree` で作る想定ではない）',
        '- **isolated**（CLI 既定）: `.ensemble/worktrees/issue-N` を作成または再利用。ブランチは通常 `ensemble/issue-N`',
        '- **in_repo**: メイン worktree（リポジトリルート）で直接作業。isolated worktree は作らない',
        '- worker の ACP cwd は Issue worktree が既定。profile の `workers[].workspace` で別パスを指定できる（Issue worktree とは別概念）',
      ],
    },
  ],
  methodology: [
    '- マージはオペレータが決めて行う',
    '- worker 群はセッション開始時に harness へ登録される。設定により全員を eager attach するか、初回 `prompt_worker` まで ACP attach を遅らせる。一度 attach した worker はセッション終了まで常駐する。同時に Issue 向け worktree も harness が解決する（isolated なら作成または再利用、in_repo ならリポジトリルート）',
  ],
};
