# ADR 0082: operator-agent の watch report ack を send retry から分離する

- Status: accepted
- Date: 2026-11-16
- Related: [ADR 0037](0037-operator-agent-session-watch-and-dispatch.md), [ADR 0080](0080-operator-watch-state-lock-transaction.md), [ADR 0081](0081-operator-watch-pending-report-handoff.md), [Issue #736](https://github.com/otolab/agents-ensemble/issues/736)

## Context

`agent.send` が完了した後に profile lock の取得が失敗すると、watch pool は pending report を disk に残して error を返す。これを通常 dispatch queue へ戻すと、次の batch は完了済みの conductor turn を再送する。一方、ack error を runner まで伝播させると CLI が終了し、稼働中 process 内の retry は行われない。send 完了と ack 永続化は別の段階として扱う必要がある。

## Decision

- `agent.send` が未完了の場合は従来どおり同じ report ID を通常 dispatch queue に戻し、5 秒後に send を retry する。
- `agent.send` が成功した後の ack failure は通常 dispatch queue に戻さない。report ID を process 内で in-flight のまま保持し、同じ batch に対する ack だけを5秒間隔で最大3回 retry する。retry 中に conductor への再 send は行わない。
- ack retry が成功したら durable pending から report を削除し、queue の in-flight ID を解放する。ack は同じ report ID に対して冪等に処理する。
- 初回 ack と3回の retry がすべて失敗した場合は pending を disk に保持し、明示 error を出して runner を終了する。無限 retry や後続 turn による順序の追い越しを避ける。再起動後は at-least-once 契約に従って同じ ID が再送されることがあり、重複 turn の可能性を operator に知らせる。
- SIGINT / SIGTERM が retry 待ちに入った場合は次の ack を開始せず shutdown する。pending は disk に残り、再起動後の replay に委ねる。

## Consequences

- 一時的な lock contention から回復すれば、同一 runner が最大15秒の待機内に ack を再試行できる。各 ack の profile lock acquisition は従来どおり最大40回・25ms間隔で失敗を返すため、実際の完了時間にはその取得時間も加わる。
- 送信済み turn の ack failure で `agent.send` を重ねない。送信結果が確定しないケースは従来の通常 retry と at-least-once 契約を維持する。
- retry 予算を使い切った場合や retry 中に shutdown した場合、pending report を消さない。再起動時の再送で同一 report が重複する可能性は残り、exactly-once は保証しない。
- pool の ack が単独で失敗した場合は caller に error を返し、通常 dispatch queue へ自動投入しない。operator-agent runner が ack-only retry を所有する。
