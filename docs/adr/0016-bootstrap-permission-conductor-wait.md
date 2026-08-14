# ADR 0016: bootstrap 中 permission と conductor 自律待機のデッドロック

- Status: accepted
- Date: 2026-08-12
- Related: Issue #39, [#125](https://github.com/otolab/agents-ensemble/issues/125), [ADR 0010](0010-permission-pending-event-delivery.md), [ADR 0012](0012-conductor-worker-prompt-roundtrip.md), [ADR 0014](0014-conductor-dispatch-batch-coalescing.md), [#86](https://github.com/otolab/agents-ensemble/issues/86)

## Context

### インシデント（Issue #39 dogfooding）

セッション `agent-0f1398a3-da62-47ec-9536-f9032d874154`（`ensemble issue #39 --continue`）で、TUI が `permission.pending`（reviewer×2, implementer×1）を表示したまま進行しなくなった。

調査の要点:

| 観測 | 内容 |
|------|------|
| sidecar | `workers` に reviewer のみ。implementer は bootstrap 未完了（sidecar 未登録） |
| harness テレメトリ | `permission.pending` は即時表示・`SessionEventQueue` に enqueue 済み |
| conductor トランスクリプト | `list_workers` で `bootstrapInFlight > 0` を確認後、**外部 MCP ツール `Await`** で `bootstrapInFlight: 0` を最大 5 分待機 |
| 結果 | implementer は bootstrap ラウンド中の permission で停止。conductor は permission を解消せず bootstrap 完了を待ち続け、**相互待ちでデッドロック** |

### harness の想定モデル

[ADR 0010](0010-permission-pending-event-delivery.md) / [ADR 0014](0014-conductor-dispatch-batch-coalescing.md) では、conductor への入力は **イベント駆動**である。

```
worker permission 保留
  → permission.pending を SessionEventQueue に enqueue
  → 次の dispatch 束（operator 次点で permission 優先）
  → agent.send
  → conductor が resolve_permission
  → worker 再開
```

bootstrap ラウンド（attach + 待機 prompt）でも `session/prompt` は通常ラウンドと同様に permission を発生しうる（[ADR 0012](0012-conductor-worker-prompt-roundtrip.md) Phase 3）。**bootstrap 完了を待ってから permission を見る順序は想定していない。**

[team.md](../../profiles/implementer-and-reviewer/team.md) も「bootstrap 完了は着手ではない」「permission は判定できるなら判定」と書く。状態の変化待ちは harness のイベント列に委ねる。

### `Await` は harness 機能ではない

トランスクリプトの `Await` は agents-ensemble の API ではなく、**conductor 実行環境（Cursor agent）に付与された外部 MCP ツール**。ターミナル出力等をポーリングし、正規表現パターンが現れるまでブロックする。

conductor が `list_workers` の `bootstrapInFlight`（[worker-status-tool.ts](../../packages/core/src/dispatch/worker-status-tool.ts)）を見て `Await(pattern: "bootstrapInFlight: 0")` を選んだのは **LLM の自律判断**であり、harness が指示した待機ではない。

### なぜデッドロックになるか

`SessionDriver` は **1 本の in-flight `agent.send` が終わるまで次の dispatch を開始しない**（[conductor-session-driver.ts](../../packages/core/src/conductor/conductor-session-driver.ts)）。

```
conductor ターン開始
  → list_workers（bootstrapInFlight: 1）
  → Await（最大 5 分ブロック）     ← このターンが終わらない
  → resolve_permission を呼べない

並行に harness は permission.pending をキューに積むが、
次の agent.send は in-flight 完了まで開始されない
```

implementer の bootstrap は permission 応答待ち → `bootstrapInFlight` は 0 にならない → `Await` は満たされない、という循環が成立する。

### 検討した選択肢

| 案 | 概要 | 採否 |
|----|------|------|
| A. harness にブロッキング待機ツールを追加 | `wait_for_workers` 等 | **不採用** — イベント駆動と二重化し、同型デッドロックを温存する |
| B. bootstrap 中は permission を禁止 | worker 側で抑止 | **不採用** — attach prompt でもツール実行は必要。根本解決にならない |
| C. **conductor 行動規約 + prompt 明文化（採用）** | permission 優先・ポーリング待機禁止・ターンを短く返す | 採用 |
| D. in-flight send の割り込み | permission / operator で `run.cancel()` | **別 Issue**（[#86](https://github.com/otolab/agents-ensemble/issues/86)）。本 ADR の補強だが単独では conductor の誤った `Await` 選択は防げない |
| E. デッドロック検知テレメトリ | bootstrapInFlight>0 かつ pending permission が N 秒継続 | フォロー（任意） |

## Decision

### 1. conductor の待機モデルはイベント駆動のみ

conductor は harness 状態（bootstrap 完了、worker idle、ラウンド完了）を **自分でポーリング・ブロッキング待機してはならない**。

| やること | やらないこと |
|----------|--------------|
| `permission.pending` / `worker.completed` 等の **SessionEvent** を受けて行動する | `Await` や Shell ループで `bootstrapInFlight` / `state: idle` を待つ |
| 状態確認は `list_workers` の **スナップショット**として読む | スナップショットを「変化するまで」待つ |
| 判断・`resolve_permission`・`prompt_worker` の後は **ターンを終えて** harness に戻る | 1 ターン内で長時間ブロックする |

harness は **待機用 custom tool を追加しない**。変化通知は既存の `SessionEventQueue` のみが担う。

### 2. permission は bootstrap より優先

`permission.pending` が届いたら、**bootstrap 未完了・`bootstrapInFlight > 0` であっても** 先に処理する。

1. pending の内容を読む（スコープ内なら `resolve_permission`、要確認なら `ask_human`）
2. ターンを終える
3. worker / bootstrap の再開は harness が次イベントで通知する

[ADR 0014](0014-conductor-dispatch-batch-coalescing.md) の dispatch 優先度（operator > permission > worker continuation）は維持する。本 ADR が追加するのは **conductor 側の行動順序**（イベントを無視して lifecycle を待たない）。

### 3. `list_workers` の位置づけ（再確認）

`list_workers` / `get_worker_status` は **オペレータ向け状態説明・即時スナップショット**用（[ADR 0012](0012-conductor-worker-prompt-roundtrip.md) 以降の運用、[Issue #70](https://github.com/otolab/agents-ensemble/issues/70)）。**イベントの代替ではない。**

`bootstrapInFlight` は「いま attach ラウンドが何本走っているか」のカウンタであり、「0 になるまで待て」というシグナルではない。

### 4. in-flight send 割り込みは別途

[#86](https://github.com/otolab/agents-ensemble/issues/86)（進行中 `agent.send` の cancel）は、オペレータ割り込みと permission 緊急度の **補強**として引き続き追う。本 ADR の採用は #86 完了を待たない。prompt 遵守で大半のデッドロックは回避できるが、LLM が長時間ツールを握った場合の保険として #86 は有効。

### 5. プロンプトへの反映（フォロー）

| 対象 | 追記方針 |
|------|----------|
| `profiles/implementer-and-reviewer/conductor.prompt.yaml` | permission 優先・ポーリング待機禁止・`list_workers` はスナップショットのみ |
| `profiles/implementer-and-reviewer/team.md` §3 permission | bootstrap 中でも permission 判定は止めない |
| `docs/harness-events.md` §4.2 | conductor の禁止事項として明記 |

## Consequences

### 良い点

- イベント駆動モデル（ADR 0009 / 0010 / 0014）と矛盾しない方針を文書化できる
- インシデントの原因（外部 `Await` + in-flight send）を harness バグと LLM 行動に切り分けられる
- bootstrap 中 permission を正式にサポートする運用が明確になる

### 悪い点・リスク

- **prompt だけでは LLM 逸脱を完全には防げない**（今回も `Await` を自律選択した）
- in-flight send が長いと、permission イベントはキューに溜まるだけ（#86 未実装）
- デッドロック検知が無いと、同種の停止はオペレータが TUI で気づく必要がある

### フォロー

- [x] `conductor.md` / `team.md` / `harness-events.md` 更新
- [ ] [#125](https://github.com/otolab/agents-ensemble/issues/125) — デッドロック検知テレメトリ + ACP `toolCall` permission パース
- [ ] #86 — in-flight `agent.send` 割り込み

## 参照

- Issue #39（dogfooding）
- セッション sidecar: `.ensemble/sessions/agent-0f1398a3-da62-47ec-9536-f9032d874154.json`
- [harness-events.md](../harness-events.md) — bootstrap / permission のイベント流れ
