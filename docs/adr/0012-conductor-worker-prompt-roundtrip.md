# ADR 0012: conductor – worker メッセージング（常駐 ACP / sendWorkerMessage）

- Status: accepted
- Date: 2026-08-10
- Related: Issue #36, [ADR 0002](0002-star-topology-sdk-conductor-acp-worker.md), [ADR 0009](0009-conductor-session-event-queue.md), [ADR 0011](0011-session-sidecar-resume.md)

## Context

### ユースケース（標準動作モード）

1. conductor と worker（implementer / reviewer 等）が **セッション開始時に起動**する
2. conductor が Issue / Skill 等を確認し、**判断**する
3. conductor が worker に **作業開始を指示**する
4. worker が指示と Issue / Skill をもとに **作業**する
5. 一段落したら **Issue に報告**し、同時に harness へ **ACP ラウンド完了**を返す
6. conductor が進捗を確認し、worker に **追加の作業指示**を送る
7. worker が追加作業 → 完了報告（5 と同型）
8. conductor が Issue に完了メッセージ等を書き、**オペレータの回答待ち**に入る

複数 worker が **非同期・並行**で上記を **数往復**する。

### 用語（`dispatch` ではない）

| 避ける語 | 採用する語 | 意味 |
|----------|-----------|------|
| dispatch（常駐 worker 文脈） | **attach** / **startWorker** | ensemble 開始時に `agent acp` を起動し session を確立 |
| dispatch（指示） | **sendWorkerMessage** | 既存 worker session へ user メッセージ（ACP `session/prompt`）を送る |
| — | **roundCompleted** | 1 回の `session/prompt` が終了（`worker.completed` イベント） |

conductor 側の SDK ツール名はプロンプト都合で **`prompt_worker`** のままにしてよい。harness 内部 API は **`sendWorkerMessage`** とする。

CLI の `ensemble dispatch worker`（one-shot）は **`runOneShotWorker`** 相当として **常駐モデルとは別経路**のまま残す。

### 現状ギャップ（#36）

| 問題 | 詳細 |
|------|------|
| **プロセス非常駐** | bootstrap の 1 `session/prompt` 終了後、`bridge.close()` で **`agent acp` 子プロセスが kill される**。ensemble 存続中に worker 実体がいない |
| **再送経路なし** | `acpSessionId` は sidecar にあるが、2 回目の `session/prompt` を送る harness API がない |
| **用語のずれ** | `dispatch` は one-shot 起動のイメージ。ユースケースは **sendMessage**（会話への user ターン追加）に近い |

### 検討した選択肢

| 案 | 概要 | 不採用理由 |
|----|------|------------|
| A. Issue 更新をトリガー | webhook / ポーリング | Issue は正本でありトリガーではない |
| B. prompt ごとに connect → close（論理常駐） | `session/load` のみ再利用 | 待機中に worker プロセスが存在しない。team.md の「常駐」と不一致 |
| **C. プロセス常駐 + sendWorkerMessage（採用）** | ensemble 中 `agent acp` を維持。`session/prompt` で往復 | ユースケース・ACP モデルと整合 |
| D. bootstrap 1 本で走り切り | 現状 | 数往復できない |

## Decision

### 通信を二層に分ける

| 層 | 用途 | 実装 |
|----|------|------|
| **同期（harness）** | 動かす・許可する・ラウンド終了を知る | ACP `session/prompt`, `session/request_permission`, inbox / outbound キュー |
| **非同期（Issue / PR）** | 作業内容・進捗・論点の正本 | worker / conductor が GitHub ツールで読み書き。harness は仲介しない |

**Issue に書いただけでは worker は動かない。** トリガーは harness 同期経路（`sendWorkerMessage`）のみ。

### harness の二つのキュー（1 対多）

conductor は **1、worker は多**。harness は inbound / outbound で対称にキューを持つ。

```
                    ┌── SessionEventQueue（inbound・既存）
worker / operator ──┤   permission.pending, worker.completed, operator.message
                    │         → agent.send
                    │
conductor tool ─────┤── WorkerOutboundQueue（新設）
  prompt_worker     │   sendWorkerMessage { name, text }
                    │         → per-worker 配送
                    └──► implementer / reviewer / …
```

| キュー | 方向 | 役割 |
|--------|------|------|
| **SessionEventQueue** | → conductor | [ADR 0009](0009-conductor-session-event-queue.md) どおり。1 イベント = 1 `agent.send` |
| **WorkerOutboundQueue** | conductor → workers | tool 呼び出しを worker 名でルーティング。per-worker に直列化 |

### worker プロセス常駐

| 項目 | 方針 |
|------|------|
| **寿命** | ensemble 開始（`WorkerSession.bootstrap`）〜終了（`WorkerSession.stop`）まで **`agent acp` プロセスを維持** |
| **接続** | worker ごとに `AcpBridge` を `WorkerSession` が保持。bootstrap 後も **close しない** |
| **session** | worker 名 → `{ bridge, acpSessionId, worktree, state }` のレジストリ |
| **終了** | `ConductorSession` の shutdown / SIGINT 時に全 bridge を close |
| **resume** | harness 再起動時は [ADR 0011](0011-session-sidecar-resume.md): 新プロセスで `session/load` してから常駐を再開 |

### sendWorkerMessage（conductor → worker）

1. conductor LLM が SDK custom tool **`prompt_worker`** を呼ぶ（引数: `worker`, `instruction`）
2. harness が **WorkerOutboundQueue** に積み、対象 worker へ配送
3. 対象 worker が **idle** なら、保持中の bridge へ **`session/prompt`**（= user メッセージ 1 ターン）
4. tool は **非ブロック**で返す（受付成功 / エラー）。**完了は `worker.completed` イベント**（[ADR 0009](0009-conductor-session-event-queue.md)）

`prompt_worker` の tool 結果は SDK 会話に載る。**セッションイベント列には積まない**。

### per-worker 状態と busy 時の扱い

ACP v1 では **1 session あたり同時に走れる prompt ターンは 1 本**（[Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)）。途中に user メッセージを挿入する API はない。

| worker 状態 | 意味 |
|-------------|------|
| **idle** | prompt ターンなし。次の `sendWorkerMessage` を受け付け可能 |
| **prompting** | `session/prompt` 応答待ち（LLM / tool 実行中） |

**初版（本 ADR の基本実装）**: `prompting` 中の同一 worker への送信は **per-worker キューに積む**。ラウンド完了後に FIFO で次を `session/prompt` する。

| 方針 | 挙動 | フェーズ |
|------|------|----------|
| **キュー（採用・初版）** | busy → enqueue → round 完了後に配送 | Phase 1–2 |
| **拒否** | busy → tool エラー | テスト簡略用に併用可 |
| **割り込み（preempt）** | `session/cancel` → `stopReason: cancelled` 確認 → 新 prompt | Phase 5（`prompt_worker` の `preempt: true`） |

**worker 間**（implementer / reviewer）は session が別なので **並行**に `session/prompt` 可能。

### 割り込みと ACP `session/cancel`

割り込みは **会話への追記ではなく、進行中ターンの中止**。

- Client が `session/cancel` notification を送る
- Agent は LLM / tool を止め、進行中の `session/prompt` を `stopReason: cancelled` で返す
- その後、新しい `session/prompt` を送れる

harness は **`prompt_worker` の `preempt: true`** で `session/cancel` を送り、キャンセル確認後に新 prompt を実行する。未指定時は busy 時キュー。

### worker → conductor（変更なし）

| 意味 | 経路 |
|------|------|
| 操作許可 | ACP permission → inbox → `resolve_permission` or 即決 |
| **ラウンド完了** | ACP prompt 終了 → `worker.completed` → SessionEventQueue → `agent.send` |
| **作業報告** | Issue / PR（harness 外） |

`worker.completed` = **1 ラウンド終了**。タスク完了の意味ではない。conductor は Issue を読んで進捗判断する。

### bootstrap の役割

| 項目 | 現状 | 本 ADR 後 |
|------|------|-----------|
| 目的 | one-shot 作業開始に近い | **attach + 待機 prompt**（役割・permission・team.md） |
| プロセス | prompt 後に kill | **ensemble 終了まで生存** |
| 実作業の開始 | bootstrap prompt 内 | conductor の **`sendWorkerMessage`** |

## Consequences

### 良い点

- team.md の「常駐 worker」がプロセスレベルで成立する
- conductor `agent.send` と worker `session/prompt` が対称な「メッセージ送信」モデルになる
- inbound キュー（0009）と outbound キューで 1 対多が明示される
- ACP の prompt ターン制約（1 session 1 本）を per-worker キューで自然に満たせる

### 悪い点・リスク

- `WorkerSession` / `WorkerRuntime` の責務が増える（接続プール・キュー・状態機械）
- プロセス常駐はリソース消費・クラッシュ復旧が必要（再 attach / load）
- `session/cancel` 未実装の間は「優先割り込み」はキュー待ちのみ — **Phase 5 で解消**
- 用語・ディレクトリ（`dispatch/`）の整理は別 PR でもよい

### フォロー

- [architecture.md](../architecture.md) §5
- modular-prompt の `FIXME(#36)` は Phase 3 で削除済み
- `session/cancel`（preempt）— Phase 5 実装済み。prompt 失敗時の再 attach — 必要になったら本 ADR 追記 or 別 ADR
- Phase 4（Issue 本文注入）— [#37](https://github.com/otolab/agents-ensemble/issues/37)

## 実装フェーズ

| Phase | 内容 | 受け入れ |
|-------|------|----------|
| **0** | **worker プロセス常駐**: attach 時に bridge 保持、ensemble 終了まで close しない | bootstrap 後も `agent acp` が生存（fake / integration） |
| **1** | **sendWorkerMessage** + per-worker レジストリ + **per-worker キュー** + idle/prompting 状態 | 同一 session で 2 回 `session/prompt`、busy 時はキュー |
| **2** | **`prompt_worker` tool** + WorkerOutboundQueue + `ConductorSession` 配線 | tool → 2 回目 prompt 受信 |
| **3** | bootstrap を待機中心に変更、プロンプト `FIXME` 削除 | ensemble / profile テスト |
| **4**（任意） | 初回 conductor send へ Issue 本文注入 | [#37](https://github.com/otolab/agents-ensemble/issues/37) |
| **5** | `session/cancel` + preempt ポリシー | 進行中ターンの中止 → 新指示 |

Phase 0–2 が #36 の基本通信機構。Phase 3 はプロンプト整合。Phase 5 は割り込み。
