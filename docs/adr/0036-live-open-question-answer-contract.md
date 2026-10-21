# ADR 0036: 稼働中 Open Question の回答応答条件

- Status: accepted
- Date: 2026-10-20
- Related: [ADR 0033](0033-live-open-question-control-uds.md)（回答の保存・応答条件を置き換え）, [ADR 0035](0035-open-question-shutdown-commit-order.md), [Issue #481](https://github.com/otolab/agents-ensemble/issues/481)

## Context

ADR 0033 は、`open_questions.answer` の success response を YAML と JSON sidecar の両方の flush 後に返すと定めた。その後 ADR 0035 は YAML を回答永続化の commit point、JSON sidecar を mirror とする順序を採ったが、sidecar flush を success の条件から外す変更履歴が ADR 0033 側に示されていなかった。

sidecar の書き込み失敗は、YAML に保存され conductor dispatch receipt も確認できた回答を失敗扱いにする理由にはならない。一方、YAML 保存後に conductor dispatch の完了を確認できない回答を success と返すこともできない。wire response の条件を明確にする。

## Decision

- この ADR は ADR 0033 のうち、回答の永続化と response acknowledgement の条件だけを置き換える。UDS 所有者、transport、API shape、アクセス制御、ログ方針、および自動解決を初期対象外とする判断は ADR 0033 のまま有効である。
- `open_questions.answer` は、Open Questions YAML の atomic save が成功し、かつ conductor の dispatch receipt が成功した場合に JSON-RPC success を返す。JSON sidecar の flush 成功は success の条件にしない。sidecar の更新失敗は warning と後続 flush で扱い、YAML に保存された回答と dispatch を取り消さない。
- YAML 保存前の失敗は汎用 JSON-RPC error `-32603` とし、live Registry の回答更新および `operator.message` の enqueue を行わない。
- YAML 保存後に conductor dispatch を確認できない場合は、JSON-RPC error `-32005` と `{ "outcome": "unknown", "answerStatus": "recorded", "dispatchStatus": "unknown" }` を返す。回答を再送せず、保存状態を確認する。
- ADR 0035 の shutdown drain、retry 抑止、および結果不明の取り扱いは、この応答条件と併せて適用する。

## Consequences

- YAML が回答状態の永続化正本となり、sidecar の一時的な遅れや書き込み失敗が回答の成否を変えない。
- success は回答の永続化と conductor dispatch receipt の両方を確認した場合に限る。receipt が未確定の保存済み回答は成功と取り違えず `unknown` として扱う。
- ADR 0033 の回答応答条件はこの範囲で置き換わる。ADR 0033 の残る transport・API・security 判断は引き続き有効である。
