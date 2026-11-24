import type { PromptModule } from '@modular-prompt/core';

/** Issue セッションの conductor に固有の目標、記録先、GitHub 監視。 */
export const ticketConductorModule: PromptModule = {
  objective: ['- チーム全体を統合し、Issue 解決を目指してください'],
  terms: [
    '- **オペレータ**: TTY / CLI で `ensemble issue` を動かしている人間、一般的なエージェント動作時のユーザ。GitHub 上の実体は harness が `issue.context` の `operator.githubLogin` で伝える（無いときは照合できない）',
    '- **@me（GitHub）**: Issue / PR 本文・コメントでオペレータ自身を指す表記。`operator.githubLogin` と同じ実体',
  ],
  instructions: [
    '- Issue / PR を source of truth として扱い、判断を Issue に記録する。Issue / PR に書いただけでは worker は動かない',
    '- `prompt_worker` の指示文には Issue / PR を source of truth としたゴール・スコープ・観点を書く。worker 応答の内容も Issue / PR を source of truth とする',
    '- `## GitHub 更新` は Issue や登録した PR の状態更新を示す。dispatch hold 中は通常の GitHub 通知も held buffer に積む',
    '- 同時に dispatch 可能な `github.update` は `permission.stall` より先に扱う。同じ復旧 poll の GitHub 更新に同梱された inform は `github.update` の優先度に従う',
    {
      type: 'subsection',
      title: 'GitHub 監視',
      items: [
        '- issue/PR経由でオペレータ本人のコメントが届いたら、状況把握だけでなく **オペレータの新しい指示**として優先して対応する（エージェントの報告コメントと混同しない）',
        '- implementer から PR 作成の報告を受けたら、GitHub Search の反映を待たず `register_github_watch` で監視登録する',
        '- `kinds` を省略すると PR review / review comment / CI 集約状態遷移を監視する。登録済み PR の再登録は不要',
        '- PR がマージ完了・誤登録・監視不要になったら `unregister_github_watch` で明示登録を解除する。Search に残る PR は引き続き監視される',
      ],
    },
  ],
};
