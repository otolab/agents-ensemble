# ADR 0058: Pi send recovery の再送境界

- Status: superseded by [0059](0059-pi-recovery-report-after-manual-reconnect.md)
- Date: 2026-11-10
- Related: [Issue #650](https://github.com/otolab/agents-ensemble/issues/650), [PR #651](https://github.com/otolab/agents-ensemble/pull/651), [ADR 0017](0017-conductor-send-lifecycle-events.md), [ADR 0030](0030-tty-close-lifecycle.md)

## Context

Pi は同じ `send` の中でも model request ごとに API key を解決する。そのため `API key auth failed ... Failed to resolve API key ...` は、該当 request の前に起きても、先行 round で tool が実行された後に返る場合がある。同じ prompt を再送すると worker dispatch などの副作用が重なる可能性がある。

手動 `/reconnect` 後に再送可能と判断した batch は `SessionDriver` と `SessionEventQueue` のメモリ上に保持する。SessionResumeStore は agent / worker の再開情報を保存するが、event queue や処理中 batch は保存しない。[ADR 0017](0017-conductor-send-lifecycle-events.md) と [ADR 0030](0030-tty-close-lifecycle.md) も in-flight send と Driver state の cross-process resume を定めていない。

選択肢は次のとおり。

1. auth / transport error のたびに同じ prompt を再送し、失敗 batch も process 再開後に replay する。副作用の重複と queue 消費境界の曖昧さが残る。
2. tool 開始を観測していない場合に限り in-process retry し、手動 recovery batch は同一 process 内だけに保持する。process 終了後は operator が状態を確認して新しい指示を出す。
3. recovery batch を SessionResumeStore へ永続化する。event の schema / stable identity、send 完了との atomic な commit 境界、再生済み副作用の dedupe が必要になり、既存 resume の範囲を広げる。

## Decision

- auth / transport error 後は同じ agent ID で `resume` する。send 中に tool 開始通知が一度でもあれば、同じ prompt は再送せず元の error を返す。tool が始まっていなければ同じ prompt の再試行を 1 回だけ許す。
- `ensemble issue` の手動 `/reconnect` は、Pi の API key resolver failure で終わり、初回 send と自動 retry のどちらでも tool が始まっていない batch だけを再キューする。同一 `SessionEvent` の手動再キューは driver process 中 1 回までとする。transport error など結果が曖昧な batch は再送しない。
- `SessionEventQueue` と pending recovery batch は永続化しない。`/close` または Ctrl+C をまたいで process を再開しても、失敗 batch を自動 replay しない。再開後は利用可能な conductor / worker の状態を確認し、未完了分だけを新しい operator message で伝える。
- `ensemble operator-agent` の手動 `/reconnect` は agent の close / resume のみとし、失敗 prompt を再送しない。

## Consequences

- tool を開始した可能性のある prompt の自動重複実行を避けられる。一方、部分的に完了した処理の続きを operator が状態確認のうえ新しい message として指示する必要がある。
- process 終了時には失敗 batch と未 dispatch queue が失われる。通常の resume 情報が保存されていても、batch の自動再開は保証しない。
- durable replay が必要になった場合は、event identity、永続化 commit 順序、重複実行を抑える契約を含めて別途設計する。
