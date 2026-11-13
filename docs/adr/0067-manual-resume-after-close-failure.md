# ADR 0067: close failure 後の明示 reconnect

- Status: accepted
- Date: 2026-11-13
- Related: [Issue #668](https://github.com/otolab/agents-ensemble/issues/668), [PR #677](https://github.com/otolab/agents-ensemble/pull/677), [ADR 0065](0065-conductor-dispatch-lifecycle-and-recovery-boundary.md)

## Context

共通 lifecycle は agent の `close()` と `factory.resume(sameId)` を順に実行する。Pi backend は `close()` 中の abort、MCP reload、dispose の失敗を返しつつ、後続 cleanup を試す。close Promise は reconnect と teardown で共有され、一度 reject すると同じ agent instance に対する後続 reconnect もその reject を受け取り、`resume()` に進めない。

close を単純に再実行しても cleanup が進む保証はなく、backend によっては idempotent でない可能性がある。一方、失敗した send の結果は不明なため、古い agent に戻したり、失敗 input を再送したりすることもできない。

## Decision

- 各 agent instance の close は一度だけ試み、完了・失敗の Promise を reconnect と teardown で共有する。reject 後も close は再実行しない。
- 自動 reconnect は close が reject した時点で失敗とする。agent は unavailable のまま保ち、通常 dispatch を行わない。
- operator が明示的に `/reconnect` した場合は、settled な close が reject 済みでも同じ `agentId` の `factory.resume()` を試す。これは手動で agent を置き換える判断であり、close の再試行ではない。
- `resume()` が成功するまで新しい agent を handle に設定せず、旧 handle への send を再開しない。`resume()` が失敗した場合は unavailable のままにし、次の手動 reconnect で `resume()` を再試行する。
- close が reject した状態で手動 resume を試みた事実を operator に通知する。resume 成功後も未確定 send の confirmation gate を維持する。失敗 input の replay は行わず、状態確認後に operator が新しい input で続行する。

## Consequences

- cleanup failure で手動 reconnect が恒久的に塞がることを防ぎ、失敗 input の再送も避けられる。
- close failure 後に古い backend resource の解放が完了したとは保証できない。手動 resume が成功しても、その可能性を warning で知らせる。
- automatic reconnect は close failure で止まり、operator の明示操作が必要になる。process 終了後の queue / inbox 復元や replay は引き続き保証しない。
