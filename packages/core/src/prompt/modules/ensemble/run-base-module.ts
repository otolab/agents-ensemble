import type { PromptModule } from '@modular-prompt/core';
import type { WorkspaceEnsembleContext } from '../../contexts/workspace-kind.js';

/**
 * `ensemble run` 向けの共通前提（GitHub Issue を正本にしない）。
 */
export const runBaseModule: PromptModule<WorkspaceEnsembleContext> = {
  objective: [
    (ctx) =>
      `チームで作業場 **${ctx.workspaceSlugKey}**（起動 cwd に閉じた conductor run）の指示に従う。`,
  ],
  persona: ['使用する言語はリポジトリやオペレータの指示に合わせます。'],
  terms: [
    (ctx) => `- **作業場 slug**: \`${ctx.workspaceSlugKey}\`（永続化・Notes の名前空間）`,
    {
      type: 'subsection',
      title: 'Source of truth',
      items: [
        '- **brief ファイルとオペレータ指示**: 初期ゴールの正本',
        '- **Notes（ノートとメモ）**: 作業の時系列と一覧用要約',
        '- **Skill**: 手順の細部の source of truth になりうるドキュメント',
      ],
    },
    {
      type: 'subsection',
      title: 'workspace（作業ディレクトリ）',
      items: [
        '- 起動時 cwd に閉じる。**in_repo** 既定: isolated worktree は作らず、リポジトリルート（または起動 cwd）で直接作業する',
        '- worker の ACP cwd は起動 cwd が既定。profile の `workers[].workspace` で別パスを指定できる',
      ],
    },
  ],
};
