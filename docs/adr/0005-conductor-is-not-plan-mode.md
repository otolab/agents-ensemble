# ADR 0005: conductor は plan mode ではない

- Status: accepted
- Date: 2026-08-08
- Supersedes: [ADR 0003](0003-conductor-plan-mode.md)（「conductor だから plan」という読み方）

## Context

[ADR 0003](0003-conductor-plan-mode.md) および [architecture.md](../architecture.md) のサンプルにより、**conductor = `mode: plan`** と同一視しやすかった。

実際の挙動:

- plan mode で worker 完了後に「プランを更新します」と応じるのは **SDK の plan として自然**
- それは e2e の `conductor-ok` 期待と衝突するが、**conductor として誤った動作ではない**
- conductor の仕事はプラン作成だけではなく、状態把握・worker 制御・permission・エスカレーションを含む

一方、PromptModule（`conductor-system-module`）、profile materials、`customTools`（`ask_human`）で **指揮専任の振る舞いはプロンプト側に書ける**。plan mode は必須の定義ではない。

## Decision

1. **conductor** は役割・プロセスとして定義する（スター型、inbox、プロファイル、materials）。SDK の `mode` とは別レイヤ。
2. **`mode: plan` は conductor の同義語ではない**。実装抑制のための任意の SDK オプション（現状コードでは引き続き使用。変更は別 ADR）。
3. ドキュメントでは「plan = conductor」と書かない。architecture は「plan は演奏しないことの担保の**一手段**」と読む。
4. e2e / smoke の終了条件は **plan mode の出口**と **スモーク用シグナル**を混同しない。materials か期待値を揃える。

## Consequences

- 良い: 役割と SDK 設定の責務が分離される。e2e 失敗の解釈が明確になる
- 悪い: ADR 0003 と併存期間の読み手の混乱（0003 は superseded 表記で残す）
- フォロー:
  - `mode: agent` への変更 → [ADR 0006](0006-conductor-agent-mode.md)
  - e2e `issue.e2e` の終了条件は agent mode 前提で再検証
