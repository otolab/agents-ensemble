# ADR 0057: idle worker 中も pending permission の停滞を検知

- Status: accepted
- Date: 2026-11-06
- Related: [ADR 0027](0027-permission-stall-notification.md), [ADR 0056](0056-permission-stall-dispatch-hold.md), [Issue #639](https://github.com/otolab/agents-ensemble/issues/639)
- Supersedes（部分的）: ADR 0027 の worker / attach 活動を要求する検知条件のみ

## Context

`WorkerRuntime.runningCount` は ACP prompt が idle を返した直後に届く permission request も取りこぼさないよう、inbox の pending permission を数える。一方、permission stall monitor は attach 中または `processing` worker がいる場合だけを停滞リスクとしていた。そのため permission が未解決のまま worker と attach が idle になると、session は待機を続けるのに `permission.stall` は通知されない。

dispatch hold 中は `permission.pending` が held buffer に残る。stall も届かなければ conductor は hold の解除も permission の確認もできず、Issue #639 の観測状態から自律回復する経路がなくなる。

## Decision

- `PermissionPipeline.pending` に permission が残っていることを stall 検知の根拠とする。worker が `processing` か、attach 中かは条件にしない。
- 最古の pending が既定 `300_000ms` の閾値に達したら、従来どおり operator 向け `harness.warning` と conductor 向け `permission.stall` を同時に出す。poll 間隔と閾値設定は変更しない。
- 連続して pending がある間は通知を 1 回に抑え、pending がすべて解消した後の再発時に再通知する。pending がなければ worker activity にかかわらず通知しない。
- monitor は session teardown / shutdown abort で停止し、終了後に stall を enqueue しない。dispatch hold を自動解除しない動作は ADR 0056 のままとする。

## Consequences

- worker prompt が idle を報告した後も permission が残る場合、閾値後に conductor が hold 解除や permission 判断へ進む契機が届く。
- worker activity がないだけでは stall を抑止しない。一方、未解決 permission がなければ通知は出ず、重複通知と終了後の通知も増えない。
- hold 中の pending 詳細は従来どおり held buffer に残る。conductor は stall の内容だけで自動判断せず、必要な場合に hold を明示的に解除する。
