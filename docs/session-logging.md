# セッションロギング

> **正本:** `ensemble issue` の出力チャネル、SessionLogger、終了 JSON の役割分担。イベント型・発火条件の正本は [harness-events.md](harness-events.md)、メトリクスの正本は [session-metrics.md](session-metrics.md) です。

`ensemble issue` における **観測（ログ）** と **永続化**、**対話表示** の役割分担。実装の正本は `SessionLogger`（`packages/core/src/conductor/session/session-logger.ts`）。

関連 Issue: [#44](https://github.com/otolab/agents-ensemble/issues/44)

イベント型の一覧・SessionEvent との対応・init prompt 方針は [harness-events.md](harness-events.md) を正本とする。利用可能な統計・トークン・コスト・worker 状態のフィールド一覧は [session-metrics.md](session-metrics.md) を正本とする。

---

## 1. なぜ分けるか

conductor セッションには性質の異なる出力が混在する。

| 種類 | 読者 | 例 |
|------|------|-----|
| **対話** | オペレータ（人間） | `operator>` / `conductor>` のやりとり |
| **harness テレメトリ** | 開発者・運用者 | worktree 解決、worker ラウンド完了、send 回数 |
| **exit report** | e2e / CI / スクリプト | 終了時 JSON（`stopReason`, `workerResponses` 等） |
| **resume 状態** | 次回 `ensemble issue --resume` | SessionResumeStore JSON と open question YAML |
| **operator 状態** | `list_operator_sessions` | SessionResumeStore の `lifecycle` と session-state YAML |

これらを 1 本の stderr に混ぜると、TTY 利用時に **会話相手が worker に見える**・**conductor の応答が終了まで見えない** といった UX 問題が起きる（#44）。

**原則**: 観測は `SessionLogger` に集約し、**sink** で出力先・フォーマットを分離する。resume に必要な harness 状態は SessionResumeStore（JSON）と open question YAML に永続化し、operator 向けの statusLine は session-state YAML に保存する（会話本文は SDK / ACP 側）。

`conductor.send` は status によって表示チャネルが分かれる。`status=finished` の `result` は
conductor が実際に返した応答なので対話チャネル（`conductor>` / TUI 活動ログの
`conductor`）に表示する。一方、`status=error` は SDK / transport が応答を返せなかった
障害であり、conductor の発話ではない。これは対話チャネルへ合成せず、harness チャネル
（非 TTY の `[harness]` stderr、TTY の TUI 活動ログ `harness`）に障害種別・復旧ヒント・
`n` / worker 件数 / `error` の診断を表示する。

人間向けの `[harness]` テレメトリは、既定では conductor 境界の要約
（`conductor.deliver` / `worker.prompt`）と障害・permission・warning・認証・worktree 警告に
絞る。正常な worker state、prompt lifecycle、`conductor.send` 成功行などの細行は
`conductor.verbose: true`、`CONDUCTOR_VERBOSE=true`、または `ensemble issue --verbose`
で復活する。この切り替えは sink の表示だけに適用し、`SessionLogger.emit()`、TUI Workers
ペイン、終了 JSON には適用しない。

---

## 2. 出力チャネル（CLI）

```
┌─────────────────────────────────────────────────────────────┐
│  ConductorSession                                           │
│    emit(SessionLogEvent) ──► SessionLogger                  │
│                                  │                          │
│         ┌────────────────────────┼────────────────────┐   │
│         ▼                        ▼                    ▼   │
│   HarnessSink            DisplaySink          ObservationSink│
│   (stderr)          reducer → backend         (stderr)    │
│                     (Ink TUI or stdout)                   │
│   TTY 時は Harness/Observation を stderr に出さず、      │
│   TuiTelemetrySink → 活動ログ（pane / stream）へ         │
│                                  │                          │
│                                  └────► snapshot()          │
│                                        → 終了 JSON          │
└─────────────────────────────────────────────────────────────┘

  別経路（SessionLogger 外）:
    SessionResumeStore への flush → ~/.ensemble/sessions/<repoKey>/{agentId}.json
    tool-call history flush → ~/.ensemble/sessions/<repoKey>/{agentId}.tool-calls
    question flush → ~/.ensemble/sessions/<repoKey>/{agentId}/open-questions.yaml
    operator status → ~/.ensemble/sessions/<repoKey>/{agentId}/session-state.yaml
```

### stdout

| 内容 | 条件 |
|------|------|
| `operator> …` / `conductor> …` | 非 TTY + 有効な CLI 初回メッセージ（新規セッション） / env: string backend。非 TUI の対話ログに付く話者ラベル |
| **SessionSummary** JSON | 非 TTY 終了時（`--summary-format auto` 既定）。e2e / パイプ向け |

TTY の Ink TUI では Operator input 欄の入力プロンプトを pane / stream 内に `> ` と表示します。これは対話ログの `operator>` / `conductor>` という話者ラベルとは別の表示です。非 TTY では DisplaySink は noop backend（または有効な CLI 初回メッセージ（新規セッション） / env 時のみ string backend）です。`--continue` / `--resume` で無視された CLI メッセージは単発メッセージに数えず、message なしと同じ noop backend になります。stdout は **終了サマリ JSON**（`--summary-format auto` 既定）。TTY では Ink TUI が対話を表示する（stdout への逐次 `write` は行わない）。

### stderr

| prefix | 内容 | 条件 |
|--------|------|------|
| `[harness]` | `SessionLogger` → HarnessSink（既定は境界要約・障害系。`conductor.send` の error は障害種別・復旧ヒント付き） | **非 TTY のみ**（TTY + Ink 時は活動ログへ） |
| `[open question]` | `open.question.enqueued` → ObservationSink | **非 TTY のみ** |
| `[operator answer]` | `escalation.recorded` → ObservationSink | **非 TTY のみ** |
| `[worktree]` | `session.worktree.notice` → ObservationSink | **非 TTY のみ** |
| `[continue]` | `session.continue` → ObservationSink | **非 TTY のみ** |
| （終了サマリ） | `formatIssueSessionSummaryText`（`writeIssueSessionSummary`） | **TTY のみ**（`--summary-format auto` または `text`）。Ink unmount 後 |

open question の回答観測は回答全文を残し、`yes_no` には `assent=yes|no|unclear`、`choice` には回答から一意に解決できた場合だけ `selectedChoice` を付けます。自由記述や曖昧な label では `selectedChoice` を付けません。`approved` は permission に関連付いた yes/no のみ出力します。choice 質問の登録観測には ID と label を表示します。

稼働中 UDS control server は JSON-RPC request / response body をアクセスログへ書きません。ただし回答・operator message は既存の operator 入力経路を通るため、CLI observation は従来どおり質問本文・回答本文・メッセージ本文を stderr または TUI 活動ログに表示します。メッセージの配信モード（`idle` / `next` / `interrupt`）も `operator.input` と TTY 活動ログに記録します。質問・context・回答は SessionResumeStore と YAML にも保存され、UDS list response では保存値のまま返します。任意文面の secret や repository 外情報を確実に検出する redaction はありません。機密値を質問・context・回答・メッセージに含めない運用としてください。

operator-agent の watch polling 警告には例外本文を含めず、Open Question の質問・context・回答本文をログへ出しません。watch report は新規 open、回答、または一覧からの消失を operator-agent への入力として渡し、観測できた質問・context・回答情報を含む場合があります。未 dispatch report の永続化先は owner-only (`0700` directory / `0600` file) の `~/.ensemble/operator-agent/<repoKey>/watch-state.json` であり、通常のログとは別ですが、一般的な secret redaction は行いません。

`~/.ensemble/sessions/<repoKey>/` とセッション別データ directory は owner-only (`0700`)、SessionResumeStore の JSON / YAML / socket file は owner read/write (`0600`) にします。project `.ensemble/sessions/` にある既存データは読み取り fallback として扱います。`--resume` / `--continue` では SessionResumeStore と open-question YAML を user 側へ移し、tool-call 履歴は読み込み時にコピーします。session-state YAML は operator の読み取り fallback を保ち、次回報告時に履歴を引き継いで user 側へ書きます。operator-agent の session / watch state と Pi transcript も、それぞれの読み込み・再開時に user 側へ移します。旧ファイルは自動削除しません。UDS socket は短い owner-only runtime directory (`0700`) に置き、同じ OS user のプロセスからのみ利用できます。token 認証は行わないため、同じ OS user の別プロセスも接続可能です。path の記録だけでは listener の稼働を保証せず、停止後の接続はエラーになります。

TTY + Ink 時は harness / observation イベントを **stderr に書かず**、`createTuiTelemetrySink` 経由で Ink の活動ログに `[harness]` / `[observation]` ラベル付きで追記する。operator / conductor の**成功応答**は DisplaySink → Ink backend が `[operator]` / `[conductor]` として同じ活動ログへ追記する。`conductor.send` の error は conductor 活動ログへ追記せず、harness 活動ログだけに障害として追記する。既定の `stream` レイアウトでは `<Static>` と端末 scrollback を使い、`tui.layout: pane` または `ENSEMBLE_TUI_LAYOUT=pane` で Orchestration ペイン内の windowing に戻せる。stream の活動ログは端末表示用で、SessionResumeStore や活動ログファイルには永続化しない。scrollback 閲覧中に新着ログで末尾へ戻る場合があり、通常の幅変更では既追記行は再折り返しされない（詳細は [operator-input.md](operator-input.md) と [ADR 0015](adr/0015-cli-tui-library.md)）。

`ensemble operator-agent` の TTY も同じチャネルの読み方を使う。対話は `user>` / `operator>`、監視・dispatch の状態や障害は `[harness]`、起動・終了・再接続などの運用通知は `[observation]` として stdout に表示する。監視報告 hold は有効状態・理由・保留件数を `[harness]` の同じ形式で状態変化時に更新する。これは SessionLogger の sink ではなく、readline ベースの独立した operator-agent 表示である。

活動ログでは直前の内容エントリとラベルが変わるときに separator を 1 つ挿入し、同じラベルが続くときは自動挿入しない。conductor ブロックの前後には従来どおり separator を置き、境界処理と重なった連続 separator は 1 つに畳む。エントリ本文の段落空行（`\n\n`）は separator と独立して保持する。pane の bounded history では separator も他のエントリと同じく window の件数に含め、stream では活動ログ全体を append-only で保持する。

### 終了 JSON（SessionSummary）

型名は互換のため `ConductorSessionResult` と同一（`SessionSummary` は deprecated alias）。

**会話ログではない。** exit report として次を載せる。

| 分類 | フィールド |
|------|-----------|
| メトリクス | `startedAt`（Unix epoch ms）, `durationMs`（`SessionLogger` 生成から終了 snapshot 生成まで）, `sendCount`, `stopReason`, `lastRunStatus` |
| 末尾のみ | `lastResult`, `lastError` |
| 蓄積（全履歴） | `workerDispatches` / CLI 出力では `workerResponses` に要約 |
| harness 参照用 | `agentId`, `issueUrl`, `repoRoot` |
| 終了時スナップショット | `escalations`, `openQuestions` |
| LLM usage | `sessionUsage`（`get_session_usage` と同型。cache stats / compaction count は計測可能な場合のみ、cost は conductor の実課金データがある場合のみ `scope: conductor-only` でマージ） |
| worker 応答要約 | `workerResponses[].responsePreview`（全文は `--include-full-response-text`） |

フィールドごとの型・ソース・ツールとの対応・未取得時の扱いは [session-metrics.md](session-metrics.md) を正本とする。
`durationMs` は終了 snapshot を作る時点で算出するため、その後に実行する resource teardown や worktree cleanup の時間は含みません。teardown の所要時間は `harness.teardown.durationMs` として別に記録します。

resume 用の harness 状態は SessionResumeStore と open question YAML に保存します。open question の正本は YAML で、SessionResumeStore JSON の `openQuestions` / `sequence` は移行期間中の互換コピーです。operator 向け statusLine は別の session-state YAML に保存します。終了 JSON の `agentId` は参照用コピーです。

CLI の JSON 形状は `packages/cli/src/format-session-summary.ts` が定義（e2e 互換）。`--summary-format` / `--include-full-response-text` で終了出力を制御する。

---

## 3. SessionLogger

`ConductorSession` がセッション中に `emit()` し、sink に配信する。同時に `snapshot()` 用の状態を蓄積する。

```typescript
const logger = new SessionLogger({ issueUrl, repoRoot });
logger.subscribe(createHarnessSink());
logger.subscribe(createObservationSink());
logger.subscribe(createSessionDisplaySink({
  backend: selectSessionDisplayBackend({ interactive }),
}));

await runIssueSession({ sessionLogger: logger, ... });
```

`sessionLogger` を渡さない場合、core は内部で生成する（レガシー callback 用の `attachLegacySessionCallbacks` あり）。

### SessionLogEvent 一覧

[harness-events.md](harness-events.md) に全イベント・SessionEvent 対応・init prompt 方針を記載。概要:

| type | 発火タイミング | snapshot への影響 |
|------|----------------|-------------------|
| `harness.worktree` | worktree resolve 直後 | なし（sink のみ） |
| `harness.worker.prompt.*` | worker prompt 開始 / 完了 / 失敗（init / instruction 対称） | なし（sink のみ） |
| `harness.worker.state` / `harness.session.workers` | worker harness 状態遷移 / セッション開始時 seed（#147） | なし（sink のみ） |
| `operator.input` | オペレータ発話をキューに載せる直前 | なし（sink のみ） |
| `conductor.inbound` | harness が conductor へ渡す trigger 束の直前 | なし（sink のみ。既定は `conductor.deliver` 要約） |
| `conductor.send.started` | 各 `agent.send` 開始直前 | なし（sink のみ） |
| `conductor.send.progress` | conductor ターン中の SDK ツール開始 | なし（log 相当。活動ログ / stderr には出さない。Workers ペイン活動ヒントのみ #161） |
| `conductor.send` | 各 `agent.send` 完了後 | `sendCount`, `lastRunStatus`, `lastResult`, `lastError` を更新。成功 result は conductor 対話、error は harness 障害表示 |
| `conductor.outbound` | `prompt_worker` による conductor → worker prompt を send 完了時に集約 | なし（sink のみ。既定は `worker.prompt` 要約） |
| `harness.worker.bootstrap` | eager はセッション開始時の init prompt 群、lazy は初回 instruction 時に attach する worker を要約 | なし（sink のみ。既定は `worker.prompt` 要約） |
| `conductor.dispatch_hold` | `set_dispatch_hold` の切替、または held trigger 件数の変化 | なし（TUI の保留表示と observation のみ） |
| `worker.round` | worker 1 ラウンド完了（init prompt 含む） | `workerDispatches` に追記 |
| `worker.failed` | worker 失敗 | `workerFailures` に追記 |
| `permission.cleanup` | worker failure / teardown で pending permission を deny・解消した直後 | なし（sink のみ） |
| `worker.process.stderr` | worker 子プロセス（`agent acp`）の stderr 1 行 | なし（sink のみ） |
| `session.stop` | セッション終了直前 | `stopReason` を確定 |

### 組み込み sink（CLI）

| 関数 | ファイル | 役割 |
|------|----------|------|
| `createHarnessSink()` | `packages/cli/src/session-sinks.ts` | stderr `[harness]`（非 TTY、`verbose` で細行） |
| `createObservationSink()` | 同上 | stderr 観測（非 TTY） |
| `createTuiTelemetrySink()` | `packages/cli/src/tui/` | TTY Ink 活動ログ（harness + observation） |
| `createSessionDisplaySink()` | `packages/cli/src/display/` | `SessionLogEvent` → reducer → `SessionDisplayBackend` |
| `selectSessionDisplayBackend()` | 同上 | interactive かつ非 TTY 時は string backend、TTY は Ink host、非 interactive は noop |
| `createDialogueSink()` | `session-sinks.ts` | 低レベル stdout 整形（string backend が `operator.input` / `conductor.send` で利用） |

Harness の human-readable な 1 行表現は、出力先ごとに重複させず core の
`renderSessionLogEvent()`（`packages/core/src/representation/`）を共有する。
CLI の `formatHarnessLogBody()` はこの representation の thin wrapper であり、
現在は `permission.pending` renderer が登録されている。未登録イベントは既存の
CLI formatter で診断情報を保つ。通常は境界要約・障害系だけを返し、`verbose: true` で
従来の細行を返す。`conductor.send` の error は CLI formatter で
障害種別・復旧ヒント・`n` / worker 件数 / `error` を付与し、harness チャネルへ出す。
permission の ACP variant と抽出優先順位は
[harness-events.md §2.1.1](harness-events.md#211-オペレータ向け-representation) を参照。

表示 state（`SessionDisplayState`）は worker 状態・conductor 直近出力・未回答 open question・dispatch 保留状態のイベント投影を保持する。TTY の Ink TUI（`packages/cli/src/tui/`）は `pane` / `stream` とも、operator binding 後は `getContext().openQuestions`（`OpenQuestionRegistry` の `listOpen()` スナップショット）を未回答一覧の正本として使い、binding 前だけ display state をフォールバックにする。これにより SessionResumeStore から再開した後も復元済み question を表示できる（#94、#257、#263）。

---

## 4. SessionResumeStore と open question YAML

SessionResumeStore は、harness がセッション再開に必要な情報を保存する JSON ファイル（`~/.ensemble/sessions/<repoKey>/{conductorAgentId}.json`）です。会話 transcript の保存先ではなく、記録された socket path だけでは harness の稼働や接続可能性も分かりません。

セッション再開用データは `packages/core` の `resolveEnsemblePaths({ repoRoot })` で解決し、repo ごとに user 側へ保存します。`repoKey` は正規化した絶対 `repoRoot` の SHA-256 です。

```text
~/.ensemble/sessions/<repoKey>/
  {conductorAgentId}.json
  {conductorAgentId}/
    open-questions.yaml
    session-state.yaml
  {conductorAgentId}.tool-calls
  pi/

~/.ensemble/operator-agent/<repoKey>/
  session.json
  watch-state.json
  pi-sessions/
```

Pi の conductor transcript は `pi/` に保存します。Pi の project settings や skills などの project resources は引き続き `<repoRoot>/.ensemble/pi/` から読みます。operator-agent は保存済み SessionResumeStore と YAML を同じ repoKey の user 側 directory から読みます。

旧 `<repoRoot>/.ensemble/sessions/`、`.ensemble/operator-agent/`、`<conductorCwd>/.ensemble/pi/sessions/` のデータは読み取り fallback します。SessionResumeStore と open-question YAML、tool-call 履歴、operator-agent state / watch state、Pi transcript は利用に応じて user 側へ移します。session-state YAML は fallback で読み、次の status 報告で履歴を引き継いで user 側へ書きます。旧ファイルは自動削除しません。Issue 用 Git worktree は元 repo に登録され、現行の解決・再利用処理が project-local path を前提とするため、例外として `<repoRoot>/.ensemble/worktrees/issue-N` に残します。配置判断の詳細は [ADR 0044](adr/0044-user-scoped-runtime-storage.md) を参照してください。

`session-state.yaml` は `report_session_state` が登録した最新の statusLine と過去の報告をセッションインスタンスごとに保存します。statusLine（80 文字以内）を報告するたびに YAML を同じディレクトリ内の一時ファイルから atomic rename で更新します。`current` が最新値、`history` は過去の値を古い順に並べた一覧です。履歴は最大 50 件、ファイル全体は最大 16 KiB で、上限を超える場合は古い履歴から削除します。

```yaml
version: 2
current:
  statusLine: "レビュー中：CIテスト待ち"
  reportedAt: 1735689600000
history:
  - statusLine: "調査中：失敗を再現"
    reportedAt: 1735689500000
```

一覧ツールは `statusLine` / `reportedAt` に加え、`statusLineHistory` として保存済みの履歴も返します。旧 version 1 ファイルは読み取り時に `current` として扱い、次の報告時に version 2 へ移行します。異なる `conductorAgentId` は同じ Issue を扱っていても別々のファイルです。

`open-questions.yaml` は OpenQuestionRegistry 全体のスナップショットです。質問の登録・回答後と終了時に atomic rename で保存します。YAML の形は次のとおりです。

```yaml
version: 1
sequence: 3
openQuestions:
  - id: inq-1
    question: "Which release approach?"
    responseType: choice
    status: answered
    source: conductor
    askedAt: 1735689600000
    choices:
      - id: staging
        label: Staging
    answer: "Ship to staging first."
    answeredAt: 1735689700000
    answeredBy: operator
    selectedChoice: staging
```

`responseType` は `yes_no` / `text` / `choice`、`status` は `open` / `answered`、`source` は `conductor` / `max_turns` です。`context`、選択肢、回答時刻、回答者、yes/no の `assent` / permission 関連時の `approved` などは該当する場合に保存します。`sequence` は次に割り当てる `inq-N` ID を復元するために使います。

`--continue` は同じ Issue の候補から `close` / `abort` を優先し、`exit` は候補から除外します。優先候補が複数ある場合は `updatedAt` が新しいものを選びます。候補がなければ `exit` 以外から最新を選びます。旧 SessionResumeStore は `lifecycle` の `closed→close`、`interrupted→abort`、`exited→exit` を読み替えます。`--resume` / `--continue` の復元時は、YAML があれば質問一覧と sequence にその内容を使います。YAML がまだない旧形式のセッションでは SessionResumeStore の `openQuestions` と `sequence` から復元し、YAML をバックフィルします。移行期間中は flush のたびに両方へ同じ質問スナップショットを書きます。YAML が存在していて読み取りまたはスキーマ検証に失敗した場合は resume を中止し、古い可能性がある SessionResumeStore 内の質問一覧へ黙って切り替えません。

`harnessPhase` は harness が最後に保存した位相です。conductor send または worker prompt の in-flight があれば `running`、両方が idle の状態を 250ms 保つと `idle` を保存します。開始時は即時に `running` を flush し、短い作業の間に phase が頻繁に揺れないよう `idle` のみ debounce します。`close` / `abort` / `exit` は teardown 完了後に最終 flush し、terminal phase は後続 flush で上書きしません。通常の非TTY終了は旧 `unknown` 相当として `harnessPhase` / `modifiedAt` を持たず、`lifecycle: unknown` を記録します。新旧クライアントの移行中は JSON に `lifecycle` も書き続け、teardown 区分は `closed` / `exited` / `interrupted` / `unknown` の従来値を保ちます。旧形式の `lifecycle` は `closed→close`、`exited→exit`、`interrupted→abort` と読み替え、`unknown` は位相不明として扱います。

`modifiedAt` は SessionResumeStore を harness が保存するたびに更新し、同じ書き込みの `updatedAt` と同じ Unix ms にします。これにより resume 用状態の flush と phase 遷移の鮮度を表します。`session-state.yaml` の `reportedAt` は conductor が operator 向け statusLine を報告した時刻であり、別の情報です。SessionResumeStore の `modifiedAt` / `updatedAt` は `/close`・`/exit`・signal teardown の最終 flush でも揃います。operator-agent の一覧は毎回 UDS probe をせず、watch pool の直近 10 秒以内の観測がある場合だけ `live.connectivity` に載せます。`live.checkedAt < persisted.modifiedAt` の古い観測は保存phaseとの整合判定に使わず、`coherence: insufficient_data` とします。同じ時刻か新しい観測なら現在のphaseとの判定に使い、terminal phaseと `reachable` は `conflict` です。watch で `running` / `idle` の接続失敗が30秒続く場合も `coherence: conflict`、30秒未満またはlive未観測なら `insufficient_data` とします。通常一覧の `unknown` は未確認を意味し、停止中とは限りません。

| | SessionSummary（終了 JSON） | SessionResumeStore / session YAML |
|--|---------------------------|---------|
| **目的** | 1 回の実行結果の報告 | セッション再開用の harness 状態 |
| **タイミング** | プロセス終了時に 1 回 | 状態変化時に best-effort flush + 終了時 |
| **会話本文** | 載せない（worker 応答の要約のみ） | 載せない |
| **open question** | 終了時の一覧スナップショット | YAML が正本。移行中は SessionResumeStore にも同じ一覧を保存 |
| **operator 状態** | 載せない | `session-state.yaml` に最新 statusLine と上限付き履歴、SessionResumeStore に `harnessPhase` / `modifiedAt` と互換用 `lifecycle` を保存 |
| **worker session** | 載せない | `acpSessionId` を保持 |
| **tool-call snapshot** | 載せない | 別ファイル `.tool-calls` に保持（TTL / サイズ上限あり） |

稼働中 harness の UDS method `session.conductor_messages.list` は、bootstrap send を除く成功応答と対応する formatted inbound を最大 100 件、プロセスメモリ内だけに保持します。これは停止後に参照できない live projection です。operator-agent tool の `list_conductor_messages` は provider session history から user inbound / final assistant response を再構成し、稼働中・停止後とも直近100件を返します。Pi は active branch と entry ID、Cursor は local run history を使い、provider store の retention / deletion を保証しません。最後の応答だけを返す `session.last_conductor_message.get` / `get_last_conductor_message` は従来どおりの単独 projection です。

tool-call history は SessionResumeStore とは別に読み書きし、履歴ファイルの欠損や破損で resume を妨げません。
保持期限・上限・プライバシー上の扱いは [harness-events.md](harness-events.md) を参照してください。
詳細は [ADR 0011](adr/0011-session-sidecar-resume.md)、[ADR 0032](adr/0032-tool-call-snapshot-history.md)、[ADR 0039](adr/0039-session-resume-state-and-operator-projection.md)、
[operator-input.md](operator-input.md) の post-loop / 終了動作を参照してください。SessionResumeStore JSON のスキーマと他の復元状態は ADR 0011 を参照してください。

---

## 5. SDK / ACP の会話ログ

| 主体 | 正本 | harness が載せるもの |
|------|------|---------------------|
| conductor（SDK） | SDK store（`agentId`） | `conductor.send` の status / 末尾 result のみ |
| worker（ACP） | ACP セッション | `worker.round` のメタデータ（name, stopReason, path）。**応答全文は対話 stdout に出さない** |

オペレータが読むべき conductor 発話は、成功応答に限り DisplaySink → string backend
（内部で `createDialogueSink`）経由。`conductor.send` の error は conductor 発話では
ないため、この経路を通らず harness チャネルに出す。worker の `responseText` は終了 JSON
の `workerResponses` に載るが、TTY セッション中の会話 UI には混ぜない。

### worker 子プロセスの stdio

`spawnAcpProcess`（`packages/core/src/acp/acp-process.ts`）は worker の `agent acp` を子プロセスとして起動する。

| fd | 扱い | 理由 |
|----|------|------|
| stdin | pipe → ACP プロトコル | harness が JSON-RPC を書き込む |
| stdout | pipe → AcpClient / JsonRpcPeer | ACP プロトコル専用。対話 stdout には出さない |
| stderr | **pipe → capture** | 子の警告（例: `shell-parser`）を TTY の `operator>` 行に混ぜない |

stderr は行バッファで読み、`SessionLogger` の `worker.process.stderr` として sink へ配信する。CLI の HarnessSink は `[harness] worker.stderr name=…` を **stderr** に出す（対話 stdout には出さない）。

stdout へのプロトコル外出力は JsonRpc 層でパース失敗として検知される。現状は stderr capture を優先し、stdout 漏れの二重読みは行わない。

ACP の writable pipe が `EPIPE` / `ECONNRESET` などで切断された場合、JsonRpc 層は write error を harness の未処理例外に漏らさず、進行中の JSON-RPC request を失敗させる。`session/request_permission` の返信中に切断された場合も同じ worker ラウンドが失敗し、`worker.failed` 経由で pending permission を deny して harness 側の待機状態を解消する。

readable pipe の `end/error` は writable pipe の切断とは分離して扱う。readable 側で応答待ちの request は失敗するが、writable が利用可能な間は既に受信した agent request への `respond`（permission の deny を含む）を継続できる。readable 切断後に新しい request は開始しない。

conductor（SDK）子プロセスの stdio は本 Issue のスコープ外（follow-up）。

---

## 6. カスタム sink

`SessionLogSink = (event: SessionLogEvent) => void` を `subscribe()` で追加できる。

用途例:

- 構造化ログ（JSON Lines）をファイルへ
- CI で harness のみ収集し stdout は JSON だけパース
- 将来の Web UI へのイベントストリーム

レガシー API（`onSendComplete`, `onWorkerDispatched`, `onWorkerFailed`）は内部で同じイベントから呼ばれる。新規コードは `SessionLogger.subscribe` を推奨。

---

## 7. 関連コード

| パス | 内容 |
|------|------|
| `packages/core/src/conductor/session/session-logger.ts` | `SessionLogger`, 型定義 |
| `packages/core/src/representation/session-log-representation.ts` | operator 向け SessionLogEvent renderer registry |
| `packages/core/src/acp/acp-process.ts` | worker 子プロセス spawn・stderr capture |
| `packages/core/src/conductor/conductor-session.ts` | `emit` 配線、`snapshot()` で終了 |
| `packages/cli/src/session-sinks.ts` | Harness / Observation / Dialogue sink |
| `packages/cli/src/display/` | 表示 state・reducer・DisplaySink |
| `packages/cli/src/format-session-summary.ts` | 終了 JSON / テキスト整形 |
| `packages/cli/src/resolve-summary-format.ts` | `--summary-format` 解決 |
| `packages/cli/src/issue-command.ts` | sink 購読と interactive 判定 |

テスト: `session-logger.test.ts`, `session-sinks.test.ts`, `session-display-reducer.test.ts`, `select-session-display-backend.test.ts`, `acp-process.test.ts`
