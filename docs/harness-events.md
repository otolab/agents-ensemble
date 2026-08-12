# harness イベント一覧

`ensemble issue` セッション中に harness が発生させるイベントの整理。観測の役割分担の背景は [session-logging.md](session-logging.md) を参照。

関連 Issue: [#74](https://github.com/otolab/agents-ensemble/issues/74)

---

## 1. 3 つの出力経路

| 経路 | 型 / 形式 | 読者 | 用途 |
|------|-----------|------|------|
| **SessionLogEvent** | `SessionLogger.emit()` | 開発者・運用者（stderr `[harness]`） | 内部状態の時系列テレメトリ |
| **SessionEvent** | `SessionEventQueue.enqueue()` | conductor（`agent.send` の user メッセージ） | 判断・次アクションのトリガー |
| **SessionSummary** | 終了時 JSON（stdout） | e2e / CI / スクリプト | 1 回の実行結果の exit report |

これらは **別チャネル**。混ぜない（会話 UI に harness を出さない等の原則は session-logging.md §1）。

---

## 2. SessionLogEvent 一覧

実装の正本: `packages/core/src/conductor/session/session-logger.ts`  
stderr 整形: `packages/cli/src/session-sinks.ts`（`createHarnessSink`）

### 2.1 既存イベント

| type | 発火タイミング | stderr 例 | snapshot への影響 |
|------|----------------|-----------|-------------------|
| `harness.worktree` | worktree resolve 直後（セッション開始、worker あり） | `[harness] worktree path=... branch=... mode=...` | なし |
| `harness.worktree.removed` | post-loop `/exit` 後、isolated worktree 削除成功 | `[harness] worktree.removed path=... branch=...` | なし |
| `harness.worktree.remove_skipped` | 未コミット変更あり等で削除拒否 | `[harness] worktree.remove_skipped path=... branch=... reason=dirty` | なし |
| `harness.worktree.remove_failed` | `git worktree remove` 失敗（best-effort） | `[harness] worktree.remove_failed path=... branch=... error=...` | なし |
| `operator.input` | オペレータ発話をキューに載せる直前 | `[harness] operator.input turn=N bytes=...` | なし |
| `conductor.send` | 各 `agent.send` 完了後 | `[harness] conductor.send n=N status=... workerDone=... workerFailed=...` | `sendCount`, `lastRunStatus`, `lastResult`, `lastError` |
| `worker.round` | worker の 1 `session/prompt` ラウンド完了（bootstrap 含む） | `[harness] worker.round name=... kind=... roundKind=... stopReason=... path=...` | `workerDispatches` に追記 |
| `worker.failed` | worker attach / prompt 失敗 | `[harness] worker.failed name=... kind=... error=...` | `workerFailures` に追記 |
| `permission.pending` | permission が pending 登録直後（`decidePermission`） | `[harness] permission.pending worker=... tool=... cmd=... id=...` | なし |
| `session.stop` | セッション終了直前 | `[harness] session.stop reason=...` | `stopReason` を確定 |

### 2.4 セッション観測イベント（#92 で追加）

open question・エスカレーション・CLI 通知。stderr の prefix は従来どおり（TUI 導入前の観測互換）。

| type | 発火タイミング | stderr 例 | snapshot への影響 |
|------|----------------|-----------|-------------------|
| `open.question.enqueued` | open question 登録（`ask_human` / max-turns） | `[open question] inq-N [yes_no] ...` | なし |
| `escalation.recorded` | open question 回答のエスカレーション記録 | `[operator answer] ... → ...` | なし |
| `session.worktree.notice` | `--worktree in-repo` 開始時 | `[worktree] 特別モード: ...` | なし |
| `session.continue` | `--continue` で sidecar から再開時 | `[continue] resuming session: conductorAgentId=...` | なし |
| `session.post_loop_wait` | 自律ループ完了後の post-loop 待機開始 | （post-loop 待機メッセージ） | なし |

CLI 整形: `createObservationSink()`（`packages/cli/src/session-sinks.ts`）。

### 2.2 bootstrap 専用イベント（#74 で追加）

harness が **conductor の指示なしに** 行う worker attach + 待機 prompt のライフサイクル。

| type | 発火タイミング | stderr 例 | snapshot への影響 |
|------|----------------|-----------|-------------------|
| `harness.worker.bootstrap.started` | attach 開始直前（`WorkerRuntime.bootstrap`） | `[harness] worker.bootstrap.started name=... kind=...` | なし |
| `harness.worker.bootstrap.completed` | bootstrap ラウンドの ACP prompt 完了直後 | `[harness] worker.bootstrap.completed name=... kind=... stopReason=...` | なし |
| `harness.worker.bootstrap.failed` | attach または bootstrap prompt 失敗 | `[harness] worker.bootstrap.failed name=... kind=... error=...` | なし |

### 2.3 bootstrap 時の `worker.round` との関係（方針）

**両方出す。**

| 観点 | 方針 |
|------|------|
| **bootstrap 専用イベント** | 開始・完了・失敗を **harness テレメトリだけで即座に区別** できるようにする（オペレータの stderr 向け） |
| **`worker.round`** | bootstrap ラウンドも **従来どおり 1 ラウンドとして記録** する。終了 JSON の `workerDispatches` / `workerResponses` 整合を維持 |
| **区別用メタデータ** | `worker.round` の `dispatch.roundKind`（`bootstrap` \| `instruction`）でラウンド種別を示す |
| **`worker.failed`** | bootstrap 失敗時も従来どおり発火。**加えて** `harness.worker.bootstrap.failed` を出し、失敗が bootstrap 段階であることを明示 |

instruction ラウンド（`prompt_worker` / `sendWorkerMessage`）では bootstrap 専用イベントは出さない。`worker.round` の `roundKind` は `instruction`。

---

## 3. SessionEvent 一覧（conductor 向け）

実装の正本: `packages/core/src/conductor/session/session-event.ts`  
フォーマット: `packages/core/src/conductor/session/format-session-event.ts`

| type | 発火タイミング | conductor への見出し（例） | 備考 |
|------|----------------|---------------------------|------|
| `operator.message` | オペレータが `submit` / TTY 入力 | （プレーンテキスト） | max-turns ゲートの対象 |
| `worker.completed` | worker 1 ラウンド完了 | `## worker bootstrap 完了` または `## worker 作業ラウンド完了` | `result.roundKind` で見出しを分岐 |
| `worker.failed` | worker 失敗 | `## worker 失敗` | attach / bootstrap / instruction いずれも |
| `permission.pending` | permission が保留 | `## permission 判断待ち` | `resolve_permission` 待ち |

### 3.1 SessionLogEvent との対応

```
セッション開始
  harness.worktree ─────────────────────────► stderr のみ

WorkerSession.bootstrap()（worker ごと）
  harness.worker.bootstrap.started ─────────► stderr
       │
       ├─ attach + buildWorkerAttachPrompt + session/prompt
       │
       ├─ 成功 ─► harness.worker.bootstrap.completed ─► stderr
       │          worker.round (roundKind=bootstrap) ──► stderr + snapshot
       │          worker.completed (roundKind=bootstrap) ► SessionEventQueue ► agent.send
       │
       └─ 失敗 ─► harness.worker.bootstrap.failed ────► stderr
                  worker.failed ───────────────────────► stderr + snapshot + SessionEventQueue

prompt_worker / sendWorkerMessage
       │
       ├─ permission 保留 ─► permission.pending ───────► stderr / TUI 活動ログ（即時）
       │                     SessionEvent permission.pending ► SessionEventQueue ► agent.send
       │
       ├─ 成功 ─► worker.round (roundKind=instruction) ─► stderr + snapshot
       │          worker.completed (roundKind=instruction) ► SessionEventQueue ► agent.send
       │
       └─ 失敗 ─► worker.failed ───────────────────────► stderr + snapshot + SessionEventQueue

各 agent.send 完了
  conductor.send ───────────────────────────► stderr + snapshot（末尾更新）

セッション終了
  session.stop ─────────────────────────────► stderr + snapshot
```

**重要**: `worker.completed` は bootstrap でも instruction でも **同じイベント型**。conductor は `roundKind` と見出しで「自分が指示していない自動処理」かどうかを判別する。

---

## 4. 読者別の整理

### 4.1 オペレータ（TTY / stderr）

| 見えるもの | 見えないもの |
|------------|--------------|
| `operator>` / `conductor>`（stdout、DisplaySink → string backend） | worker 応答全文（会話 UI に混ぜない） |
| `[harness]` テレメトリ（stderr） | SessionEvent の YAML 本文（conductor 向け） |
| `[open question]` 等（ObservationSink、stderr） | |

bootstrap 把握の目安:

1. `worker.bootstrap.started` → harness が attach を開始した
2. `worker.bootstrap.completed` → 待機 prompt まで終わった（**まだ実作業ではない**）
3. `worker.round ... roundKind=bootstrap` → 終了 JSON にも載るラウンド記録

### 4.2 conductor（SessionEvent → agent.send）

| イベント | 意味 | 取るべき行動 |
|----------|------|--------------|
| `## worker bootstrap 完了` | harness による attach + 待機 prompt の完了 | **作業開始ではない**。`prompt_worker` で指示するまで待ってよい |
| `## worker 作業ラウンド完了` | 自分が `prompt_worker` した 1 ラウンドの終了 | Issue / PR を読んで進捗判断。タスク完了の意味ではない |
| `## worker 失敗` | attach / prompt 失敗 | 再試行・エスカレーションを検討 |
| `## permission 判断待ち` | worker の操作許可が保留（**bootstrap ラウンド中もありうる**） | `resolve_permission` またはオペレータへ。**bootstrap 完了を待たない**（[ADR 0016](adr/0016-bootstrap-permission-conductor-wait.md)） |

conductor は `list_workers` の `bootstrapInFlight` 等を **ポーリング・`Await` で待ってはならない**。状態変化は本表の SessionEvent のみが通知する。

メトリクス（オペレータへの状態説明用。終了 JSON / `conductor.send` から参照）:

| 名前 | 意味 |
|------|------|
| `sendCount` | 完了した `agent.send` 回数（conductor ターン数） |
| `workerDispatches` | 完了した worker ラウンド数（bootstrap 含む） |
| `workerFailures` | worker 失敗回数 |
| `autonomousTurns` / `maxTurns` | 自律ループのターン制限（session-policy。詳細は architecture.md） |

### 4.3 exit JSON（SessionSummary）

| フィールド | harness イベントとの関係 |
|------------|-------------------------|
| `sendCount` | `conductor.send` の最終値 |
| `workerDispatches` / CLI の `workerResponses` | 各 `worker.round` の要約（`roundKind` 含む） |
| `workerFailures` | 各 `worker.failed` |
| `stopReason` | `session.stop` |

bootstrap 専用イベントは **exit JSON には載せない**（時系列テレメトリのみ）。ラウンド自体は `workerDispatches` に残る。

---

## 5. injectable sink（#92）

`createHarnessSink` / `createDialogueSink` / `createObservationSink` は書き込み先を注入可能（デフォルトは `console.error` / `process.stdout.write`）。

対話 stdout は `createSessionDisplaySink` → reducer → `SessionDisplayBackend` 経由（#93）。interactive かつ非 TTY 時の string backend は内部で `createDialogueSink` を呼ぶ。TTY では Ink TUI（#94、`packages/cli/src/tui/`）が同じ reducer / backend 契約で 4 ペイン表示し、stdout への逐次直書きを置き換える。

| prefix | SessionLogEvent | 備考 |
|--------|-----------------|------|
| `[open question]` | `open.question.enqueued` | |
| `[operator answer]` | `escalation.recorded` | |
| `[worktree]` | `session.worktree.notice` | |
| `[continue]` | `session.continue` | |
| （post-loop メッセージ） | `session.post_loop_wait` | |

---

## 6. 将来拡張（#70 連携）

worker 状態照会 tool（#70）は本 Issue の非スコープ。ただし bootstrap 状態は次の値で表現可能にしておく:

| 状態 | 根拠 |
|------|------|
| `bootstrapping` | `harness.worker.bootstrap.started` 後、対応する `completed` / `failed` 前 |
| `ready` | bootstrap 完了後、prompt 中でない（`WorkerRuntime` の idle） |
| `failed` | 直近の bootstrap が `harness.worker.bootstrap.failed` |

#70 実装時は `WorkerRuntime` / `WorkerSession` の内部状態を tool 返却に載せる想定。

---

## 7. 関連コード

| パス | 内容 |
|------|------|
| `packages/core/src/conductor/session/session-logger.ts` | `SessionLogEvent`, `SessionLogger` |
| `packages/core/src/conductor/session/session-event.ts` | `SessionEvent` |
| `packages/core/src/conductor/session/format-session-event.ts` | conductor 向け見出し |
| `packages/core/src/conductor/conductor-session.ts` | emit / enqueue 配線 |
| `packages/core/src/runtime/worker-runtime.ts` | bootstrap ライフサイクル |
| `packages/cli/src/session-sinks.ts` | HarnessSink / DialogueSink / ObservationSink |
| `packages/cli/src/display/` | 表示 state・DisplaySink・string backend |
| `docs/session-logging.md` | 観測の役割分担 |
| `docs/adr/0012-conductor-worker-prompt-roundtrip.md` | bootstrap の設計意図 |
