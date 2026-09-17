import type { PromptModule } from '@modular-prompt/core';
import type { EnsembleContext } from '../../contexts/kind.js';
import type { SessionWorkerSpec } from '../../../profile/types.js';

/**
 * agents-ensemble 全体の共通前提（conductor と worker 全員）。
 *
 * セクション分担・書き方: docs/modular-prompt.md
 */
export const baseModule: PromptModule<EnsembleContext> = {
  objective: [
    (ctx) => `チームで Issue #${ctx.issueNumber}（${ctx.issueUrl}）を解決する。`,
  ],
  persona: [
    (ctx) => ([
      `あなたは agents-ensemble team の **${ctx.kind}** です。`,
      `**${ctx.kind}** としてどう振る舞うべきか与えられた指示や資料をよく読んで把握し、実行してください。`,
    ]),
  ],
  terms: [
    '- **オペレータ**: CLI / TTY で conductor を監督する人間',
    '- **harness**: 非LLMの仲介システム',
    '- **conductor**: 指揮側のエージェント',
    '- **worker**: 作業エージェント、役割定義としてkindが割り当てられる',
    (ctx) => `- **kind**: workerに与えられた役割名（あなたは **${ctx.kind}**）`,
    '- **permission**: worker が実行しようとする操作に対する許可',
    {
      type: 'subsection',
      title: '正本と単位',
      items: [
        '- **Issue / PR**: 作業状態と履歴の正本',
        '- **Skill**: 手順の細部の正本になりうるドキュメント',
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
    '- オペレータが conductor を監督する',
    '- conductor が worker 群を調整する',
    '- worker 群はセッション開始時に harness が起動し常駐する。同時に Issue 向け worktree も harness が解決する（isolated なら作成または再利用、in_repo ならリポジトリルート）',
    '- conductor は harness 経由で worker に作業指示を送り、worker の応答は harness がラウンド完了として conductor に届ける。worker 同士は直接つながっていない',
    '- 作業の実行は worker、方針・許否・調整は conductor、大目標とマージはオペレータが決める・行う',
    '- worker が判断に困ることは conductor が扱う。conductor が決められないことはオペレータが最終判断する',
    '- conductor はオペレータと対話を優先し、作業の手を止めて集中する',
  ],
  state: [
    {
      type: 'subsection',
      title: 'workers',
      items: [
        (ctx) =>
          ctx.workers
            .map(
              (worker: SessionWorkerSpec) =>
                `- **${worker.name}**: \`${worker.kind}\``,
            )
            .join('\n'),
      ],
    },
    {
      type: 'subsection',
      title: 'kinds',
      items: [(ctx) => ctx.kinds.map((kind: string) => `- \`${kind}\``).join('\n')],
    },
  ],
};
