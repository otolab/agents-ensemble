# ADR 0038: operator-agent の会話中に watch report を保留する

- Status: accepted
- Date: 2026-10-21
- Related: [ADR 0037](0037-operator-agent-session-watch-and-dispatch.md), [Issue #527](https://github.com/otolab/agents-ensemble/issues/527)

## Context

[ADR 0037](0037-operator-agent-session-watch-and-dispatch.md) は、手動の report hold と user 入力の優先 dispatch を定めた。watch pool を使う対話では、watch report が短い user / operator の会話に割り込む場合がある。一方、会話中も watch を止めると、その間の変化を見落とす。

「会話の区切り」は無入力時間や専用ツールでも判定できるが、初期実装では複雑さを抑え、operator の応答ターン完了を区切りにする。

## Decision

- 空でない通常の TTY user input を受け付けた時点で、自動 conversation hold を有効にする。watch pool の購読・polling は続け、得た report は operator-agent queue に保留する。
- operator の `agent.send` が `finished` / `completed` で返り、次の user input が queue に残っていないとき、自動 hold を解除する。次の入力が待っていれば解除せず、連続する user turn の応答が完了して queue が空になるまで維持する。
- 手動 report hold と conversation hold は独立した状態とし、どちらか一方でも有効なら自動 report を hold する。解除は両方が無効になったときだけ行い、保留 report を既存の到着順 / batching 規則で dispatch queue に戻す。
- `/resume-watch` は自動 conversation hold だけを解除する。手動 hold は維持し、次の通常 user input では conversation hold を再度有効にする。
- 既に開始した `agent.send` は取り消さない。`cancelled`、`error`、その他の未完了 status では自動 conversation hold を解除しない。

## Consequences

- operator の応答生成中に到着した report は会話へ割り込まず、解除後はまとめ報告の対象になる。監視 polling は継続する。
- TTY は hold の理由（会話 / 手動）と保留件数を示す。会話 hold は session state へ永続化せず、operator-agent の再起動後は解除状態から始める。
- send が完了しない場合、report dispatch は手動 `/resume-watch` まで保留される。自動判定の時間閾値や明示的な会話終了 tool は本判断に含めない。
