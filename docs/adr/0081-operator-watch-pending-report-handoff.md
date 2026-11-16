# ADR 0081: operator-agent の pending report を稼働中 peer へ引き渡す

- Status: accepted
- Date: 2026-11-16
- Related: [ADR 0037](0037-operator-agent-session-watch-and-dispatch.md), [ADR 0078](0078-operator-agent-session-report-coalescing.md), [ADR 0080](0080-operator-watch-state-lock-transaction.md), [Issue #736](https://github.com/otolab/agents-ensemble/issues/736)

## Context

ADR 0080 の profile lock は、poll が cursor と pending report を保存する更新を直列化する。しかし永続 state と process-local dispatch queue は別の場所にある。process A が cursor と pending report を保存した直後、queue への追加前に終了すると、すでに動いている process B は次の poll で進んだ cursor と pending report を読み直す。B は同じ変化を再生成しない一方、起動時に限っていた pending の queue 復元も再実行しないため、report は B が再起動するまで送られない。

## Decision

- profile の watch state を source of truth とし、各 state refresh で検証済み pending report と process-local queue を照合する。watch/message poll に加え、2 秒間隔の pending refresh を行い、新しい observation を待たずに peer の保存済み report を queue へ取り込む。
- pending report に `readyAt` を保存し、他 process が回収するときも元の debounce deadline を使う。既存 v1 state に `readyAt` がなければ、従来の restart replay と同じく即時 ready とする。hold は通常どおり queue 側で適用する。
- queue は report ID で pending / held / in-flight report を識別する。繰り返し refresh しても同じ ID を重ねて enqueue せず、dispatch / ack error の retry は ID と内容を保ち5秒後に再試行する。refresh は retry deadline を短縮しない。disk から消えた未 dispatch report は queue から除く。ack は pending state の削除と queue の ID 解放を行い、複数 process から同じ ack が来ても結果を壊さない。
- process ごとの queue と conductor send は共有しない。複数 process が同じ report を同時に dispatch する可能性は残り、delivery は at-least-once とする。成功済み send の直後、ack の永続化前に process が終了した場合の再送も許容し、exactly-once は保証しない。

## Consequences

- lock 競合がない場合、稼働中 peer は最大 2 秒後の refresh、またはそれより早い poll 起点の state refresh で pending report を回収する。lock 取得に失敗した refresh は最大40回・25ms間隔の retry 後に error となり、次の2秒周期で再試行する。lock が継続して取得できない場合に有限の配送期限は設けない。
- 同一 session の report ID と保存順、Issue URL、debounce deadline を保つ。manual hold / conversation hold 中は回収後も queue 内で保留される。
- peer の ack 後、まだ queue にある duplicate は次回 refresh で除かれる。すでに始まった別 process の send は取り消せないため、重複 dispatch は起こりうる。
- watch state の SQLite lock は ADR 0080 のまま profile 単位で直列化する。dispatch queue の重複抑止は各 process 内で有効であり、process 間の send claim / exactly-once coordinator は導入しない。
