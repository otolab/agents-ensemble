# ADR 0003: conductor は `mode: plan`

- Status: superseded by [ADR 0005](0005-conductor-is-not-plan-mode.md)
- Date: 2026-08-08

## Context

conductor は「演奏しない」。ファイル編集・シェル実行・直接実装は worker の domain とする（[ADR 0002](0002-star-topology-sdk-conductor-acp-worker.md)）。

`@cursor/sdk` の `Agent.create` には `mode` がある。conductor にどの mode を渡すかで、標準ツールの使い方や応答の傾向が変わる。

検討した選択肢:

| mode | 意図 | 懸念 |
|------|------|------|
| `agent` | フルエージェント。柔軟 | conductor が実作業に寄りやすい。hooks / customTools だけでは不十分な場合がある |
| **`plan`** | 計画・調査寄り | 「プラン更新」でターンが終わらない。終了条件と衝突しうる（e2e で観測） |
| ツール制限のみ | mode は agent、編集系を deny | 設定と検証コスト。SDK の挙動変更に追従が必要 |

**比較検証（A/B）やメトリクスに基づく「最適」判定は行っていない。** architecture のサンプルと Issue #7 の実装方針を踏襲した設計上の仮説である。

## Decision

`packages/core/src/conductor/conductor-agent.ts` で conductor を **`mode: 'plan'`** 固定とする。

併用する担保:

- `customTools` は **`ask_human` のみ**（worker 起動はセッション開始時。dispatch tool は採用しない）
- PromptModule / materials で委任方針を明示
- agents-ensemble リポジトリに `.cursor/` は置かない（作業 repo と混同しない）

## Consequences

- 良い: 「指揮者はプランと判断」とモデル・プロダクト双方のバイアスが一致しやすい
- 悪い: 短い完了シグナル（例: `conductor-ok`）よりプラン文が出やすい。e2e の終了条件設計に影響（`issue.e2e` で未達の一例あり）
- フォロー:
  - e2e / integration で終了条件を詰める（materials・max-turns・期待値）
  - plan で足りない場合は **ADR を更新**し、mode 変更またはツール deny 方針を別 ADR で記録する
  - 「plan が最適」とは言わない。現時点の**仮説**として accepted

> **Note (2026-08-08):** [ADR 0005](0005-conductor-is-not-plan-mode.md) により、conductor と plan mode の同一視は撤回。本 ADR は「当時 plan を付けた経緯」の履歴として残す。
