# ADR 0078: operator-agent の同一 session report 集約

- Status: accepted
- Date: 2026-11-16
- Supersedes in part: [ADR 0037](0037-operator-agent-session-watch-and-dispatch.md)（report source の粒度と同一 session の debounce / batching のみ）
- Related: [ADR 0038](0038-operator-agent-conversation-report-hold.md), [Issue #736](https://github.com/otolab/agents-ensemble/issues/736)

## Context

operator-agent は従来、Open Question、session status、conductor message を別々の dispatch source として扱っていた。各 poll / debounce window の間に複数種類の report が到着すると、内容を保ったままでも session ごとに一度で渡せず、同じ短いやり取りが複数の operator turn に分かれる。

watch は既定 2 秒 poll / 250ms debounce、conductor message listen は既定 2 秒 poll / 10 秒 debounce を持つ。短い watch debounce が先に満了すると、後から観測される conductor message と同一 session の report をまとめる機会がない。hold 解除時も種類ごとの source に分かれていれば小分け dispatch になる。

## Decision

- Open Question / session-state / conductor-message の自動 report は、`conductorAgentId` ごとに同一 dispatch source とする。各 report は個別の ID と内容を維持し、到着順に同じ `agent.send` の番号付き section へ入れる。似た文章だからという理由で異なる report を削除・統合しない。
- 同一 session の queued report は、その source にある全 report の debounce deadline が満了してからまとめて dispatch する。他 session の ready report は独立して dispatch できる。TTY user は最優先とし、Open Question を含む session は通常 report の session より先に選ぶ。
- `register_session_watch` の既定値 2000ms poll / 250ms `debounceMs` と conductor message listen の既定値 2000ms poll / 10000ms `messageDebounceMs` を保つ。message listen が有効な間、watch report の window は `max(debounceMs, messageDebounceMs)` とする。listener の登録時は同じ session の既存 watch report もその window に揃える。新しい conductor message が観測されるたび、同じ session の未 dispatch report の deadline を message quiet window の終わりへ延長する。
- conversation hold と manual hold の OR 契約、hold 解除時の到着順、`release_reports` が manual hold だけを解除する契約は維持する。再起動後の pending report は同じ ID で再 queue し、dispatch 成功と ack 保存の間で終了した場合の at-least-once 再送も維持する。

## Consequences

- 同一 session の質問回答・status 更新・conductor message を、一つの operator turn で時系列を保って確認できる。異なる session は混ざらず、cursor が同じ観測の再生成も抑止される。
- message listen 中は watch report も message debounce を待つ。既定では最大 10 秒程度の quiet window となり、message が続く間は deadline が延び続ける。利用者は `messageDebounceMs` を 0〜120000ms で調整し、通知の速さと turn 集約のどちらを重くするか選べる。watch の `debounceMs` は 0〜10000ms で個別に調整できる。
- 複数の本当の状態変化が同じ session で続けば、その分の report text と turn input は残る。集約は report 数を隠すものではなく、operator turn を減らす変更である。
- ack 前の process 終了による重複配送は残る。安定した report ID を手掛かりに、新しい変化と再配送を区別する必要がある。
