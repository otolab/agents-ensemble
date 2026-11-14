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
| **保存 session の CLI 閲覧** | `ensemble session list/show` | SessionResumeStore の要約と関連 YAML の件数・時刻 |
| **conductor 履歴の CLI 閲覧** | `ensemble session messages` | provider session history |
| **worker 履歴の CLI 閲覧** | `ensemble session workers messages` | Pi / Codex ACP transcript |
| **障害調査 timeline** | `ensemble session timeline` | ResumeStore / provider history と、任意の終了サマリ・captured harness log の send 番号照合 |

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
    SessionResumeStore への flush → ~/.ensemble/sessions/github.com/<owner>/<repo>/{agentId}.json
    tool-call history flush → ~/.ensemble/sessions/github.com/<owner>/<repo>/{agentId}.tool-calls
    question flush → ~/.ensemble/sessions/github.com/<owner>/<repo>/{agentId}/open-questions.yaml
    operator status → ~/.ensemble/sessions/github.com/<owner>/<repo>/{agentId}/session-state.yaml
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

稼働中 UDS control server は JSON-RPC request / response body をアクセスログへ書きません。ただし回答・operator message は既存の operator 入力経路を通るため、CLI observation は従来どおり質問本文・回答本文・メッセージ本文を stderr または TUI 活動ログに表示します。配信モード（`idle` / `next` / `interrupt`）は `operator.input` と TTY の未 dispatch キューに表示します。TTY 活動ログには dispatch 時に本文のみを表示します。質問・context・回答は SessionResumeStore と YAML にも保存され、UDS list response では保存値のまま返します。任意文面の secret や repository 外情報を確実に検出する redaction はありません。機密値を質問・context・回答・メッセージに含めない運用としてください。

operator-agent の watch polling 警告には例外本文を含めず、Open Question の質問・context・回答本文をログへ出しません。watch report は新規 open、回答、または一覧からの消失を operator-agent への入力として渡し、観測できた質問・context・回答情報を含む場合があります。#697 の storage cutover 後、未 dispatch report を含む watch state は owner-only (`0700` directory / `0600` file) の `~/.ensemble/operator-agents/<profile>/watch/github.com/<owner>/<repo>/` に保存します。旧 `~/.ensemble/operator-agent/<repoKey>/watch-state.json` や checkout 内の state は #698 の一括 migration source であり、会話ログとは別の保全対象です。watch state にも一般的な secret redaction は行いません。

`~/.ensemble/sessions/github.com/<owner>/<repo>/` と session ごとの data directory は owner-only (`0700`)、SessionResumeStore の JSON / YAML / socket file は owner read/write (`0600`) にします。Issue-session の新規 write は slug 側だけです。user path-hash と project `.ensemble/sessions/` は読み取り fallback とし、`--resume` / `--continue` では slug にない ResumeStore / sidecar / tool-call history / Pi transcript だけをコピーします。slug に既存 file があればそれを優先し、複数 location の内容を統合せず、fallback source は変更・削除しません。operator-agent state は別の保存 path を使います。UDS socket は短い owner-only runtime directory (`0700`) に置き、同じ OS user のプロセスからのみ利用できます。token 認証は行わないため、同じ OS user の別プロセスも接続可能です。path の記録だけでは listener の稼働を保証せず、停止後の接続はエラーになります。

Builtin Pi worker の session map と transcript は、POSIX では専用 parent と worker storage tree の directory を `0700`、既存 file を `0600` にし、wrapper の `umask 077` で upstream adapter / Pi CLI の新規 file も owner read/write に制限します。Windows では wrapper が標準の `icacls.exe` で専用 parent と起動した repository の storage tree を現在の account SID だけに許可する DACL にし、PowerShell の .NET ACL API で owner と ACE を読み戻して検証します。upstream が指定された map / transcript directory 内に通常の方法で作る file / directory は、その ACL を継承します。PowerShell / `icacls.exe` の起動、ACL 設定、検証のいずれかに失敗した場合は adapter を起動しません。対象は builtin worker の map / transcript 保存先であり、共有 Pi settings / auth root や BYO 保存先には適用しません。同じ OS account の別 process、管理者 / SYSTEM / backup privilege、ACL を無視する storage、または将来の upstream が対象 directory の外へ書く・権限を明示的に広げる動作は保護しません。権限を書き換えられない既存データがある場合も起動は失敗します。POSIX の builtin storage 内に symlink / reparse point または特殊 file がある場合は wrapper が起動を拒否します。

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
| モデル構成 | `sessionModels`（conductor の backend・設定 model ID / reasoning・最後の send が報告した model ID、各 worker の名前・kind・`modelTag`・ACP preset・起動設定に注入した model ID / reasoning / 明示した Cursor fast 値） |
| worker 応答要約 | `workerResponses[].responsePreview`（全文は `--include-full-response-text`） |

フィールドごとの型・ソース・ツールとの対応・未取得時の扱いは [session-metrics.md](session-metrics.md) を正本とする。
`sessionModels` は usage が取得できない場合も出力する。TTY の終了テキストは stderr に conductor の設定値・最終 send の報告値と、各 worker のモデル・推論・Cursor fast 設定を表示する。conductor の reasoning は CLI / API 明示値・env / config の優先順位で解決した指定値で、provider が実際に適用した値の読み戻しではありません。send の報告値は失敗時にも含まれることがあります。worker の `model` / `reasoning` / `cursorFast` は preset の設定経路に渡した値で、ACP option の `currentValue` も adapter が報告する session option です。これらは実際の runtime model や推論動作を証明するものではありません。
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
| `operator.input` | オペレータ発話をキューに受理したとき | なし（sink のみ） |
| `operator.queue.changed` | waiter から operator message をキューへ戻したとき | なし（TUI 更新） |
| `operator.dispatched` | operator message を conductor へ dispatch するとき | なし（TUI 活動ログ） |
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

Conductor recovery inbox は `SessionLogger` と別の process-local store です。対話 TTY に限り、失敗した
dispatch に含まれる operator-authored input を保持します。snapshot 本文を持つ新しい `SessionLogEvent` は
発行せず、SessionSummary、SessionResumeStore、UDS response、conductor send にも追加しません。未完了 send の
`harness.warning` は status / failure class / attempt ID / snapshot ID と操作案内だけを示し、本文や raw error
を含めません。非 TTY では本文を保存せず、同一 process 内でも確認できない旨を本文なしで知らせます。

これは既存 event の扱いを変えるものではありません。`operator.input` / `operator.dispatched` は従来どおり
operator message の本文を扱い、`worker.round` の worker result は従来どおり SessionLogger / session summary に
蓄積されます。ここで防ぐのは recovery snapshot を新たな保存先へ複製することです。明示的な
`/recovery show` は TTY に内容を表示するため、terminal capture / recording からは保護されません。snapshot の
保持条件と確認手順は [operator-input.md](operator-input.md) を参照してください。

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

SessionResumeStore は、harness がセッション再開に必要な情報を保存する JSON ファイル（`~/.ensemble/sessions/github.com/<owner>/<repo>/{conductorAgentId}.json`）です。会話 transcript の保存先ではなく、記録された socket path だけでは harness の稼働や接続可能性も分かりません。

`ensemble session list/show` は core の SessionResumeStore / YAML 読取 API を使う読み取り専用 CLI です。harness への接続や agent 起動は行わず、sidecar は許可したメタデータだけ、YAML は件数・時刻だけを表示します。旧形式の SessionResumeStore に残る ACP 環境変数の平文値も読取 API が除外します。`show` の `workerReaders` は、保存 preset に対応する transcript reader の有無と未対応理由を worker ごとに示します。transcript の保存先が現在読めるかどうかは、この表示では確認しません。

`ensemble session messages` は operator-agent の `list_conductor_messages` と同じ `listConductorProviderHistory` を使い、provider が保存した user inbound / final response の本文をそのまま返すローカルデバッグ表示です。Pi の transcript は canonical repository slug の `~/.ensemble/sessions/github.com/<owner>/<repo>/pi/` を先に探し、対象 session がなければ現在の `repoRoot` に対応する hash 保存先、次に保存済み `conductorCwd` の `.ensemble/pi/sessions/` を探します。Pi `SessionManager` に渡す cwd は引き続き `conductorCwd` です。テキストと JSON の両方で redaction は行いません。会話本文に秘密値や repository 内の非公開情報があれば、そのまま stdout に出ます。pipe / redirect 先も生データとして扱い、集計・蓄積・共有する前に利用側でサニタイズしてください。構造化された SessionResumeStore の秘密値保護は、この会話本文には適用されません。core API から後段へ渡す前に sanitizer を適用する契約は [provider history list API](live-open-question-control-api.md#operator-agent-の-provider-history-list)を参照してください。

`ensemble session export <conductorAgentId> --output <dir>` は、保存 session をオフライン調査向けの bundle に読み取り専用でまとめます。出力先は新規 directory に限り、既存 directory や file を上書きしません。`manifest.json` には session の識別情報と ensemble / CLI version、入力 source の状態、bundle 内相対 path、byte size、SHA-256 を記録します。manifest 自身は hash の一覧から除外します。SessionResumeStore は元 JSON を raw copy し、登録 worker ごとに上限なし reader 結果 JSON と元 transcript path を出力します。`session-state.yaml` / `open-questions.yaml`、必要なら `--include-tool-calls` の `.tool-calls` も収録します。指定した `--summary` / `--harness-log` はそのままコピーします。

Pi conductor history は canonical slug の user 層 transcript を先に探し、見つからない場合は user path-hash、保存済み `conductorCwd` 配下の legacy `.ensemble/pi/sessions/` の順で探します。resume 時に legacy transcript から再開するときは slug 側にない file だけをコピーし、source を残します。`listConductorProviderHistory` と session export は同じ path resolver を使います。Cursor conductor は SDK の local run API から取得できた全ページの metadata と conversation snapshot を JSON に保存します。raw copy は symlink や通常 file 以外を追いません。出力 directory / file には POSIX で `0700` / `0600` の mode bits を設定しますが、Windows では Node.js の `fs` mode で変更できるのは書き込み権限だけで、owner / group / others を区別できません。exporter も Windows ACL を設定・検証しないため、新しい bundle は親 directory から継承される ACL に従い、owner-only は保証されません。Windows では ACL が意図した範囲に制限された保存先を使用してください（詳細は [CLI 利用者向け説明](cli/README.md)を参照）。harness phase が `running` / `idle` の session は harness process が稼働中の best-effort snapshot として扱い、export 結果の status は `partial` になります。warning は manifest と result に記録します。全ファイルが同じ瞬間の状態であることは保証しません。Pi transcript のコピー中に更新を検出した場合も warning を残します。

export は `messages` / `workers messages` と同水準の raw data です。API key・token・password、tool 出力、repository 内の非公開情報を自動 redaction しません。manifest に source の絶対 path が記録される場合もあるため、bundle と manifest を機密情報として扱い、Issue / PR・log・蓄積先へ載せる前に利用者側でサニタイズしてください。任意入力や補助 YAML、各 provider transcript の欠落・読取不能は黙って省かず、manifest の source status と warning に記録します。ResumeStore が見つからない場合は bundle を作らず error にします。

`ensemble session workers messages <conductorAgentId> --worker <name>` は、SessionResumeStore に保存された ACP session ID / cwd を使い、ローカルの worker transcript を読みます。ACP process の起動、`session/load` による再接続、Codex state DB の参照は行いません。共通 message 形は `source` / `providerId` / `role` / `at` / `text` です。

Pi ACP（`pi`）の BYO runtime と runtime marker のない旧 session は、CLI process の home にある `~/.pi/pi-acp/session-map.json` から transcript を解決します。builtin runtime は SessionResumeStore に保存された `piRuntime: builtin` marker と `issueUrl` を使い、`~/.ensemble/pi/worker/<repoKey>/issue-<issueNumber>/<workerKey>/.pi/pi-acp/session-map.json` と同じ Issue / worker directory の `sessions/` にある transcript を読みます。これにより、同じ repository で同名 worker が別 Issue の session map を並行更新しても互いの entry を上書きしません。旧 builtin runtime が repo・worker 間で共有していた map は、Issue ごとの map がまだない場合に wrapper がコピーし、reader は移行前の map も fallback で読みます。旧 map が指す transcript は移動しないため、既存 session の `session/load` と reader は元の path を引き続き使えます。BYO の map と保存先は変わりません。どちらも Pi `SessionManager` の active branch と同じ JSONL 形式を使います。判断の詳細は [ADR 0070](adr/0070-issue-scoped-builtin-pi-storage.md) を参照してください。Codex ACP（`codex`）は `$CODEX_HOME`（未設定なら `~/.codex`）の `sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>[_<rollout-id>].jsonl` と `archived_sessions/` を探索します。相対 `CODEX_HOME` は保存済み worker `acpCwd` を基準に解決し、Codex ACP process の cwd とそろえます。Codex ACP の session ID は thread ID であり、rollout の `session_meta.payload.id` と `cwd` を保存値に照合します。同一 basename の `.jsonl` と `.jsonl.zst` がある場合は `.jsonl` を優先し、圧縮 rollout は Node.js の zstd 解凍 API が使える場合に読みます。

両 preset とも user / assistant の本文だけを共通形へ正規化し、tool result、reasoning、その他の会話本文以外の entry は含めません。同じ Codex thread ID の rollout が複数見つかる場合は、履歴を誤選択しないよう `unavailable` とします。`cursor` / `claude` / `custom` など未対応 preset と preset 欠落の旧 Store は `unsupported`、保存データの欠落・破損・session ID / cwd の不一致・保存先の曖昧さは `unavailable` になります。reader は閲覧 CLI の現在の環境から `CODEX_HOME` を読み、相対値は保存済み worker `acpCwd` を基準に解決します。`CODEX_HOME` が未設定の場合の `~/.codex` と、BYO Pi の `~/.pi/pi-acp/session-map.json` は閲覧 CLI の home を使います。builtin Pi は閲覧 CLI の `ENSEMBLE_USER_ROOT`（未設定なら `~/.ensemble`）と repository root / worker 名から保存先を解決します。worker 起動時だけ別の `HOME` / `CODEX_HOME` / `ENSEMBLE_USER_ROOT` を使った場合、SessionResumeStore に残るのは spawn env の digest だけなので、その値や元の保存先は復元できません。保存時と閲覧時で保存先が異なり、閲覧 CLI の環境から特定できなければ、transcript が存在していても `unavailable` になります。

worker 履歴も保存された本文をそのまま返します。text / JSON のいずれも redaction しないため、秘密値や repository 内の非公開情報が stdout に出る可能性があります。pipe / redirect 先を含め、生データとして扱ってください。

`ensemble session timeline` は SessionResumeStore と最大100件の conductor provider history を読みます。任意の `--summary <path>` は `ensemble issue --summary-format json` で保存した SessionSummary JSON、`--harness-log <path>` は保存済み stderr log を追加します。log reader は `conductor.send` と `conductor.transport.reconnect` の行を認識します。Pi の `sendCount` は harness process ごとにリセットされ、resume 前後で再利用されます。そのため、対象 SessionSummary の `startedAt` より後、`startedAt + durationMs` より前に完了した provider history だけを send 番号で照合します。開始・終了時刻ちょうどの履歴は隣接 run と区別できないため相関せず、別枠に表示します。相関前に、SessionLogger の生成側契約（開始が `Date.now()`、`durationMs` が終了時の `Date.now() - startedAt`）と整合するか検査します。相関に必要なミリ秒精度を保つため、開始と導出した終了時刻が整数 Unix epoch ms として表せ、`durationMs` が非負の安全な整数である場合だけ有効です。契約や精度に合わない値は理由を示して `unavailable` とし、provider history を send 番号で結び付けません。Cursor も共通の send 番号を持たないため別表示します。

通常の SessionLogEvent 履歴は永続化されません。summary / log が未指定・読取不能・不正な JSON / schema・保存 session との不一致なら source 状態と理由を示し、reconnect を補って表示しません。Pi の provider history reader が返すのは成功した inbound / response pair です。対応する pair がない表示は gap の存在を示すだけで、raw transcript に未対応 entry があるかや欠落の原因は証明しません。captured log に run ID や時刻はないため、summary と同じ process の stderr を指定してください。reconnect 行には provider history と共有する event ID や時刻がなく、send 行に対する配置はファイル内の行順だけを示します。

SessionSummary と provider history の時刻だけでは run / process を一意に識別できません。時間相関は同じ session の process が重ならず、実行中にシステム時計が大きく変わらない前提ですが、この条件を CLI は検証できません。特に前向きの時計変更は妥当な時刻範囲に見える duration を作ることがあり、単調時計や run ID の記録がない現状では判別できません。その可能性がある調査では、send 番号の時間相関を同一 run の証明として扱わないでください。

新規の `ensemble issue` は、初回 flush から `createdHarnessCliVersion` に `@agents-ensemble/cli` の package version を記録します。`--continue` / `--resume` は作成時の値を保持し、旧 Store で値が欠けている場合は欠落したまま扱います。この値は SessionResumeStore の schema version とは別です。

Issue session の新規・更新データは `packages/core` の `resolveEnsemblePaths({ repoRoot })` で解決し、GitHub owner/repo の canonical slug ごとに user 側へ保存します。`repoKey` は正規化した絶対 `repoRoot` の SHA-256 で、既存 Issue data を探す fallback key として残ります。operator-agent の新しい watch state は profile と repository slug で分け、旧 `repoKey` state は一括 migration の source として扱います。

```text
~/.ensemble/sessions/github.com/<owner>/<repo>/
  {conductorAgentId}.json
  {conductorAgentId}/
    open-questions.yaml
    session-state.yaml
  {conductorAgentId}.tool-calls
  pi/

~/.ensemble/sessions/<repoKey>/  # legacy Issue-session fallback
  {conductorAgentId}.json
  {conductorAgentId}/
    open-questions.yaml
    session-state.yaml
  {conductorAgentId}.tool-calls
  pi/

~/.ensemble/operator-agents/<profile>/watch/github.com/<owner>/<repo>/
  watch-state.json

~/.ensemble/operator-agents/conversations/<operatorAgentId>/
  # 新しい conversation record と provider transcript

~/.ensemble/operator-agent/<repoKey>/  # 旧 watch state の migration source
  watch-state.json

<repoRoot>/.ensemble/sessions/  # project-local Issue-session fallback
<repoRoot>/.ensemble/operator-agent/watch-state.json  # 旧 watch state source
<repoRoot>/.ensemble/pi/sessions/  # Issue data の可能性がある transcript source
```

Pi の conductor transcript は slug 配下の `pi/` に保存します。Pi の project settings や skills などの `ensemble issue` 用 project resources は引き続き `<repoRoot>/.ensemble/pi/` から読みます。Issue session は slug → 現在の `repoRoot` から導ける user path-hash → project-local legacy の順に探します。SessionResumeStore の `repoRoot` は作成時の実行 context として保持しますが、slug の一覧・選択・resume を絞る key にはしません。同じ Issue session を別 clone から再開するとき、保存済み `repoRoot` との不一致だけでは拒否しません。

resume 時の **lazy promotion** は、選択した session を legacy location から読む際に、slug 側にない ResumeStore・YAML・tool-call history・Pi transcript だけを slug 側へ補う処理です。slug に既存 file があればそれを優先し、複数 location の内容は統合しません。fallback source は変更・削除・rename しません。この経路が対象にするのは、その resume で見つけた session と file です。全 user path-hash や他の checkout を列挙する inventory ではなく、operator watch state の profile / slug 移行も担いません。

Issue 用 Git worktree は元 repo に登録され、現行の解決・再利用処理が project-local path を前提とするため、例外として `<repoRoot>/.ensemble/worktrees/issue-N` に残します。配置判断の詳細は [ADR 0044](adr/0044-user-scoped-runtime-storage.md) を参照してください。

同じ Issue session の SessionResumeStore が複数 location に残る場合は slug 側を優先します。新規 session と resume 後の SessionResumeStore / YAML / tool-call history / Pi transcript の flush は slug 側だけに行います。path-hash や project-local の legacy data は自動削除しません。operator TTY の `[harness]` 診断には選択した Store の path と各候補の socket 有無を出します。

### legacy data の一括 inventory / copy

`scripts/migrate-project-ensemble-runtime-to-user.mjs` は、#697 の storage cutover 前に一度実行する一括 migration です。user path-hash に残る Issue session data と旧 operator watch state に加え、operator が列挙した全 checkout の `.ensemble/sessions/`・`.ensemble/pi/sessions/`・`.ensemble/operator-agent/watch-state.json` を inventory にします。resume 時の lazy promotion では届かない別 clone の hash data や、現在再開されない session も対象にできます。既定は dry-run で、manifest を確認してから `--apply` で copy します。

```bash
node scripts/migrate-project-ensemble-runtime-to-user.mjs \
  --checkout-root /path/to/checkout \
  --checkout-root /path/to/another-clone \
  --checkout-roots-complete \
  --profile personal \
  --dry-run

node scripts/migrate-project-ensemble-runtime-to-user.mjs \
  --checkout-root /path/to/checkout \
  --checkout-root /path/to/another-clone \
  --checkout-roots-complete \
  --profile personal \
  --apply
```

`--checkout-root` は対象 checkout ごとに指定し、`--checkout-roots-complete` は列挙が完了していることを operator が明示します。root が 0 件の場合、この flag だけでは完全 inventory とみなされず、manifest に `complete: false` と `<no checkout roots declared>` が残ります。root の網羅性を確認できない場合も flag を付けず、未確認 root を manifest に残してください。各実行は `~/.ensemble/migration/issue-session-migration-<timestamp>-<id>.json` を新規作成します。`--manifest <path>` で出力先を指定できますが、既存 file は上書きしません。

Issue session data は、有効な schema の SessionResumeStore にある `issueUrl` が canonical slug を一意に証明する場合だけ割り当てます。同じ `conductorAgentId` から異なる Issue URL が見つかった場合や、Store / sidecar の schema が不正な場合は成功扱いにせず、source を保全して manifest に unresolved と recovery を記録します。`repoRoot` の一致は条件にしません。Pi transcript は transcript header の session ID と一意な Store evidence が対応する場合だけ copy し、Issue data の可能性を排除できない共有 transcript は source を保全したまま未解決として記録します。

watch state は conductor ごとに cursor・message listener・pending report を bundle 化します。Store の `issueUrl` が一意で、pending report の Issue URL も一致し、`--profile` で operator が移行先 profile を選んだ場合だけ profile / slug 配下へ copy します。根拠不足、破損、または移行先との衝突がある bundle は checksum 付きで `~/.ensemble/operator-agents/legacy/watch/` に保全します。profile を指定しない場合も watch bundle は同じ archive に保全します。

manifest は source / destination、data kind、disposition、source / destination SHA-256、collision / archive の理由、recovery 手順、checkout inventory の完全性と unresolved source を記録します。scan 中に `lstat` / `readdir` などの filesystem error が起きた場合は、`error` に `code`・`errno`・`syscall`・path・message を含め、reason・provenance・recovery とともに `unresolvedSources` に残します。operator が指定した全 root は scan 前に `declaredRoots` へ記録され、未走査 root も abort の原因と recovery を示して残ります。

checkout inventory の `operatorAssertedComplete` は、operator が root 一覧を網羅的と申告したかを示します。`scanCompleted` は migration inventory の scan が最後まで完了したかを示し、`complete` は root が 1 件以上あり、この申告と scan 完了の両方が揃った場合だけ `true` になります。これは全 inventory の状態です。一方、root の `inventoryConfirmed` は operator の網羅申告に加え、その root 自身の scan が unresolved error なく完了したことを表します。したがって scan が途中で fatal error になっても、先に scan を完了した root は確認済みのままです。`unconfirmedRoots` は `inventoryConfirmed: false` の declared root だけを列挙し、global の `scanCompleted` / `complete` とは別です。fatal error の root と未走査 root は未確認として残ります。recoverable filesystem error があって全 scan が終わった場合は `complete: true` になり得ますが、その root は未確認のまま `unconfirmedRoots` に残ります。`unresolvedRoots` / `unresolvedSources` は個別の問題を示すため、あわせて確認してください。project-local source の `provenance.checkoutRootInventoryConfirmed` は、関連 root の `inventoryConfirmed` と同じ値です。`complete` だけで個々の root / source の確認済みとは判断できません。

同じ checksum の destination は no-op とし、異なる destination は上書きしません。source の削除・rename は行いません。旧 operator conversation record とそれに一意に結び付く provider transcript は inventory と migration の対象外です。

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

Issue の Cursor session は、compiled prompt の bootstrap 完了状態を SessionResumeStore の `cursorBootstrapComplete`（boolean）に記録します。値は prompt や event 本文を含まない文脈メタデータです。`false` の状態で `--continue` した場合、失敗した send を復元せず、workflow selector が次に選んだ新しい event に compiled prompt を添えて送ります。古い Store でこの field が欠落している場合は `unknown` とし、旧版では bootstrap の成否にかかわらず記録され得た `cursorBootstrapRunId` から結果を推定しません。対話 TTY では `/recovery bootstrap assume-complete` または `/recovery bootstrap assume-incomplete` の判断が SessionResumeStore に保存されるまで event dispatch を止めます。前者は prompt を追加送信しないため文脈が欠ける可能性を残し、後者は失敗 input を再送せず次の新しい event に prompt を添えるため provider transcript で prompt が重複する可能性を残します。判断を入力できる対話 TTY がなければ `--continue` は backend resume 前に案内付きで停止します。保存した判断は boolean として次回再開にも引き継ぎます。

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

稼働中 harness の UDS method `session.conductor_messages.list` は、bootstrap send を除く成功応答と対応する formatted inbound を最大 100 件、プロセスメモリ内だけに保持します。Cursor の初回 bootstrap が未完了のまま後続 dispatch へ進む場合、実際の send には compiled prompt を付けますが、この local projection には event text だけを記録します。停止後は参照できません。operator-agent tool の `list_conductor_messages` は provider session history から user inbound / final assistant response を再構成し、稼働中・停止後とも直近100件を返します。Cursor では compiled prompt を添えた実際の user turn が inbound に含まれる場合があります。Pi は active branch と entry ID、Cursor は local run history を使い、provider store の retention / deletion を保証しません。最後の応答だけを返す `session.last_conductor_message.get` / `get_last_conductor_message` は従来どおりの単独 projection です。

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
