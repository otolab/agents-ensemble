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

### 1.1 イベント分類ルール（どの union に足すか）

| 追加する概念 | 載せる union | 判断基準 |
|-------------|-------------|---------|
| conductor が `agent.send` すべき判断材料 | **`SessionEvent`** | `format-session-event.ts` で YAML 化され、`SessionEventQueue` に載る |
| 時系列テレメトリ・TUI・snapshot 更新 | **`SessionLogEvent`** | `SessionLogger.emit()` 経由。stderr / reducer / exit JSON の元データ |
| 両方必要 | **両方**（type 名が異なる場合あり） | 発火箇所でペア emit。共有 payload は `events/shared/` を参照 |
| exit JSON フィールドのみ | どちらでもない | 例: `worker.round` が `workerDispatches` に集約される |

**意図的な別名（変更しない）**

| 概念 | SessionLogEvent | SessionEvent |
|------|-----------------|--------------|
| worker ラウンド完了 | `worker.round`（field: `dispatch`） | `worker.completed`（field: `result`） |
| オペレータ発話 | `operator.input` | `operator.message` |
| GitHub 更新 | `harness.github.update`（件数のみ） | `github.update`（items 全文） |

実装の型グループ定数: `packages/core/src/conductor/session/events/session-log-event-groups.ts`（`ALL_SESSION_LOG_EVENT_TYPES` / `SESSION_EVENT_TYPES`）。

---

## 2. SessionLogEvent 一覧

実装の正本: `packages/core/src/conductor/session/events/session-log-event.ts`（`SessionLogger` は `session-logger.ts`）  
stderr 整形: `packages/cli/src/session-sinks.ts`（`createHarnessSink`）

### 2.1 既存イベント

| type | 発火タイミング | stderr 例 | snapshot への影響 |
|------|----------------|-----------|-------------------|
| `harness.worktree` | worktree resolve 直後（セッション開始、worker あり） | `[harness] worktree path=... branch=... mode=...` | なし |
| `harness.worktree.removed` | post-loop `/exit` 後、isolated worktree 削除成功 | `[harness] worktree.removed path=... branch=...` | なし |
| `harness.worktree.remove_skipped` | 未コミット変更あり等で削除拒否 | `[harness] worktree.remove_skipped path=... branch=... reason=dirty` | なし |
| `harness.worktree.remove_failed` | `git worktree remove` 失敗（best-effort） | `[harness] worktree.remove_failed path=... branch=... error=...` | なし |
| `operator.input` | オペレータ発話をキューに載せる直前 | `[harness] operator.input turn=N bytes=...` | なし |
| `conductor.send.started` | 各 `agent.send` 開始直前 | `[harness] conductor.send.started n=N source=...` | なし（TUI Workers ペインで `conductor: thinking`） |
| `conductor.send.progress` | conductor ターン中の SDK ツール開始 | **なし**（log 相当。活動ログ / stderr には出さない [#161](https://github.com/otolab/agents-ensemble/issues/161)） | なし（TUI: 活動ヒントのみ。例: `conductor: reading`） |
| `conductor.send` | 各 `agent.send` 完了後 | `[harness] conductor.send n=N status=... workerDone=... workerFailed=...` | `sendCount`, `lastRunStatus`, `lastResult`, `lastError`（TUI Workers ペインで `conductor: idle`） |
| `worker.round` | worker の 1 `session/prompt` ラウンド完了（init prompt 含む） | `[harness] worker.round name=... kind=... source=... stopReason=... path=...` | `workerDispatches` に追記 |
| `worker.failed` | worker attach / prompt 失敗 | `[harness] worker.failed name=... kind=... error=...` | `workerFailures` に追記 |
| `permission.pending` | permission が pending 登録直後（`decidePermission`） | `[harness] permission.pending worker=... tool=... cmd=... id=...` | なし |
| `harness.warning` | [#125](https://github.com/otolab/agents-ensemble/issues/125) デッドロック検知（worker 活動中 + pending permission が閾値継続） | `[harness] warning: init prompt / prompt 実行中の permission が未解消のまま 30s 以上継続...` | なし |
| `worker.process.stderr` | worker 子プロセス（`agent acp`）の stderr 1 行 | `[harness] worker.stderr name=...` | なし（詳細は [session-logging.md](session-logging.md)） |
| `conductor.auth.reconnect` | conductor `resume(sameId)` 試行時 | `[auth] reconnect agentId=...` | なし |
| `conductor.auth.recovery` | 自動再接続失敗後の復旧ヒント | `[auth] ...`（PR #99 互換） | なし（詳細は [conductor-auth-reconnect.md](conductor-auth-reconnect.md)） |
| `session.stop` | セッション終了直前 | `[harness] session.stop reason=...` | `stopReason` を確定 |
| `harness.teardown` | `runConductorSession` の `finally` 完了時（[#170](https://github.com/otolab/agents-ensemble/issues/170)） | force 時または 1s 超のみ `[harness] teardown force=... total=...ms ...` | なし |
| `harness.teardown.phase` | teardown 各段階の開始時（[#209](https://github.com/otolab/agents-ensemble/issues/209)） | `[harness] teardown.phase <name>` | なし |

### 2.4 セッション観測イベント（#92 で追加）

open question・エスカレーション・CLI 通知。stderr の prefix は従来どおり（TUI 導入前の観測互換）。

| type | 発火タイミング | stderr 例 | snapshot への影響 |
|------|----------------|-----------|-------------------|
| `open.question.enqueued` | open question 登録（`ask_human` / max-turns） | `[open question] inq-N [yes_no] ...` | なし |
| `escalation.recorded` | open question 回答のエスカレーション記録 | `[operator answer] ... → ...` | なし |
| `session.worktree.notice` | `--worktree in-repo` 開始時 | `[worktree] 特別モード: ...` | なし |
| `session.continue` | `--continue` で sidecar から再開時 | `[continue] resuming session: conductorAgentId=...` | なし |
| `session.post_loop_wait` | 自律ループ完了後の post-loop 待機開始 | （post-loop 待機メッセージ） | なし |
| `session.operator_exit` | オペレータが `/exit` / `exit` を入力した直後（[#170](https://github.com/otolab/agents-ensemble/issues/170)） | （終了フィードバックメッセージ） | なし |

CLI 整形: `createObservationSink()`（`packages/cli/src/session-sinks.ts`）。

### 2.5 GitHub 監視イベント（#39 で追加）

| type | 発火タイミング | stderr 例 | snapshot への影響 |
|------|----------------|-----------|-------------------|
| `harness.github.update` | debounce 後に `github.update` をキューへ載せる直前 | `[harness] github.update items=N` | なし |
| `harness.github.monitor_error` | GitHub API poll 失敗（best-effort。監視は継続。認証失敗時は `[github-auth]` ヒント付き） | `[harness] github.monitor_error ...` | なし |

監視: `packages/core/src/github/github-monitor.ts`。カーソルは sidecar `githubMonitor` に永続化（[ADR 0011](adr/0011-session-sidecar-resume.md)）。debounce（デフォルト 30s）は [ADR 0014](adr/0014-conductor-dispatch-batch-coalescing.md) の dispatch 束とは別レイヤ。

**運用制限（#39）**

| 項目 | 内容 |
|------|------|
| poll 間隔 | 通常 **60s**。いずれかの関連 PR で CI が pending（`QUEUED` / `IN_PROGRESS` 等）なら **15s** |
| debounce | デフォルト **30s**（`--github-monitor-debounce-ms`）。連続インラインコメント等を 1 通知にまとめる |
| 初回カーソル poll | **カーソル空の新規セッション**の初回 poll のみ（`initialCursorPoll`）。既存 Issue コメントは通知せずカーソルを進める。worker の init prompt（`startWorkers`）とは無関係 |
| `--continue` 再開 | sidecar カーソルありなら **初回 poll から差分通知**（オフライン中のコメント等を取りこぼさない） |
| PR 紐づけ | GitHub Search API（`type:pr repo:owner/repo <issueNumber>` 相当）。失敗時は PR 監視をスキップし **Issue コメント監視は継続** |
| CI wakeup | GraphQL `statusCheckRollup` の **CheckRun / StatusContext**（後者は `context` + `state` を正規化）。前回 poll で pending だった check が `COMPLETED` + `conclusion` になったときのみ通知 |
| CLI | `--no-github-monitor` で無効化。`--github-monitor-debounce-ms` で debounce 変更 |

### 2.2 worker prompt ライフサイクルイベント（#133 で統一）

init prompt（harness 起因）と instruction（conductor 起因）を **対称**に扱う。旧 `harness.worker.bootstrap.*` は廃止。

| type | 発火タイミング | stderr 例 | snapshot への影響 |
|------|----------------|-----------|-------------------|
| `harness.worker.prompt.started` | `session/prompt` ラウンド開始（init / instruction 共通） | `[harness] worker.prompt.started name=... kind=... source=harness\|conductor` | なし（TUI: running） |
| `harness.worker.prompt.completed` | ラウンド ACP prompt 完了直後 | `[harness] worker.prompt.completed name=... kind=... source=... stopReason=...` | なし（TUI: idle） |
| `harness.worker.prompt.failed` | attach 致命失敗、または `executeRound` 内の prompt 失敗 | `[harness] worker.prompt.failed name=... kind=... source=... error=...` | なし（TUI: 一時 `failed`。resident 維持時は直後の `harness.worker.state idle` で **idle** に戻る） |
| `harness.worker.acp.update` | `session/prompt` 中の ACP `session/update`（#148） | **なし**（log 相当。活動ログ / stderr には出さない [#161](https://github.com/otolab/agents-ensemble/issues/161)） | なし（TUI: 活動ヒントのみ。`running` 正本は `harness.worker.state`） |
| `harness.worker.state` | `WorkerRuntime` の harness 状態遷移（#147） | `[harness] worker.state name=... kind=... state=attaching\|processing\|idle\|failed` | なし（TUI: 下表） |
| `harness.session.workers` | セッション開始時、profile の worker 一覧確定直後 | `[harness] session.workers count=N names=...` | なし（TUI: 全員 idle で seed） |

**TUI `WorkerDisplayStatus` と harness 状態の対応（#147）**

| `list_workers` / `harness.worker.state` | TUI Workers ペイン |
|----------------------------------------|-------------------|
| `attaching` | `running` |
| `processing` | `running` |
| `idle` | `idle` |
| `failed` | `failed`（**attach 致命失敗のみ**。`failedWorkers` 登録・resident なし） |

`harness.worker.prompt.*` / `harness.worker.acp.update` も TUI を更新する。**Workers ペインの `running` / `idle` 正本は `harness.worker.state`**（および `prompt.started` / `prompt.completed`）。`harness.worker.acp.update` は **活動ヒント**（例: `running (calling: Shell)`）の更新にのみ使い、chunk 単位では stderr / 活動ログに出さない（#161）。

`permission.pending` は **Workers ペインを更新しない**（活動ログのみ）。permission 待ち中の worker は `harness.worker.state` / `prompt.*` が `processing` / `running` のまま維持される想定。

**失敗経路の分岐（#147）**

| 経路 | runtime / `list_workers` | 発火イベント（順） | TUI Workers 最終 |
|------|--------------------------|-------------------|------------------|
| **attach 致命失敗**（`attachAndInit` の catch。resident 未成立） | `failed`（`failedWorkers`） | `prompt.failed` → `state failed` → `worker.failed` | `failed` |
| **ラウンド失敗**（`executeRound` の catch。resident 維持） | `idle`（resident 存続） | `prompt.failed` → `worker.failed` → `finally` で `state idle` | `idle`（`state idle` が `prompt.failed` を上書き） |

init prompt（`source: harness`）では attach 開始時に `started` を出し、init ラウンド完了時に `completed` を出す。conductor 指示（`source: conductor`）では `executeRound` 開始時に `started`、完了時に `completed`。正常系は `harness.worker.state` で `attaching` → `processing` → `idle` を併記する。

### 2.3 `worker.round` との関係（方針）

**両方出す。**

| 観点 | 方針 |
|------|------|
| **prompt ライフサイクルイベント** | 開始・完了・失敗を **TUI / stderr テレメトリで即座に区別**（init / instruction 対称） |
| **`worker.round`** | すべてのラウンドを **従来どおり 1 ラウンドとして記録**。終了 JSON の `workerDispatches` / `workerResponses` 整合を維持。**TUI では** worker が `running` のときのみ `idle` へ遷移（`source: conductor` かつ未登録 worker は fallback で `idle` 登録） |
| **区別用メタデータ** | `worker.round` の `dispatch.source`（`harness` \| `conductor`）でラウンド起因を示す |
| **`worker.failed`** | 失敗時も従来どおり発火。**加えて** `harness.worker.prompt.failed` を出す |

`source: harness` のラウンド完了は **作業報告ではない**（conductor 向け `worker.completed` の見出しも instruction と同型）。

---

## 3. SessionEvent 一覧（conductor 向け）

実装の正本: `packages/core/src/conductor/session/events/session-event.ts`  
フォーマット: `packages/core/src/conductor/session/format-session-event.ts`

| type | 発火タイミング | conductor への見出し（例） | 備考 |
|------|----------------|---------------------------|------|
| `operator.message` | オペレータが `submit` / TTY 入力 | （プレーンテキスト） | max-turns ゲートの対象 |
| `worker.completed` | worker 1 ラウンド完了 | `## worker ラウンド完了` | `result.source` で harness / conductor を区別（見出しは同型） |
| `worker.failed` | worker 失敗 | `## worker 失敗` | attach / init prompt / instruction いずれも |
| `permission.pending` | permission が保留 | `## permission 判断待ち` | `resolve_permission` 待ち |
| `github.update` | GitHub Issue / 関連 PR の更新検知 | `## GitHub 更新` | **状況把握**（[ADR 0012](adr/0012-conductor-worker-prompt-roundtrip.md)）。**自動 `prompt_worker` はしない**。post-loop 待機中かつ `items` に `issue.comment` が含まれるときは `notifyResume` で SessionDriver を再開（`autonomousTurns < maxTurns` のときのみ。上限到達時は `enqueue` のみ）。`operator.message` との差: operator は無条件 resume、issue.comment はターン残あり時のみ |

### 3.1 SessionLogEvent との対応

```
セッション開始
  harness.worktree ─────────────────────────► stderr のみ
  harness.session.workers ──────────────────► stderr + TUI seed（全 worker idle）

WorkerSession.startWorkers()（worker ごと。attach + init prompt）
  harness.worker.prompt.started (source=harness) ───► stderr + TUI running
       │
       ├─ attach + buildWorkerAttachPrompt + session/prompt
       │    harness.worker.state processing ─► stderr + TUI running
       │
       ├─ 成功 ─► harness.worker.prompt.completed (source=harness) ► stderr + TUI idle
       │          harness.worker.state idle ────────────────► stderr + TUI idle
       │          worker.round (source=harness) ───────► stderr + snapshot（TUI: 変更なし）
       │          worker.completed (source=harness) ───► SessionEventQueue ► agent.send
       │
       ├─ attach 致命失敗 ─► harness.worker.prompt.failed ► stderr + TUI failed（一時）
       │                    harness.worker.state failed ──► stderr + TUI failed（最終）
       │                    worker.failed ────────────────► stderr + snapshot + SessionEventQueue
       │
       └─ init ラウンド失敗（resident 維持）─► harness.worker.prompt.failed ► stderr + TUI failed（一時）
                              worker.failed ────────────────► stderr + snapshot + SessionEventQueue
                              harness.worker.state idle ────► stderr + TUI idle（最終。list_workers と一致）

prompt_worker / sendWorkerMessage
       │
       ├─ harness.worker.prompt.started (source=conductor) ► stderr + TUI running
       ├─ harness.worker.state processing ───────────────► stderr + TUI running
       ├─ harness.worker.acp.update (session/prompt 中) ► TUI 活動ヒントのみ（stderr / 活動ログには出さない #161）
       ├─ permission 保留 ─► permission.pending ───────► stderr / TUI 活動ログ（即時。Workers 欄は更新しない）
       │                     SessionEvent permission.pending ► SessionEventQueue ► agent.send
       │
       ├─ 成功 ─► harness.worker.prompt.completed (source=conductor) ► stderr + TUI idle
       │          harness.worker.state idle ────────────────► stderr + TUI idle
       │          worker.round (source=conductor) ───────► stderr + snapshot（TUI: running 中のみ idle）
       │          worker.completed (source=conductor) ───► SessionEventQueue ► agent.send
       │
       └─ ラウンド失敗（resident 維持）─► harness.worker.prompt.failed ► stderr + TUI failed（一時）
                              worker.failed ────────────────► stderr + snapshot + SessionEventQueue
                              harness.worker.state idle ────► stderr + TUI idle（最終。list_workers と一致）

preempt（stopReason=cancelled）: `prompt.completed` / `worker.round` をスキップし、次ラウンドの `started` + `state processing` で running 維持

各 agent.send 開始
  conductor.send.started ───────────────────► stderr + TUI（conductor: thinking）

各 agent.send 進行中（ツール開始）
  conductor.send.progress ──────────────────► TUI 活動ヒントのみ（stderr / 活動ログには出さない #161）

各 agent.send 完了
  conductor.send ───────────────────────────► stderr + snapshot（末尾更新）+ TUI（conductor: idle）

GitHub monitor（セッション中は常時。`--no-github-monitor` で無効化可）
  harness.github.update ──────────────────────► stderr
  github.update ──────────────────────────────► SessionEventQueue ► agent.send
       │                                        （post-loop 待機中 + issue.comment + ターン残あり → notifyResume で Driver 再実行）

セッション終了
  session.stop ─────────────────────────────► stderr + snapshot
```

**重要**: `worker.completed` は init prompt でも instruction でも **同じイベント型・同じ見出し**。conductor は YAML 内の `source` で「自分が指示していない harness 起因の自動処理」かどうかを判別する。`source: harness` は作業開始ではない。

---

## 4. 読者別の整理

### 4.1 オペレータ（TTY / stderr）

| 見えるもの | 見えないもの |
|------------|--------------|
| `operator>` / `conductor>`（stdout、DisplaySink → string backend） | worker 応答全文（会話 UI に混ぜない） |
| `[harness]` テレメトリ（stderr） | SessionEvent の YAML 本文（conductor 向け） |
| `[open question]` 等（ObservationSink、stderr） | |

init prompt 把握の目安:

1. `worker.prompt.started source=harness` → harness が attach / init prompt を開始した
2. `worker.prompt.completed source=harness` → 待機 prompt まで終わった（**まだ実作業ではない**）
3. `worker.round ... source=harness` → 終了 JSON にも載るラウンド記録

### 4.2 conductor（SessionEvent → agent.send）

| イベント | 意味 | 取るべき行動 |
|----------|------|--------------|
| `## worker ラウンド完了` | worker の 1 `session/prompt` 終了 | `source: harness` なら **作業開始ではない**（init prompt 完了）。`source: conductor` なら自分が `prompt_worker` したラウンド。Issue / PR を読んで進捗判断 |
| `## worker 失敗` | attach / prompt 失敗 | 再試行・エスカレーションを検討 |
| `## permission 判断待ち` | worker の操作許可が保留（**init prompt ラウンド中もありうる**） | `resolve_permission` またはオペレータへ。**init prompt 完了を待たない**（[ADR 0016](adr/0016-bootstrap-permission-conductor-wait.md)） |
| `## GitHub 更新` | Issue コメント / PR レビュー / CI 完了等 | 状況把握。**自動 `prompt_worker` はしない**。post-loop 中の `issue.comment` は SessionDriver 再開トリガにもなる（ターン残あり時のみ） |

conductor は `list_workers` の `attachInFlight` / `state: processing` 等を **ポーリング・`Await` で待ってはならない**。状態変化は本表の SessionEvent のみが通知する。

メトリクス（オペレータへの状態説明用。終了 JSON / `conductor.send` から参照）:

| 名前 | 意味 |
|------|------|
| `sendCount` | 完了した `agent.send` 回数（conductor ターン数）。`started` / `progress` の `n=` は同じ通し番号だが snapshot 更新は **完了時のみ** |
| `workerDispatches` | 完了した worker ラウンド数（init prompt 含む） |
| `workerFailures` | worker 失敗回数 |
| `autonomousTurns` / `maxTurns` | 自律ループのターン制限（session-policy。詳細は architecture.md） |

### 4.3 exit JSON（SessionSummary）

| フィールド | harness イベントとの関係 |
|------------|-------------------------|
| `sendCount` | `conductor.send` の最終値（`started` / `progress` では増えない） |
| `workerDispatches` / CLI の `workerResponses` | 各 `worker.round` の要約（`source` 含む） |
| `workerFailures` | 各 `worker.failed` |
| `stopReason` | `session.stop` |
| `sessionUsage` | `SessionUsageTracker`（`get_session_usage` と同型。cost は `getUsage()` マージ） |

フィールドの型・出力先（TTY / JSON / ツール）・未取得時の扱いは [session-metrics.md](session-metrics.md) を正本とする。

prompt ライフサイクルイベントは **exit JSON には載せない**（時系列テレメトリのみ）。ラウンド自体は `workerDispatches` に残る。

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
| （終了フィードバック） | `session.operator_exit` | TTY では入力欄も無効化（`shuttingDown`） |

---

## 6. worker 状態と #125 デッドロック検知（#133 以降）

### 6.1 runtime 語彙（`list_workers` / `get_worker_status`）

正本型: `WorkerLifecycleState`（`packages/core/src/runtime/worker-lifecycle-state.ts`）。  
`WorkerHarnessState` は後方互換 alias（deprecated）。

| 状態 | 意味 |
|------|------|
| `attaching` | ACP attach 中（init prompt 前） |
| `processing` | `session/prompt` 実行中（init / instruction 共通） |
| `idle` | prompt 中でない。次の `sendWorkerMessage` を受け付け可能 |
| `failed` | attach または prompt 失敗 |

### 6.2 TUI 表示語彙（`WorkerDisplayStatus`）

正本型: `packages/core/src/runtime/worker-display-state.ts`（`idle` / `running` / `failed`）。

| WorkerLifecycleState（runtime / tool） | WorkerDisplayStatus（TUI / reducer） | 備考 |
|--------------------------------------|-------------------------------------|------|
| `attaching` | `running` | `mapHarnessToDisplayStatus` で明示変換（#146 PR2） |
| `processing` | `running` | prompt ライフサイクルイベントでも同様 |
| `idle` | `idle` | |
| `failed` | `failed` | |

変換関数: `mapHarnessToDisplayStatus`（`packages/core/src/runtime/map-worker-lifecycle.ts`）。  
TUI reducer はイベント駆動のため lifecycle を直接読まないが、worker 向け表示更新はこの関数経由の定数を使用する。

### 6.3 デッドロック検知とメトリクス

`list_workers` が返す harness 状態の実装: [worker-status-tool.ts](../../packages/core/src/dispatch/worker-status-tool.ts)

`attachInFlight` は attach フェーズのみのカウンタ。`runningCount` は `processing` ラウンド数 + `attachInFlight`。**いずれも「0 になるまで待て」というシグナルではない**（[ADR 0016](adr/0016-bootstrap-permission-conductor-wait.md)）。

[#125](https://github.com/otolab/agents-ensemble/issues/125) §1 デッドロック検知の置き換え条件（`bootstrapInFlight` 廃止後）:

| 旧（#125 起票時） | 新（#133 後） |
|-------------------|---------------|
| `bootstrapInFlight > 0` | `attachInFlight > 0` **または** いずれか worker の `state === 'processing'` |
| pending permission 継続 | 変更なし（`permission.pending`） |

検知の意図: harness 起因の init prompt または conductor 指示の prompt が permission で止まり、conductor がイベント駆動で解消しないまま N 秒経過した状態をテレメトリする。

| 項目 | 初期値 |
|------|--------|
| 停滞閾値 | **30s**（`permissionDeadlockStallMs`） |
| poll 間隔 | **5s**（`permissionDeadlockPollMs`） |
| 警告回数 | 同一停滞エピソードで **1 回**。pending 解消後に再発した場合のみ再警告 |

実装: `packages/core/src/permission/permission-deadlock-monitor.ts`。`runConductorSession` 起動時に自動開始（`disablePermissionDeadlockMonitor` で無効化可）。

## 7. 関連コード

| パス | 内容 |
|------|------|
| `packages/core/src/conductor/session/events/session-log-event.ts` | `SessionLogEvent` union |
| `packages/core/src/conductor/session/events/session-event.ts` | `SessionEvent` union |
| `packages/core/src/conductor/session/events/session-log-event-groups.ts` | 型グループ定数（doc 対応） |
| `packages/core/src/conductor/session/session-logger.ts` | `SessionLogger` |
| `packages/core/src/conductor/session/format-session-event.ts` | conductor 向け見出し |
| `packages/core/src/conductor/conductor-session.ts` | emit / enqueue 配線 |
| `packages/core/src/github/github-monitor.ts` | Issue / PR 更新監視 |
| `packages/core/src/github/fetch-github-updates.ts` | GitHub REST / GraphQL ベース差分取得 |
| `packages/core/src/github/github-client.ts` | fetch ベース GitHub API クライアント |
| `packages/core/src/runtime/worker-lifecycle-state.ts` | `WorkerLifecycleState`（runtime / tool 正本語彙） |
| `packages/core/src/runtime/worker-display-state.ts` | `WorkerDisplayStatus`（TUI 語彙） |
| `packages/core/src/runtime/map-worker-lifecycle.ts` | `mapHarnessToDisplayStatus` |
| `packages/core/src/runtime/worker-status.ts` | `WorkerStatusSummary` 等（`state` フィールド） |
| `packages/core/src/permission/permission-deadlock-monitor.ts` | #125 デッドロック検知 |
| `packages/cli/src/session-sinks.ts` | HarnessSink / DialogueSink / ObservationSink |
| `packages/cli/src/display/` | 表示 state・DisplaySink・string backend |
| `docs/session-logging.md` | 観測の役割分担 |
| `docs/adr/0012-conductor-worker-prompt-roundtrip.md` | attach / init prompt の設計意図 |
