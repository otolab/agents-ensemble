# ADR 0035: Open Question の shutdown retry 抑止と永続化 commit 順序

- Status: accepted
- Date: 2026-10-20
- Related: [ADR 0033](0033-live-open-question-control-uds.md), [ADR 0034](0034-bounded-open-question-dispatch-drain.md), [ADR 0036](0036-live-open-question-answer-contract.md), [Issue #481](https://github.com/otolab/agents-ensemble/issues/481)

## Context

ADR 0034 の bounded drain は、終了要求後も受理済み UDS answer request を最大 5 秒待ってから conductor driver を abort する。driver abort 前の grace period 中に transport error が返ると、abort signal はまだ立っておらず、同じ `operator.message` を reconnect / retry する余地があった。

また、従来の answer 経路は Registry 更新と event queue enqueue の後に YAML を flush していた。YAML 保存が失敗しても conductor 通知が先行し、client に部分適用を区別できる response がなかった。

## Decision

- shutdown intent と bounded drain 用 driver abort を分ける。`/close`、`/exit`、shutdown signal を受けた時点で retry suppression signal を直ちに abort し、受理済み request の drain は既存の最大 5 秒猶予で続ける。shutdown intent 後に transport error が返っても reconnect / 同一 prompt の retry を行わない。
- UDS answer は clone 上で既存 `submitOperatorInput` / `recordOpenQuestionAnswer` の回答 semantics を適用し、候補 snapshot を作る。Open Questions YAML の atomic save が成功した後に限り、live Registry を更新して `operator.message` を event queue へ enqueue する。YAML save が失敗した場合は live Registry と queue を変更せず、client には汎用 JSON-RPC error `-32603` を返す。
- YAML 保存成功を回答永続化の commit point とする。JSON sidecar は mirror として続けて更新する。sidecar 更新だけが失敗した場合は warning を出して後続 flush を試み、すでに YAML に保存された回答と conductor dispatch を取り消さない。resume の正本は引き続き YAML とする。
- teardown で確定した `closed` / `exited` / `interrupted` / `unknown` lifecycle を terminal value として保持する。遅れて settle した send が sidecar flush を予約しても、その value を消さない。
- YAML commit 後の conductor dispatch が shutdown で確認できない場合は ADR 0034 の契約を保つ。JSON-RPC error `-32005` に `{ "outcome": "unknown", "answerStatus": "recorded", "dispatchStatus": "unknown" }` を付け、client は回答を再送しない。

## Consequences

- shutdown grace period 中の transport error は同じ operator message の二重 dispatch を起こさない。dispatch 結果が確認できない回答は success と扱わず `unknown` で settle する。
- YAML save failure は conductor notification より前に返るため、client は回答が適用されていない汎用 error を受け取る。保存前の in-memory answer や queue entry は残らない。
- YAML は回答状態の durable source of truth であり、sidecar の失敗は warning と後続 flush で回復する。sidecar は YAML と複数ファイル transaction ではない。
- late send completion は terminal lifecycle を上書きしないため、operator-agent が保存済み session status を誤認しない。
