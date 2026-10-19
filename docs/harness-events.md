# harness イベント一覧

> **正本:** harness の SessionLogEvent / SessionEvent の型・発火条件・読者別の意味。出力チャネルの説明は [session-logging.md](session-logging.md)、TUI の利用者向け挙動は [operator-input.md](operator-input.md) を参照します。

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
stderr 整形: core の SessionLogEvent representation（`packages/core/src/representation/`）を CLI の `createHarnessSink` が利用

### 2.1 既存イベント

| type | 発火タイミング | stderr 例 | snapshot への影響 |
|------|----------------|-----------|-------------------|
| `harness.worktree` | worktree resolve 直後（セッション開始、worker あり） | verbose 時のみ `[harness] worktree path=... branch=... mode=...` | なし |
| `harness.worktree.removed` | post-loop `/exit` 後、isolated worktree 削除成功 | verbose 時のみ `[harness] worktree.removed path=... branch=...` | なし |
| `harness.worktree.remove_skipped` | post-loop `/exit` の isolated worktree cleanup で未コミット変更あり等により削除拒否 | `[harness] worktree.remove_skipped path=... branch=... reason=dirty` に加え、利用者向け `[worktree] ⚠️` warning（TTY 活動ログ / 非 TTY stderr） | なし |
| `harness.worktree.remove_failed` | post-loop `/exit` の isolated worktree cleanup で `git worktree remove` の限定リトライ後も失敗 | `[harness] worktree.remove_failed path=... branch=... error=...` に加え、利用者向け `[worktree] ⚠️` warning（TTY 活動ログ / 非 TTY stderr） | なし |
| `operator.input` | オペレータ発話をキューに載せる直前 | verbose 時のみ `[harness] operator.input turn=N bytes=...` | なし |
| `conductor.inbound` | harness が `agent.send` へ渡す trigger 束を確定した直前 | `[harness] conductor.deliver triggers=N sources=...` | なし |
| `conductor.send.started` | 各 `agent.send` 開始直前 | verbose 時のみ `[harness] conductor.send.started n=N source=...` | なし（TUI Workers ペインで `conductor: thinking`） |
| `conductor.send.progress` | conductor ターン中の SDK ツール開始 | **なし**（log 相当。活動ログ / stderr には出さない [#161](https://github.com/otolab/agents-ensemble/issues/161)） | なし（TUI: 活動ヒントのみ。例: `conductor: reading`） |
| `conductor.send` | 各 `agent.send` 完了後 | 成功は verbose 時のみ `[harness] conductor.send n=N status=finished ...`。失敗は既定でも障害種別・復旧ヒント付き | `sendCount`, `lastRunStatus`, `lastResult`, `lastError`（TUI Workers ペインで `conductor: idle`） |
| `conductor.outbound` | conductor の 1 send 中に `prompt_worker` で送った worker を send 完了時に集約 | `[harness] worker.prompt workers=N mode=conductor names=...` | なし |
| `worker.round` | worker の 1 `session/prompt` ラウンド完了（init prompt 含む） | verbose 時のみ `[harness] worker.round name=... kind=... source=... stopReason=... path=...` | `workerDispatches` に追記 |
| `worker.failed` | worker attach / prompt 失敗。該当 worker の pending permission は conductor への通知前に deny | `[harness] worker.failed name=... kind=... error=...` | `workerFailures` に追記 |
| `permission.pending` | permission が pending 登録直後（`decidePermission`） | `[harness] permission.pending worker=... tool=... cmd=... id=...` | なし |
| `permission.cleanup` | worker failure / teardown で pending permission を deny・解消した直後 | `[harness] permission.cleanup reason=worker.failed worker=... count=... ids=...` | なし |
| `harness.warning` | [#125](https://github.com/otolab/agents-ensemble/issues/125) デッドロック検知（worker 活動中 + pending permission が閾値継続）。GitHub 認証トークン未解決時（#222） | `[harness] warning: ...`（permission デッドロック / GitHub 認証不足） | なし。permission デッドロック時は同じ検知で conductor 向け `permission.stall` も 1 回 enqueue |
| `worker.process.stderr` | worker 子プロセス（`agent acp`）の stderr 1 行 | `[harness] worker.stderr name=...` | なし（詳細は [session-logging.md](session-logging.md)） |
| `conductor.auth.reconnect` | conductor `resume(sameId)` 試行時 | `[auth] reconnect agentId=...` | なし |
| `conductor.auth.recovery` | 自動再接続失敗後の復旧ヒント | `[auth] ...`（PR #99 互換） | なし（詳細は [conductor-auth-reconnect.md](conductor-auth-reconnect.md)） |
| `conductor.transport.reconnect` | transport 自動再接続、または `/reconnect` の `resume(sameId)` | `[harness] conductor.transport.reconnect status=attempt\|succeeded\|failed agentId=...` / `[transport] ...` | なし（失敗時も auth hint は出さない） |
| `session.stop` | セッション終了直前 | 異常終了時は既定でも `[harness] session.stop reason=...`。正常完了は verbose 時のみ | `stopReason` を確定 |
| `harness.teardown` | `runConductorSession` の worker/ACP・conductor 停止後、isolated worktree 削除前（[#170](https://github.com/otolab/agents-ensemble/issues/170)） | force 時または 1s 超のみ `[harness] teardown force=... total=...ms ...` | なし |
| `harness.teardown.phase` | teardown 各段階の開始時（[#209](https://github.com/otolab/agents-ensemble/issues/209)） | verbose 時のみ `[harness] teardown.phase <name>` | なし |
| `conductor.dispatch_hold` | conductor が `set_dispatch_hold` を呼んだとき、または held trigger（`permission.pending` / `permission.stall` を含む）の件数が変化したとき | `dispatch hold enabled` / `released (flushed N events)`（observation） | TUI の保留状態と件数を更新。解除後も未送信の held trigger があれば残数を表示 |

### 2.1.1 オペレータ向け representation

`SessionLogEvent` は構造化されたテレメトリの正本であり、stderr と TUI 活動ログの
人間向け 1 行は core の `renderSessionLogEvent()`（実装:
`packages/core/src/representation/session-log-representation.ts`）で共有する。
イベント型ごとの renderer は `SessionLogRepresentation.register()` で追加できる。
未登録イベントは `undefined` になり、CLI の既存 formatter が保持している診断用の
表現へフォールバックする。このため、全イベントを一度に移行する必要はない。

現在の組み込み renderer は `permission.pending` である。permission の表示は次の
優先順位で ACP の variant を best-effort に解釈する。

1. 明示された tool 名、legacy `toolCall.type/args`、ACP の `kind` / `toolCallId`
2. `command` / `path` / `locations` などの構造化された操作概要
3. `toolCallId` や `title` の短い補助情報
4. 読めるフィールドがない場合だけ raw JSON の短縮表示

したがって `toolCall.type` が欠落した `execute` payload や `exec-...` ID でも、
`tool=Shell cmd="…"` のように表示する。raw JSON fallback は未知 payload の診断用に
残す。

conductor 向け `permission.pending` YAML には判断用の `brief` と、ACP
`session/request_permission` の params 全体を `request.raw` として含める。
`request.raw` は permission RPC の内容であり、先行する `session/update` の tool call
スナップショットとは別の情報である。`brief` はまず params から項目を埋め、足りない分を
`toolCallId` で蓄積済みスナップショットから補う。必須項目が得られなければ
`brief.missing` に列挙するため、ID だけの要求が操作内容まで判明した扱いにはならない。
従来の `operatorSummary` も互換用・エスカレーション用として併記する。

```yaml
id: <pending id>
workerId: <internal worker id>
worker: <operator label>
createdAt: <epoch ms>
request:
  toolName: Edit
  sessionId: <optional>
  options: <optional>
  raw: <all request_permission params>
brief:
  toolCallId: <optional>
  tool: Edit
  operation:
    kind: edit
    path: <resolved path>
    line: <optional>
  missing: []
operatorSummary: <short operator-facing summary>
```

`tool_call` と `tool_call_update` は `toolCallId` ごとに conductor session 内で累積する。
件数上限は設けず、スナップショットは session の終了まで保持して終了時に破棄する。conductor は
`get_tool_call(toolCallId)` で蓄積した tool call 全体を取得できる。permission params
と snapshot は混ぜず、`get_tool_call` が返すのは後者だけである。

`ask_human` が `relatedPermissionId` を指定した場合、harness はその pending permission の要約を
Open Question の context にも付加し、TTY の Open questions ペインで質問と request id を対応して確認できる。

`worker.failed` / `worker.process.stderr` の診断文字列と、`conductor.send` の
`status=error` は既定でも詳細に残す。正常な `worker.round`、worker state、send lifecycle は
既定では細行を抑制し、`conductor.inbound` / `harness.worker.bootstrap` /
`conductor.outbound` を境界要約として表示する。`conductor.send` のうち `status=error` は
conductor の発話ではないため、CLI の `formatHarnessLogBody()` が operator 向け representation として
障害種別・復旧ヒントを追加する。この同じ 1 行表現を HarnessSink（非 TTY）と
`createTuiTelemetrySink()`（TTY の harness 活動ログ）が共有し、`formatConductorActivityBody()`
と表示 state reducer は error を conductor チャネルへ渡さない。接続停滞・認証・モデル拒否は
既知の障害種別として分類し、元の `error` と `n` / worker 件数を診断として残す。

### 2.4 セッション観測イベント（#92 で追加）

open question・エスカレーション・CLI 通知。stderr の prefix は従来どおり（TUI 導入前の観測互換）。

| type | 発火タイミング | stderr 例 | snapshot への影響 |
|------|----------------|-----------|-------------------|
| `open.question.enqueued` | open question 登録（`ask_human` / max-turns） | `[open question] inq-N [yes_no] ...` | なし |
| `escalation.recorded` | open question 回答のエスカレーション記録 | `[operator answer] ... → ...` | なし |
| `session.worktree.notice` | `--worktree in-repo` 開始時 | `[worktree] 特別モード: ...` | なし |
| `session.continue` | `--continue` で sidecar から再開時 | `[continue] resuming session: conductorAgentId=...` | なし |
| `session.post_loop_wait` | 自律的な連続処理が不要になり、TTY post-loop のイベント待機を開始したとき | （post-loop 待機メッセージ） | なし |
| `session.operator_exit` | オペレータが `/exit` / `exit` を入力した直後（[#170](https://github.com/otolab/agents-ensemble/issues/170)） | （終了フィードバックメッセージ） | なし |
| `session.operator_close` | オペレータが `/close` / `close` を入力した直後（[#458](https://github.com/otolab/agents-ensemble/issues/458)） | （保存して閉じるフィードバックメッセージ） | なし |
| `conductor.dispatch_hold` | `set_dispatch_hold` の ON/OFF、および held trigger（`permission.pending` / `permission.stall` を含む）件数の更新（#265） | `dispatch hold enabled` / `released (flushed N events)` | TUI Workers ペインのタイトルを更新。解除後に残った held trigger も件数表示を維持 |

CLI 整形: `createObservationSink()`（`packages/cli/src/session-sinks.ts`）。

### 2.4.1 dispatch 保留の読者別整理（#265）

| 読者 | 見えるもの | 見えないもの / 注意 |
|------|------------|--------------------|
| オペレータ（TTY） | Workers ペインに `conductor dispatch 保留中（N 件）`（`N` は `permission.pending` / `permission.stall` を含む held trigger 件数）、活動ログに `[observation] dispatch hold enabled` / `released (flushed N events)` | `[harness]` 行は抑制されない。permission.pending の活動ログも通常どおり表示される。operator.message は dispatch を貫通する。max-turns により解除後も worker / GitHub が残る間は、残件数を表示する |
| conductor | `set_dispatch_hold` の YAML 結果（ON は状態、OFF は flush 件数と `sendScheduled`） | held trigger（permission.pending / permission.stall を含む）は通常 OFF 後に 1 回の `agent.send` へ合成される。max-turns で worker / GitHub が送れない場合は held permission が先に dispatch され、残りは後続の operator 入力後に送られる。operator.message は保留されない |
| 運用・resume | 保留は Driver メモリだけ | sidecar に保留状態・held buffer は保存しない。resume は保留 OFF で開始する。release 前に終了すると未 flush events は失われる |

保留は一時的な運用モードであり、teardown flush や crash recovery は提供しない。`/exit`、
`/close`、SIGINT/SIGTERM、conductor send failure、プロセス crash のいずれかが `hold: false` より先に
起きた場合、Driver 内の held buffer と queue に残る hold 対象 trigger は dispatch / sidecar
保存されず失われる。operator は終了前に `set_dispatch_hold({ hold: false })` を呼び、release
完了を確認する必要がある。resume は空の hold（`dispatchHold: false`）で始まる。

### 2.5 GitHub 監視イベント（#39 で追加）

| type | 発火タイミング | stderr 例 | snapshot への影響 |
|------|----------------|-----------|-------------------|
| `harness.github.update` | debounce 後に `github.update` をキューへ載せる直前 | `[harness] github.update items=N` | なし |
| `harness.github.monitor_error` | GitHub API poll 失敗（best-effort。監視は継続。認証失敗時は `[github-auth]` ヒント付き） | `[harness] github.monitor_error ...`（後方互換 1 行。構造化フィールドはイベント型に保持） | なし |
| `harness.github.monitor_recovered` | retryable エラーを抑止した後、エラーなしの poll が成功したとき | `[harness] github.monitor_recovered suppressed=N` | なし |

`harness.github.monitor_error` の構造化フィールド（[#185](https://github.com/otolab/agents-ensemble/issues/185)）:

| フィールド | 型 | 意味 |
|-----------|-----|------|
| `message` | `string` | 人間向けエラー文（stderr 1 行の本文） |
| `phase` | `issue_comments` \| `pr_search` \| `pr_reviews` \| `pr_review_comments` \| `pr_status_checks` | 失敗フェーズ |
| `prNumber` | `number`（任意） | 関連 PR 番号 |
| `cause` | `parse` \| `gh_cli` \| `auth` \| `network` \| `unknown` | 失敗原因の分類 |
| `retryable` | `boolean`（任意） | rate limit / 5xx 等で再試行が有効なとき `true` |

同じフェーズ・PR・原因で続く retryable エラーは、最初の `monitor_error` だけを記録し、以降はクリーンな poll が成功するまで抑止する。復旧時は `monitor_recovered` を1行出して抑止した件数を示す。認証や parse など非 retryable のエラーは抑止せず、poll ごとに記録する。

監視: `packages/core/src/github/github-monitor.ts`。カーソルは sidecar `githubMonitor` に永続化（[ADR 0011](adr/0011-session-sidecar-resume.md)）。関連 PR は GitHub Search で自動検出するほか、conductor の `register_github_watch` で明示登録でき、`unregister_github_watch` で明示登録を解除できる。明示登録した PR は Search に未反映でも監視され、登録後は即時（in-flight poll 中ならその完了直後）に bootstrap poll を行う。debounce（デフォルト 30s）は [ADR 0014](adr/0014-conductor-dispatch-batch-coalescing.md) の dispatch 束とは別レイヤ。

**運用制限（#39）**

| 項目 | 内容 |
|------|------|
| poll 間隔 | 通常 **60s**。いずれかの関連 PR で CI が pending（`QUEUED` / `IN_PROGRESS` 等）なら **15s** |
| debounce | デフォルト **30s**（`--github-monitor-debounce-ms`）。連続インラインコメント等を 1 通知にまとめる |
| 初回カーソル poll | **カーソル空の新規セッション**の初回 poll のみ（`initialCursorPoll`）。既存 Issue コメントは通知せずカーソルを進める。worker の init prompt（`startWorkers`）とは無関係 |
| `--continue` 再開 | sidecar カーソルありなら **初回 poll から差分通知**（オフライン中のコメント等を取りこぼさない） |
| PR 紐づけ | GitHub Search API（`type:pr repo:owner/repo <issueNumber>` 相当）または conductor の `register_github_watch`。Search 失敗時も明示登録済み PR は監視し、**Issue コメント監視も継続** |
| CI wakeup | GraphQL `statusCheckRollup` の **CheckRun / StatusContext** から、CheckRun は `checkSuite.commit.oid`、StatusContext は `commit.oid` を取得する。SHA を解決できる check だけを内部の `skip | running | failed | complete` に正規化し、commit SHA ごとにグループ化する。集約は `running`（1 件でも running）> `failed`（1 件でも failed）> `completed`（すべて skip / complete）の 3 値。SHA 無し check は集約から除外する。前回の `lastAggregateBySha` と今回の集約状態が変わったときだけ、既存 kind `ci.completed`（意味は SHA 集約状態遷移）として通知し、payload に SHA と failed check 名を載せる。 |
| CI カーソル | PR ごとの `lastAggregateBySha[sha]` を sidecar に保存する。通知判定は check 名・run id・URL・個別 conclusion の差分ではなく、同じ SHA の集約状態差分だけで行う。同一 SHA・同一状態の再 poll は通知しない。PR 全体の `hasPendingCi` は、その poll で観測した SHA 集約のいずれかが `running` のとき true とし、15s poll を選ぶ。 |
| 登録・初検出時の完了済み CI | 成功した bootstrap poll で観測した SHA の集約状態は **baseline のみ**。履歴の通知は行わず、以降の状態遷移（`running→completed` / `running→failed` / `failed→running` を含む）だけを通知する。bootstrap の status poll が失敗した場合は baseline 未確定のため `ciBootstrapPending` を保持し、再試行で最初に非 running の集約状態を観測したときは取りこぼし防止のため通知する。 |
| 旧 CI カーソルの移行 | 旧 `lastObserved` / `ciChecks` / `pendingCheckNames` / `notifiedCheckNames` は、check 単位状態から SHA 集約状態を安全に復元できないため、resume 時に 1 回だけ破棄する。次の status poll を現行モデルの baseline とし、旧 run identity は引き継がない。 |
| CI の制限・失敗モード | API poll 失敗時は `harness.github.monitor_error` を出して既存カーソルを維持し、次回 poll で再試行する。bootstrap 中の status poll が失敗した PR では `ciBootstrapPending` を保持し、成功した status snapshot だけで bootstrap 完了にする。SHA 無し check は警告や通知を増やさず除外し、CheckRun / StatusContext 以外の未知の rollup 型は skip。 |
| CLI | `--no-github-monitor` で無効化。`--github-monitor-debounce-ms` で debounce 変更 |

### 2.2 worker prompt ライフサイクルイベント（#133 で統一）

init prompt（harness 起因）と instruction（conductor 起因）を **対称**に扱う。旧 `harness.worker.bootstrap.*` のイベント単位 API は廃止し、現在は単一の `harness.worker.bootstrap` 要約イベントを使う。

正常な lifecycle の細行は既定では表示せず、セッション開始時の init prompt は
`harness.worker.bootstrap`、conductor の `prompt_worker` は `conductor.outbound` で
件数要約を表示する。`--verbose`、`CONDUCTOR_VERBOSE=true`、または
`conductor.verbose: true` を指定すると、下表のイベント単位行も表示する。

`harness.worker.prompt.failed` は attach / prompt の失敗イベントであり、runtime の
terminal state を単独では意味しない。attach failure と lazy init prompt の reject /
cancel は worker を terminal `failed` にする。resident worker の prompt failure は
`worker.failed` も通知するが、lifecycle state は `failed` にならず、queued work が
なければ `idle` に戻る（queued work があれば次の prompt を開始する）。
`harness.worker.prompt.failed` は runtime が失敗経路内で同期 emit する一方、
`worker.failed` は `ConductorInbox` に enqueue され、listener callback は非同期に処理される。
runtime は inbox callback の完了を待たずに `idle` への遷移や次の prompt を進めるため、
`worker.failed` の処理と後続の state / prompt event の観測順は保証されない。TUI の
WorkerDisplayStatus は runtime lifecycle を表示する。`prompt.failed` / `worker.failed` は
診断 event として保持するが WorkerDisplayStatus を変更しない。terminal failure は
`harness.worker.state failed` で表示し、resident prompt failure 後は runtime の `idle` /
`processing` state を表示するため、遅れて届いた `worker.failed` に status を戻されない。

| type | 発火タイミング | stderr 例 | snapshot への影響 |
|------|----------------|-----------|-------------------|
| `harness.worker.prompt.started` | `session/prompt` ラウンド開始（init / instruction 共通） | verbose 時のみ `[harness] worker.prompt.started name=... kind=... source=harness\|conductor` | なし（TUI: running） |
| `harness.worker.prompt.completed` | ラウンド ACP prompt 完了直後 | verbose 時のみ `[harness] worker.prompt.completed name=... kind=... source=... stopReason=...` | なし（TUI: idle） |
| `harness.worker.prompt.failed` | attach 致命失敗、lazy init prompt の reject / cancel、または resident prompt の失敗（runtime が同期 emit） | `[harness] worker.prompt.failed name=... kind=... source=... error=...` | なし（診断 event。WorkerDisplayStatus は変更しない。terminal `failed` / resident `idle` or `processing` は lifecycle state event が反映） |
| `harness.worker.bootstrap` | eager はセッション開始時の worker 群、lazy は対象 worker の attach / init 開始直前 | `[harness] worker.prompt workers=N mode=init` | なし |
| `conductor.outbound` | conductor の send 中に `prompt_worker` で送った worker を send 完了時に集約 | `[harness] worker.prompt workers=N mode=conductor names=...` | なし |
| `harness.worker.acp.update` | `session/prompt` 中の ACP `session/update`（#148） | **なし**（log 相当。活動ログ / stderr には出さない [#161](https://github.com/otolab/agents-ensemble/issues/161)） | なし（TUI: 活動ヒントのみ。`running` 正本は `harness.worker.state`） |
| `harness.worker.state` | `WorkerRuntime` の harness 状態遷移（#147） | verbose 時のみ `[harness] worker.state name=... kind=... state=sleeping\|attaching\|processing\|idle\|failed` | なし（TUI: 下表） |
| `harness.session.workers` | セッション開始時、profile の worker 一覧確定直後。lazy 時は `initialState: sleeping` を含む | verbose 時のみ `[harness] session.workers count=N names=...` | なし（TUI: eager は idle、lazy は sleep で seed） |

**TUI `WorkerDisplayStatus` と harness 状態の対応（#147）**

| `list_workers` / `harness.worker.state` | TUI Workers ペイン |
|----------------------------------------|-------------------|
| `attaching` | `running` |
| `processing` | `running` |
| `idle` | `idle` |
| `sleeping` | `sleep` |
| `failed` | `failed`（attach 致命失敗、または lazy init prompt の reject / cancel。`failedWorkers` 登録・resident なし） |

`harness.worker.state` と `prompt.started` / `prompt.completed` が Workers ペインの lifecycle status を更新する。`prompt.failed` は診断 event であり status を変更しない。非同期 `worker.failed` notification も WorkerDisplayStatus を変更しない。`harness.worker.acp.update` は **活動ヒント**（例: `running (calling: Shell)`）の更新にのみ使い、chunk 単位では stderr / 活動ログに出さない（#161）。これらのイベントは `SessionLogger.emit()` と Workers ペインの state 投影のために維持し、人間向け活動ログの細行だけを既定で抑制する。

TUI の terminal `failed` は `harness.worker.state failed` が表す runtime
`WorkerLifecycleState` に対応する。resident prompt failure は failure event として記録されるが
WorkerDisplayStatus は直接変更せず、queue が空なら `idle`、work が残れば次の `processing` を
表示する。非同期 `worker.failed` callback はどちらの lifecycle display も上書きしない。

`permission.pending` は **Workers ペインを更新しない**（活動ログのみ）。permission 待ち中の worker は `harness.worker.state` / `prompt.*` が `processing` / `running` のまま維持される想定。

**失敗経路の分岐（#147）**

| 経路 | runtime / `list_workers` | 同期 lifecycle / prompt event（順） | `worker.failed` | TUI Workers 最終 |
|------|--------------------------|------------------------------------|-----------------|------------------|
| **attach 致命失敗**（`attachAndInit` の catch。resident 未成立） | terminal `failed`（`failedWorkers`） | `state failed` → `prompt.failed` | inbox に enqueue。listener callback は非同期 | `failed` |
| **lazy init prompt reject / cancel**（resident を破棄し、待機指示を drain） | terminal `failed`（`failedWorkers`） | `prompt.failed` → `state failed` | inbox に enqueue。listener callback は非同期 | `failed` |
| **eager init / conductor prompt failure**（resident 維持、queue が空） | `idle`（resident 存続） | `prompt.failed` → `state idle` | inbox に enqueue。callback は WorkerDisplayStatus を変更しない | `idle` |

resident に queued work が残っている場合、runtime は次の prompt を開始して
`state processing` に進む。遅れて処理される `worker.failed` は通知 / 診断用であり、
TUI の lifecycle display は `processing` のまま保たれる。

**worker 失敗時の permission cleanup（#283）**

`worker.failed` を inbox processor が処理するとき、`WorkerSession` は先に
`PermissionPipeline.denyPendingForWorker()` を呼ぶ。該当 worker の pending permission は
`deny` として `ConductorInbox` の waiter に返され、pipeline から取り除かれる。その後に
`worker.failed` の SessionLogEvent と SessionEvent を通知するため、conductor は worker
失敗を受け取って次の判断へ進める。既に cleanup 済みの requestId を
`resolve_permission` に渡した場合は、`Unknown pending permission (already resolved or worker failed)`
という明確なエラーになる。

`permission.pending` は enqueue 後に取り消せないため、SessionDriver は dispatch 直前に
`PermissionPipeline.pending` を authoritative source として requestId を再確認する。
cleanup 済みのイベントは `SessionEventQueue` と dispatch-hold の held buffer のどちらからも
prune し、live な pending は通常どおり dispatch する。cleanup の対象 worker・requestId・理由は
`permission.cleanup` に記録されるため、`permission.pending` → `permission.cleanup` →
`worker.failed` の順序と deny 結果を時系列で追跡できる。teardown cleanup は同イベントの
`reason=teardown` として記録する。

これはプロセス全体の teardown や in-flight `agent.send` の割り込みを行うものではない。
後者は [#86](https://github.com/otolab/agents-ensemble/issues/86) のスコープである。

init prompt（`source: harness`）では attach 開始時に `started` を出し、init 成功時に `completed` を出す。eager ではセッション開始時に全 worker 分をまとめて bootstrap し、lazy では sleeping worker へ初回 `prompt_worker` が来たとき対象 worker 1 件を bootstrap する。conductor 指示（`source: conductor`）では `executeRound` 開始時に `started`、完了時に `completed`。lazy の正常系は `sleeping` → `attaching` → `processing` → `idle`、以降の conductor 指示は `processing` → `idle`。

lazy の初回 `prompt_worker` は runtime queue に instruction を保持して attach を開始する。init prompt は独立した `source: harness` ラウンドとして成功時に完了イベントを出し、その後に元 instruction を `source: conductor` の別ラウンドで実行する。init 中に permission が発生しても `permission.pending` は通常どおり conductor に届き、init の permission が解決するまで最初の instruction は queue に残る。

lazy init prompt が失敗またはキャンセルされた場合、worker は `failed` になり、初回 instruction と待機中の指示を破棄する。破棄件数と理由を含むエラーを `worker.failed` で conductor に通知し、失敗した指示の暗黙実行・再試行は行わない。

attach handshake 中に届いた追加指示は queue に積む。まだ cancel 可能な ACP prompt がないため、この期間の `preempt: true` は待ち instruction を置き換えるだけで init 自体を中断しない。resident の init / instruction prompt が始まった後は既存の preempt 動作を使う。attach が失敗した場合は queued instructions を実行せず、`worker.failed` に通知して state を `failed` にする。自動 retry はせず、以後の指示には attach failure を返す。profile 外の worker 名は runtime で登録なしとして拒否する。

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
| `operator.reconnect` | オペレータが `/reconnect` / `reconnect` を入力 | **なし** | Driver が `close` → `resume(sameId)` を実行。conductor へ送らず、worker / worktree / プロセスには触れない |
| `worker.completed` | worker 1 ラウンド完了 | `## worker ラウンド完了` | `result.source` で harness / conductor を区別（見出しは同型） |
| `worker.failed` | worker 失敗 | `## worker 失敗` | attach / init prompt / instruction いずれも |
| `permission.pending` | permission が保留 | `## permission 判断待ち` | conductor 向け YAML に `request.raw`（params 全文）と `brief`（構造化された判断用情報）を含む。補えない必須情報は `brief.missing` に載せる。`operatorSummary` も互換用に併記し、`ask_human.relatedPermissionId` で Open Question context と連携する |
| `permission.stall` | worker 活動中の pending permission が既定 300s（`permissionDeadlockStallMs`）継続したとき | `## permission 停滞警告` | conductor 向けの低優先度 trigger。同一の連続停滞エピソードでは 1 回だけ。pending の再送ではなく、経過時間・対象 ID・閾値を含む。`harness.warning` は従来どおり operator 向けに出す |
| `github.update` | GitHub Issue / 関連 PR の更新検知 | `## GitHub 更新` | **状況把握**（[ADR 0012](adr/0012-conductor-worker-prompt-roundtrip.md)）。**自動 `prompt_worker` はしない**。`ci.completed` は harness が commit SHA 単位の CI 集約状態遷移を検知したときだけ載る（同じ SHA・同じ状態の毎 poll 再送はしない。§2.5）。conductor は payload の SHA / failed check 名を手掛かりに必要時のみ Issue / PR を読んで次の判断をする。`issue.comment` / `pr.review` / `pr.review_comment` / `ci.completed` は同じ `SessionEventQueue` → SessionDriver 経路で、自律中・post-loop 待機中を問わず処理する。ターン残あり（`autonomousTurns < maxTurns` または無制限）なら conductor へ dispatch して状況把握ターンを 1 消費し、max-turns 到達後は enqueue のみ（`operator.message` / `permission.pending` / `permission.stall` は dispatch 可） |

### 3.1 SessionLogEvent との対応

```
セッション開始
  harness.worktree ─────────────────────────► verbose 時のみ stderr
  harness.session.workers ──────────────────► TUI seed（eager は idle、lazy は sleep。stderr は verbose 時のみ）
  eager: harness.worker.bootstrap ──────────► stderr / TUI 活動ログ（worker.prompt workers=N mode=init）

WorkerSession.startWorkers()（全 worker を登録。eager は全員を attach、lazy は復元 session のみ attach）
  harness.worker.prompt.started (source=harness) ───► TUI running（stderr / 活動ログは verbose 時のみ）
       │
       ├─ attach + buildWorkerAttachPrompt + session/prompt
       │    harness.worker.state processing ─► TUI running（stderr / 活動ログは verbose 時のみ）
       │
       ├─ 成功 ─► harness.worker.prompt.completed (source=harness) ► TUI idle（細行は verbose 時のみ）
       │          harness.worker.state idle ────────────────► TUI idle（細行は verbose 時のみ）
       │          worker.round (source=harness) ───────► snapshot（細行は verbose 時のみ）
       │          worker.completed (source=harness) ───► SessionEventQueue ► agent.send
       │
       ├─ attach 致命失敗 ─► harness.worker.state failed ──► TUI failed（細行は verbose 時のみ）
       │                    harness.worker.prompt.failed ► stderr（診断 event、status は変更しない）
       │
       ├─ lazy init 失敗 / cancel（resident を破棄、queue を drain）
       │    harness.worker.prompt.failed ─────────► stderr（診断 event、status は変更しない）
       │    harness.worker.state failed ──────────► TUI failed（最終。細行は verbose 時のみ）
       │
       └─ eager init / conductor prompt failure（resident 維持）
            harness.worker.prompt.failed ─────────► stderr（診断 event、status は変更しない）
            harness.worker.state idle ────────────► TUI idle（queue が空の場合。細行は verbose 時のみ）
            queue に work があれば次の prompt を開始し state processing へ

上記の失敗経路では `worker.failed` を `ConductorInbox` に enqueue し、inbox callback が
後から `SessionEventQueue` / snapshot に通知する。これは通知 / 診断用であり、
WorkerDisplayStatus は変更しない。

prompt_worker / sendWorkerMessage
       │
       ├─ sleeping の場合 lazy wake: bootstrap 1 worker → attaching → init prompt（source=harness）
       │                              → init completion → 初回 instruction（source=conductor）
       ├─ harness.worker.prompt.started (source=conductor) ► TUI running（細行は verbose 時のみ）
       ├─ harness.worker.state processing ───────────────► TUI running（細行は verbose 時のみ）
       ├─ harness.worker.acp.update (session/prompt 中) ► TUI 活動ヒントのみ（stderr / 活動ログには出さない #161）
       ├─ permission 保留 ─► permission.pending ───────► stderr / TUI 活動ログ（即時。Workers 欄は更新しない）
       │                     SessionEvent permission.pending ► SessionEventQueue ► （dispatch hold 中は held buffer、解除後は agent.send）
       │                     （停滞閾値到達時は permission.stall ► 同じ queue。低優先度、同一エピソード 1 回）
       │
       ├─ 成功 ─► harness.worker.prompt.completed (source=conductor) ► TUI idle（細行は verbose 時のみ）
       │          harness.worker.state idle ────────────────► TUI idle（細行は verbose 時のみ）
       │          worker.round (source=conductor) ───────► snapshot（細行は verbose 時のみ）
       │          worker.completed (source=conductor) ───► SessionEventQueue ► agent.send
       │
       └─ ラウンド失敗（resident 維持）
            同期: harness.worker.prompt.failed ► stderr（診断 event、status は変更しない）
                  queue が空なら harness.worker.state idle ► TUI idle
                  queue に work があれば次の prompt / state processing を開始
            非同期通知: worker.failed を inbox に enqueue ► callback が後続処理
            worker.failed は WorkerDisplayStatus を変更しない

preempt（stopReason=cancelled）: `prompt.completed` / `worker.round` をスキップし、次ラウンドの `started` + `state processing` で running 維持

各 agent.send 開始
  conductor.inbound ────────────────────────► stderr / TUI 活動ログ（conductor.deliver triggers=N sources=...）
  conductor.send.started ───────────────────► TUI（conductor: thinking。stderr は verbose 時のみ）

各 agent.send 進行中（ツール開始）
  conductor.send.progress ──────────────────► TUI 活動ヒントのみ（stderr / 活動ログには出さない #161）

各 agent.send 完了
  conductor.outbound ───────────────────────► stderr / TUI 活動ログ（worker.prompt workers=N mode=conductor）
  conductor.send ───────────────────────────► snapshot（末尾更新）+ TUI（conductor: idle）。成功の細行は verbose、error は既定でも表示

dispatch hold（#265）
  set_dispatch_hold(true) ─────────────────► observation + TUI（保留中、N 件。permission.pending / permission.stall を含む）
  worker/github/permission trigger ────────► SessionEvent held buffer（`[harness]` は通常どおり）
  permission ─────────────────────────────► SessionEventQueue ─► held buffer（harness/TUI 活動ログは即時）
  operator ───────────────────────────────► SessionEventQueue ─► agent.send（保留を貫通）
  set_dispatch_hold(false) ────────────────► observation ─► held events を dispatch
                                                   │（通常は 1 本化。max-turns では permission.pending を先行し、stall はその後。残件数を保持）
                                                   └─► agent.send

GitHub monitor（セッション中は常時。`--no-github-monitor` で無効化可）
  harness.github.update ──────────────────────► verbose 時のみ stderr
  github.update ──────────────────────────────► SessionEventQueue ► agent.send
       │                                        （自律中・post-loop 待機中とも同じ Driver が消費）

セッション終了
  session.stop ─────────────────────────────► snapshot（異常時のみ既定 stderr、正常は verbose）
  teardown（worker/ACP・conductor・GitHub monitor の停止）
    harness.teardown.phase ─────────────────► verbose 時のみ stderr
    harness.teardown ───────────────────────► stderr（force 時または 1s 超）

  isolated worktree cleanup（正常 `/exit` のみ。`harness.teardown` emit 後。`/close` は実行しない）
    harness.teardown.phase worktree ─────────► verbose 時のみ stderr
    harness.worktree.removed ────────────────► verbose 時のみ stderr
    harness.worktree.remove_skipped/failed ──► harness stderr + observation warning
                                                  └─ TTY: 活動ログ / 非 TTY: stderr
```

人間向けの `[harness]` 行は sink の表示ポリシーであり、`SessionLogger.emit()` の
イベント列や TUI Workers ペインの state 投影を削減するものではない。既定は境界要約と
障害・permission・warning・認証・worktree 警告を表示し、正常 lifecycle の細行は抑制する。
`conductor.verbose` の解決順は **CLI `--verbose` > `CONDUCTOR_VERBOSE` > project config >
user config > `false`**。TTY の活動ログと非 TTY stderr は同じ `formatHarnessLogBody()` を使う。

**重要**: `worker.completed` は init prompt でも instruction でも **同じイベント型・同じ見出し**。conductor は YAML 内の `source` で「自分が指示していない harness 起因の自動処理」かどうかを判別する。`source: harness` は作業開始ではない。

---

## 4. 読者別の整理

### 4.1 オペレータ（TTY / stderr）

| 見えるもの | 見えないもの |
|------------|--------------|
| `operator>` / `conductor>`（stdout、DisplaySink → string backend） | worker 応答全文（会話 UI に混ぜない） |
| `[harness]` テレメトリ（stderr） | SessionEvent の YAML 本文（conductor 向け） |
| `[open question]` 等（ObservationSink、stderr） | |

`conductor.verbose` を有効にしたときの init prompt の細行は次のとおり。既定では
`worker.prompt workers=N mode=init` の要約を使う。

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
| `## permission 停滞警告` | pending permission が長時間解消されない状態の通知（`harness.warning` と同じ検知で 1 回） | `resolve_permission` を試みるか、解消できなければオペレータへエスカレーション。低優先度だが max-turns 到達後も permission 回復用に dispatch 可。`operator.message` / `permission.pending` を押しのけない |
| `## GitHub 更新` | Issue コメント / PR レビュー / CI 集約状態遷移等 | 状況把握。**自動 `prompt_worker` はしない**。自律中・post-loop 中とも SessionDriver が処理する。ターン残ありなら dispatch して 1 ターン消費し、max-turns 到達後は `operator.message` / `permission.pending` / `permission.stall` 以外を dispatch しない |

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

dispatch hold と held buffer は一時 Driver 状態であり、exit JSON / sidecar には載せない。

フィールドの型・出力先（TTY / JSON / ツール）・未取得時の扱いは [session-metrics.md](session-metrics.md) を正本とする。

prompt ライフサイクルイベントは **exit JSON には載せない**（時系列テレメトリのみ）。ラウンド自体は `workerDispatches` に残る。

---

## 5. injectable sink（#92）

`createHarnessSink` / `createDialogueSink` / `createObservationSink` は書き込み先を注入可能（デフォルトは `console.error` / `process.stdout.write`）。

対話 stdout は `createSessionDisplaySink` → reducer → `SessionDisplayBackend` 経由（#93）。interactive かつ非 TTY 時の string backend は内部で `createDialogueSink` を呼ぶ。TTY では Ink TUI（#94、`packages/cli/src/tui/`）が同じ reducer / backend 契約で `pane` / `stream` レイアウトを表示し、stdout への逐次直書きを置き換える。

| prefix | SessionLogEvent | 備考 |
|--------|-----------------|------|
| `[open question]` | `open.question.enqueued` | |
| `[operator answer]` | `escalation.recorded` | |
| `[worktree]` | `session.worktree.notice` | |
| `[continue]` | `session.continue` | |
| （post-loop メッセージ） | `session.post_loop_wait` | |
| （終了フィードバック） | `session.operator_exit` | TTY では入力欄も無効化（`shuttingDown`） |
| （保存して閉じるフィードバック） | `session.operator_close` | TTY では入力欄も無効化（`shuttingDown`） |

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
| `sleeping` | lazy worker。初回の `sendWorkerMessage` を待機中 |
| `failed` | terminal state。attach 失敗、または lazy init prompt の reject / cancel |

通常の resident conductor prompt failure は `worker.failed` を inbox に enqueue するが、
runtime state は terminal `failed` にならない。failure event は診断ログに残り、TUI の
WorkerDisplayStatus は queue が空なら `idle`、work が残れば次の prompt の `processing` を
示す。非同期 inbox callback は lifecycle display を変更しない。

### 6.2 TUI 表示語彙（`WorkerDisplayStatus`）

正本型: `packages/core/src/runtime/worker-display-state.ts`（`sleep` / `idle` / `running` / `failed`）。runtime の `sleeping` は TUI の `sleep` に対応する。

| WorkerLifecycleState（runtime / tool） | WorkerDisplayStatus（TUI / reducer） | 備考 |
|--------------------------------------|-------------------------------------|------|
| `attaching` | `running` | `mapHarnessToDisplayStatus` で明示変換（#146 PR2） |
| `processing` | `running` | prompt ライフサイクルイベントでも同様 |
| `idle` | `idle` | |
| `sleeping` | `sleep` | 初回の `sendWorkerMessage` を待機中 |
| `failed` | `failed` | attach / lazy init の terminal state。`prompt.failed` / `worker.failed` は status を変更しない |

変換関数: `mapHarnessToDisplayStatus`（`packages/core/src/runtime/map-worker-lifecycle.ts`）。  
TUI reducer はイベント駆動のため lifecycle を直接読まないが、worker 向け表示更新はこの関数経由の定数を使用する。

### 6.3 デッドロック検知とメトリクス

`list_workers` が返す harness 状態の実装: [worker-status-tool.ts](../packages/core/src/dispatch/worker-status-tool.ts)

`attachInFlight` は attach フェーズのみのカウンタ。`runningCount` は `processing` ラウンド数 + `attachInFlight`。**いずれも「0 になるまで待て」というシグナルではない**（[ADR 0016](adr/0016-bootstrap-permission-conductor-wait.md)）。

[#125](https://github.com/otolab/agents-ensemble/issues/125) §1 デッドロック検知の置き換え条件（`bootstrapInFlight` 廃止後）:

| 旧（#125 起票時） | 新（#133 後） |
|-------------------|---------------|
| `bootstrapInFlight > 0` | `attachInFlight > 0` **または** いずれか worker の `state === 'processing'` |
| pending permission 継続 | 変更なし（`permission.pending`） |

検知の意図: harness 起因の init prompt または conductor 指示の prompt が permission で止まり、conductor がイベント駆動で解消しないまま N 秒経過した状態をテレメトリする。

| 項目 | 初期値 |
|------|--------|
| 停滞閾値 | **300s**（`300_000ms`、`permissionDeadlockStallMs`） |
| poll 間隔 | **5s**（`permissionDeadlockPollMs`） |
| 警告回数 | 同一停滞エピソードで **1 回**。pending 解消後に再発した場合のみ再警告 |

検知時は従来の `harness.warning` を operator 向けに出し、同時に `permission.stall` を `SessionEventQueue` へ 1 回 enqueue する。`permission.stall` は `inform` ではなく trigger のまま、静的優先度を既存イベントより低く（`operator.message` → `permission.pending` → worker / GitHub → `permission.stall`）定義するため、通常の選択で高優先度イベントを押しのけない。max-turns 到達後も `operator.message` / `permission.pending` に続く permission 回復用の例外として dispatch できる。dispatch hold 中は他の trigger と同様に held buffer に入り、解除後に選択される。CLI は `--permission-deadlock-stall-ms <n>`、API は `RunConductorSessionOptions.permissionDeadlockStallMs` で閾値を上書きできる。`permissionDeadlockPollMs` と worker UI の挙動は変更しない。

実装: `packages/core/src/permission/permission-deadlock-monitor.ts`、`packages/core/src/conductor/session/select-dispatch-batch.ts`。`runConductorSession` 起動時に自動開始（`disablePermissionDeadlockMonitor` で無効化可）。

## 7. 関連コード

| パス | 内容 |
|------|------|
| `packages/core/src/conductor/session/events/session-log-event.ts` | `SessionLogEvent` union |
| `packages/core/src/conductor/session/events/session-event.ts` | `SessionEvent` union |
| `packages/core/src/conductor/session/events/session-log-event-groups.ts` | 型グループ定数（doc 対応） |
| `packages/core/src/conductor/session/session-logger.ts` | `SessionLogger` |
| `packages/core/src/conductor/session/format-session-event.ts` | conductor 向け見出し |
| `packages/core/src/conductor/session/select-dispatch-batch.ts` | SessionEvent の静的優先度 |
| `packages/core/src/conductor/session-policy.ts` | max-turns 後の dispatch 例外 |
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
