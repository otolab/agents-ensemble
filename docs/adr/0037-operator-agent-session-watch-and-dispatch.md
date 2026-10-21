# ADR 0037: operator-agent session watch と report dispatch

- Status: accepted
- Date: 2026-10-21
- Related: [ADR 0014](0014-conductor-dispatch-batch-coalescing.md), [ADR 0031](0031-operator-agent-layer.md), [ADR 0033](0033-live-open-question-control-uds.md), [Issue #525](https://github.com/otolab/agents-ensemble/issues/525)

## Context

[ADR 0031](0031-operator-agent-layer.md) は user – operator – conductor – workers の 4 層を定め、operator-agent と Issue harness を疎結合にした。複数 session の状態を継続監督するには、保存済み sidecar の単発参照だけでなく、各 session の変化を operator-agent 側で queue・集約する必要がある。

一方、conductor の [ADR 0014](0014-conductor-dispatch-batch-coalescing.md) と `ConductorSession` に横断監視の責務を加えると、Issue harness の境界が曖昧になる。既存 UDS は Open Question list / answer に限られ、イベント stream も提供しない。

## Decision

### 責務の対応

| 関心 | ADR 0031 の conductor / Issue harness | operator-agent |
|------|---------------------------------------|----------------|
| 管理単位 | 1 Issue session の conductor と workers | watch pool に登録した複数 conductor session |
| 入力 | `SessionEventQueue` の worker / permission / GitHub / operator event | TTY user input、live UDS snapshot、offline sidecar / YAML poll |
| 状態 cursor | harness sequence、GitHub monitor cursor、session sidecar | `.ensemble/operator-agent/watch-state.json` の per-session question sequence / fingerprint、status fingerprint、未 dispatch report |
| まとめ方 | ADR 0014 の source key・到着順・優先度 | 同じ user / Issue session / Open Question source を束ねて 1 `agent.send` |
| 優先度 | operator message → permission → worker continuation 1 回 → 静的優先度 | user → Open Question report → 直前 session continuation 1 回 → 到着順 |
| hold | `set_dispatch_hold` が conductor 向け trigger を保留し `operator.message` を通す | `set_report_hold` / `release_reports` が自動 report を保留し、TTY user と明示 conductor 宛て `operator.message` を通す |
| TTY 表示 | Issue TUI が conductor dispatch hold 件数を表示 | operator-agent が report hold 件数を表示 |

### 観測と UDS

- operator-agent が watch pool、poll timer、cursor、report queue を所有する。`ConductorSession` は観測 snapshot と operator message の小さな UDS handler を提供し、watch 管理を持たない。
- 登録時の poll interval は 250–60000ms、debounce は 0–10000ms の範囲で session ごとに設定する。既定値は 2000ms / 250ms。
- 稼働中 harness に接続できれば `session.observe` の live Registry sequence / 全 Open Question と session-state を使う。socket path の記録だけでは稼働中と判定しない。
- UDS が到達不能、または古い harness が snapshot method に未対応なら Open Questions YAML を優先し、YAML がなければ legacy sidecar を使う。session-state YAML も読み取り、report には観測元を表示する。壊れた YAML を sidecar で上書き補完しない。
- watch 設定、cursor、未 dispatch report は owner-only の operator-agent state に atomic 保存する。再起動時は未 dispatch report を queue に戻す。report hold は一時状態で、再起動時は解除状態から始まる。

### Dispatch と hold

operator-agent は ADR 0014 の source batching / 到着順 / one-shot continuation の考え方を独立した純関数へ移植する。TTY user input が最優先で、Open Question report は session status report より先に選ぶ。同じ source の到着済みイベントを番号付き section に整形し、1 束を 1 `agent.send` にする。

report hold は未 dispatch の自動 report に適用する。既に開始した `agent.send` は cancel しない。解除時は held report を到着順で通常 queue に戻す。user 発話と明示 outbound `operator.message` は report hold を通らない。

`operator.message` は稼働中 harness の通常 queue に入れ、#525 の既定 `next` を使う。受付 ack は queue への追加だけを示し、conductor dispatch 完了を示さない。Open Question 回答 API と別経路にし、一般 operator message が暗黙に質問回答として記録されないようにする。`idle` / `interrupt` は #525 の定義が source of truth であり、本 ADR では実装しない。

## Consequences

- operator 層が複数 Issue session の polling / batching / hold を担い、Issue harness はセッション単位の UDS と既存 event queue を保つ。
- polling は event stream より遅延があり、live UDS に接続できない間の報告は保存 snapshot の時点に限られる。
- session-state と Open Question report 本文は operator-agent の private watch state に含まれる。一般的な secret redaction はしない。
- UDS の送信後に outcome が unknown の場合、operator-agent は同じ message を自動再送しない。
