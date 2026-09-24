# ADR 0023: TTY 初回メッセージの post-loop ライフサイクル

- Status: accepted
- Date: 2026-09-24
- Related: Issue #336, [ADR 0013](0013-process-lifecycle-vs-autonomous-loop.md)

## Context

[ADR 0013](0013-process-lifecycle-vs-autonomous-loop.md) は、自律ループの停止とプロセス終了を分離し、TTY の `waitForOperatorExit` で `/exit` までセッションを維持する方針を定めた。その後、CLI 初回メッセージと `ENSEMBLE_OPERATOR_MESSAGE` の binding 直後注入が、入力経路の有無に関わらず one-shot として配線され、TTY の post-loop 待機まで無効にしていた。

TTY では初回メッセージを注入した後も Ink TUI と operator input binding が利用可能である。Issue #336 で、初回メッセージの存在は TTY セッションを one-shot に変える理由ではなく、`--no-wait` なしの TTY デフォルトは `/exit` まで維持することを確認した。

## Decision

- 初回メッセージの binding 直後に `operator.message` を 1 回 dispatch する動作は維持する。
- post-loop の有無は初回メッセージの有無ではなく、実際の TTY と `postLoopWait` で決める。TTY かつ待機が有効な場合は `waitForOperatorExit: true` とし、通常の TTY と同じく conductor error の継続および未回答 input の待機を許可する。
- `--no-wait`（または設定で post-loop 待機を無効にした場合）は TTY でも `waitForOperatorExit` を渡さず、自律ループ停止後に終了する。
- 非 TTY の CLI 初回メッセージ / `ENSEMBLE_OPERATOR_MESSAGE` は、追加入力を提供しない one-shot として従来どおり扱う。`continueOnConductorError: false` と `stopOnUnansweredInput: true` を使い、post-loop 待機へ移らない。

これは ADR 0013 の process lifecycle と SessionDriver の post-loop 契約を変更せず、初回メッセージを TTY と非 TTY で分類する部分だけを明確化するものである。

## Consequences

- メッセージ付き TTY 起動でも `session.post_loop_wait` が通知され、`/exit` まで worker / conductor / binding が維持される。
- CI / 非TTY の自動化は one-shot の即時終了契約を維持する。
- `--no-wait` は TTY の初回メッセージ付き起動にも適用され、明示的な即時終了手段として残る。
- #334 の permission race / teardown 停止ゲートはこの判断の対象外である。

## Related

- [ADR 0013](0013-process-lifecycle-vs-autonomous-loop.md) — process lifecycle と自律ループ停止の分離
- [operator-input.md](../operator-input.md) — 利用者向けの入力・post-loop 契約
- Issue #336
