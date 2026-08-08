# ADR 0007: 許可パイプライン（3段 + 逆順伝播）

- Status: accepted
- Date: 2026-08-08
- Related: Issue #20

## Context

worker の `session/request_permission` を `PermissionBroker` が同期処理し、policy `ask` 時は `createPermissionAskHandler` 経由で **人間に直接** yes/no を聞いていた。conductor LLM は判断に介在せず、設計上の「制御の正本は conductor」と矛盾する。

求められるモデル:

1. **段1（自明）**: policy で即 allow/deny → worker へ返す（conductor 不要）
2. **段2（conductor）**: 非自明は pending として conductor が `resolve_permission` で allow/deny
3. **段3（human）**: conductor が `ask_human` で人間に確認（汎用エスカレーション）
4. **逆順伝播**: human → conductor（veto 可）→ worker。各段で approve / reject 可能

## Decision

- `PermissionPipeline` を導入する。policy が `ask` のときは **pending に積み、ACP へは即応答しない**（worker は待機）。
- conductor の custom tools: 既存 `ask_human` + 新規 `resolve_permission`。
- issue-session のデフォルトから `createPermissionAskHandler` を permission 経路で使わない。人間への出口は **conductor の `ask_human` のみ**。
- conductor prompt に pending permission 一覧を載せ、issue ループは pending 解消まで継続する。

## Consequences

- 良い: 許可判断が conductor 経由に統一。human veto を conductor が表現できる
- 悪い: pending 中 worker はブロック。conductor ターンが増える
- フォロー: 実 agent acp + conductor LLM による end-to-end は別途 integration で検証
- **段3はプロトコル** — `ask_human` なしで `resolve_permission` だけ呼ぶこともできる（コードでは強制しない）
- **セッション終了時** — 未解決 pending は `deny` で worker へ伝播してハングを防ぐ
