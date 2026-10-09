# ADR 0027: permission 停滞通知の低優先度 dispatch

- Status: accepted
- Date: 2026-10-09
- Related: Issue [#416](https://github.com/otolab/agents-ensemble/issues/416), [ADR 0009](0009-conductor-session-event-queue.md), [ADR 0014](0014-conductor-dispatch-batch-coalescing.md), [ADR 0016](0016-bootstrap-permission-conductor-wait.md)

## Context

permission が pending のまま worker の活動状態が続くと、既存の permission-deadlock-monitor は operator 向けに `harness.warning` を 1 回出す。既定閾値は 30 秒だったが、通常の ACP / conductor の処理時間に対して短く、誤検知しやすかった。

一方、warning だけでは conductor が `resolve_permission` を試す契機にならない。停滞を conductor にも伝える必要があるが、同じ `SessionEventQueue` には operator 入力と `permission.pending` があり、停滞通知がそれらを押しのけると対話や許可判断を遅延させる。また、max-turns 到達後に permission 回復の通知まで止めると、停滞を解消できない。

## Decision

- permission-deadlock-monitor の既定停滞閾値を `300_000ms`（300 秒）にする。poll 間隔 `permissionDeadlockPollMs` は既存の `5_000ms`（5 秒）から変更しない。
- 閾値到達時は、既存の operator 向け `harness.warning` を維持し、同じ検知で `permission.stall` を `SessionEventQueue` に enqueue する。連続する同一停滞エピソードでは両方とも 1 回だけ通知し、pending が解消してリスク状態が解除された後の再発時に再通知する。
- `permission.stall` は `permission.pending` の再送ではなく、停滞メッセージ、pending の ID / 件数、最古の作成時刻、経過時間、閾値を持つ独立した `SessionEvent` とする。conductor はこの通知を契機に `resolve_permission` または operator へのエスカレーションを判断する。
- `permission.stall` は `inform` ではなく通常の trigger として扱う。静的優先度は `operator.message` → `permission.pending` → worker / GitHub の既存 trigger → `permission.stall` の順とし、同じ queue に高優先度イベントがある場合は後回しにする。dispatch hold 中は他の trigger と同様に held buffer に保持する。
- max-turns 到達後も、`operator.message` / `permission.pending` に続く permission 回復用の例外として `permission.stall` は dispatch 可能とする。これにより高優先度の operator 入力・許可判断を妨げずに、conductor が停滞を解消できる。
- CLI の `--permission-deadlock-stall-ms` と API の `RunConductorSessionOptions.permissionDeadlockStallMs` は同じ core default (`300_000ms`) を使う。worker UI と `permissionDeadlockPollMs` のスコープは変更しない。

## Consequences

- operator は従来どおり `[harness] warning` を受け取れる。conductor には低優先度の構造化通知が届き、停滞の対象と経過時間を判断できる。
- operator 入力と通常の permission 判断は停滞通知より常に優先される。停滞通知は max-turns 後にも届くため、permission 待ちのまま session が進まない状態から回復する余地が残る。
- 既定閾値が延長されるため、30 秒以内の短い permission 処理では warning が出にくくなる。個別の運用で早い検知が必要な場合は CLI / API の明示値を使う。
- `permission.stall` は SessionLogEvent ではないため、既存の operator テレメトリや worker UI のイベント契約を増やさない。将来 UI 表示が必要になった場合は別途判断する。
