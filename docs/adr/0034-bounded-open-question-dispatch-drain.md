# ADR 0034: 稼働中 Open Question の bounded dispatch drain

- Status: superseded by [0035](0035-open-question-shutdown-commit-order.md)
- Date: 2026-10-20
- Related: [ADR 0033](0033-live-open-question-control-uds.md), [Issue #481](https://github.com/otolab/agents-ensemble/issues/481)

## Context

UDS answer request は Registry の回答を記録すると同時に `operator.message` を queue に入れ、その後 handler が YAML / sidecar を flush して conductor send の完了 receipt を待つ。通常の成功応答は保存と send 完了の両方を待つため、保存済み回答の dispatch 結果を成功と取り違えない。

終了処理では server が受理済み request を drain してから driver を abort していた。dispatch receipt が settle しないと request は server drain を、shutdown は server drain を待ち、driver に send を中断させる abort が発行されない循環待ちになる。UDS client の timeout は client socket のみを閉じ、harness handler や conductor send を停止しない。

## Decision

- Registry 更新・queue acceptance、永続化、conductor dispatch completion を別の段階として扱う。通常の success response は回答の保存と conductor send completion を確認した後に限る。
- shutdown は listener を閉じた後、受理済み UDS request の drain を最大 5 秒待つ。期限を超えた場合は driver を abort し、セッション teardown を進める。
- 保存済み回答の dispatch receipt が shutdown 時点で未確定なら、answer request は JSON-RPC error `-32005` を返し、error data に `{ "outcome": "unknown", "answerStatus": "recorded", "dispatchStatus": "unknown" }` を含める。client は回答を自動再送しない。保存済み Registry / YAML / sidecar の回答済み状態を保ち、同じ質問を再適用しない。
- shutdown signal が立った後に in-flight send が transport error を返しても、conductor の reconnect / prompt retry は開始しない。
- error message にも回答が記録済みであること、dispatch が未確認であること、再送しないことを示す。

## Consequences

- conductor send が停止しても、終了処理と UDS answer request は無期限に drain を待たない。
- shutdown deadline に達した場合、回答は保存済みでも conductor が受信・処理したかは確定できない。client は成功と扱わず、回答を再送せずに保存状態を確認する。
- 通常経路の回答 ack は dispatch completion を維持する。bounded shutdown timeout は graceful completion の上限として動作する。
