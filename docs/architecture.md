# アーキテクチャ

> **正本:** `ensemble` の現行技術構成（operator-agent、Cursor SDK / Pi conductor + ACP worker）。利用者向け CLI の入口は [cli/README.md](cli/README.md)、設定の正本は [settings.md](settings.md) と [config.md](config.md) です。

`ensemble` の技術構成。conductor は Cursor SDK（既定）または Pi を選択し、worker は **ACP** で接続する。operator-agent は同じ埋め込み backend を使う独立プロセスで、複数の Issue session を watch pool で監督する。watch は稼働中 harness の UDS snapshot を使い、observe 不能時は SessionResumeStore と YAML に保存された情報を読む。最後の conductor 応答取得など個別の live control は稼働中 harness の UDS を直接使い、停止・接続不能時に保存 snapshot へ fallback しない。複数 worker は **conductor を中心とするスター型**で接続する。

設計の大原則（スター型・Issue 紐づけ・遷移の非機械化など）は [design.md](design.md) を正本とする。本文はプロセス分離と通信経路を記述する。

関連: CONDUCTOR_MODE（`mode-controller` の `conductor` モード）

---

## 1. 目的とスコープ

### 何をするシステムか

手順が明確な GitHub Issue を起点に、**conductor が演奏せず** worker を起動・制御し、作業を進める CLI（`ensemble`）。作業とプロセスは **1 Issue + worktree** に紐づく。

- **最小ユースケース**: `ensemble issue <url>` → worker 起動 → Issue / PR 上で作業
- **backend 選択**: `conductor.backend` は `cursor`（既定）または `pi`。backend によって system prompt・認証・resume の扱いは異なるが、選択後も harness → worker ACP の経路と `ensemble issue <url>` の利用フローは共通（詳細は [ADR 0025](adr/0025-conductor-agent-backend-sdk-and-pi.md)、設定は [settings.md](settings.md)）。
- **スコープ**: 小さな作業単位の Issue ベースフロー
- **対象外（初期）**: 汎用タスクオーケ、IDE 内 Agent の代替

### CONDUCTOR_MODE との関係

| CONDUCTOR_MODE | agents-ensemble |
|----------------|-----------------|
| スコアを深く理解するが演奏しない | conductor プロセスは **実作業ツールを持たない** |
| 理解・判断・指示・検証 | GitHub API / Issue / PR を読み、dispatch・エスカレーション |
| エージェントへ委任 | ACP で **独立 session** の worker |
| 結果を鵜呑みにしない | reviewer 種別の worker + Issue / PR 上の履歴 |

CONDUCTOR_MODE は **行動原則**、agents-ensemble はその **Issue フロー専用の強制版**（プロセス・権限で補強）。

---

## 2. 全体像

### 構造の前提

- **スター型** — 複数の worker が **conductor 1 点**に接続する。worker 同士は直接つながらない。
- **worker は役割を持ち自律的に動く** — 各 session は独立プロセス。Skill に沿って作業する。
- **制御は conductor** — dispatch、permission の自動許諾・拒否・エスカレーションを含め、conductor が worker をコントロールする。
- **共有は Issue / PR** — 作業報告・状態は Issue と PR に記録し、worker 間で共有される（会話履歴は使わない）。
- **作業単位は Issue（+ worktree）** — プロセス全体が 1 Issue（とその worktree）に紐づく。

```
                    worker (implementer)
                           │
                           │ ACP
                           │
    worker (reviewer) ─────┼───── conductor (Cursor SDK / Pi)
                           │         │
                           │         │ GitHub API
                           │         ▼
    worker (librarian) ────┘    Issue ◄──► PR
                                     │
                              worktree（作業ツール）
```

```
┌─────────────────────────────────────────────────────────────┐
│  ensemble CLI (packages/cli)                               │
│  ユーザー入口・引数・終了コード                               │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  conductor (@agents-ensemble/core + Cursor SDK / Pi)           │
│  スター型の中心。長寿命 Agent 1 本                              │
│  ・Issue / PR / CI の読取（GitHub REST / GraphQL）              │
│  ・次の worker 種別の判断（LLM。ルール表は固定しない）          │
│  ・worker の dispatch・制御（種別・Skill・起動文書）            │
│  ・permission の集約（自動許諾含む）→ 必要時に人間へ            │
│  ・実作業ツールは backend 別の ConductorTool adapter で制限     │
└───────┬─────────────────┬─────────────────┬───────────────────┘
        │ spawn           │ spawn           │ spawn
        ▼                 ▼                 ▼
   worker ACP         worker ACP         worker ACP
   (implementer)      (reviewer)         (librarian) …
        │                 │                 │
        └─────────────────┴─────────────────┘
                          │ read / write
                          ▼
              Issue ◄────────────► PR
              worktree（同一 Issue に紐づく作業ツリー）
```

**worker 同士の連携は conductor 経由の dispatch と、Issue / PR 上の記録で行う。**

### Operator 層と Issue セッション

[ADR 0031](adr/0031-operator-agent-layer.md) で合意した **4 層**は次のとおり。複数 session watch と dispatch の役割対応は [ADR 0037](adr/0037-operator-agent-session-watch-and-dispatch.md)、operator-agent の会話 hold は [ADR 0038](adr/0038-operator-agent-conversation-report-hold.md) に記録する。

```
user  →  operator（ロール）  →  conductor  →  workers
```

| 単位 | 実装の置き場 | 説明 |
|------|----------------|------|
| **Issue セッション** | `ensemble issue`（`@agents-ensemble/core` harness） | 1 Issue あたり conductor + workers。スター型は [ADR 0002](adr/0002-star-topology-sdk-conductor-acp-worker.md) のまま |
| **operator ロール** | 人間（SessionView）または **operator-agent** | conductor 群の監督・エスカレーション・横断判断。**誰がロールを実行するか**が設計上の焦点 |
| **operator-agent** | `packages/operator-agent`（[#488](https://github.com/otolab/agents-ensemble/issues/488)） | operator ロールの LLM。**ACP ではなく** conductor 同型の **`ConductorAgent`**（`@cursor/sdk` または Pi）。CLI は `ensemble operator-agent`（TTY） |

**接続密度**: **user ↔ operator-agent は密**（同期対話）。**operator-agent ↔ conductor は疎**（GitHub、`~/.ensemble/sessions/<repoKey>/`、session ごとの UDS control API と provider history）。UDS は Open Question の一覧・回答、watch 用 `session.observe` snapshot、明示的な `operator.message.send`、最後の成功応答、稼働中 process 内の bounded message list を提供します。watch pool は短い UDS request を定期実行し、live observation が使えないときは保存済み snapshot へ切り替えます。一方、Open Question の個別操作、operator message 送信、`get_last_conductor_message` と発言 listen は稼働中 harness へ直接接続し、停止・接続不能時に fallback しません。`get_last_conductor_message` は inbound を含まない最後の1件です。`list_conductor_messages` は provider session history から user inbound と final response の履歴を直近100件まで読み、稼働中・停止後とも使えます。Pi は active branch / assistant entry ID / harness 完了時刻、Cursor は SDK run order / run ID / 作成時刻を使います。失敗・空応答等は除外され、取得不能は error です。listen は `register_conductor_message_listen` / `unregister_conductor_message_listen` で登録し、OQ watch と独立した cursor で稼働中 UDS の新着を通知します。停止後 replay はしません。常時接続や worker への直接指示は行いません（詳細は [稼働中 harness control API reference](live-open-question-control-api.md)）。

operator-agent の `list_operator_sessions` は保存済み SessionResumeStore と状態 YAML を読み、セッションインスタンスごとの statusLine 履歴 / lifecycle で絞り込める。さらに `persisted.harnessPhase` / `modifiedAt`、`live.connectivity`、`posture`、`coherence` を返す。一覧取得時には UDS probe を行わず、watch pool にある直近 10 秒以内の観測だけを使う。watch 未登録・観測期限切れは `live.connectivity: unknown` とし、停止中とは断定しない。`harnessSocketPath` は SessionResumeStore に記録する接続先の索引であり、値があるだけでは harness の稼働確認にならない。watch pool は `session.observe` を使い、UDS 到達不能時は Open Questions YAML / session-state YAML / SessionResumeStore から情報を読みながら、接続失敗を別の live connectivity として保持する。30 秒の継続した到達不能を確認した `running` / `idle` は coherence conflict とする。`list_live_open_questions`、`answer_live_open_question`、`send_operator_message`、`get_last_conductor_message` は同じ path を使う直接 live control であり、停止中・到達不能ならエラーを返して保存済み情報へ fallback しない。`list_conductor_messages` は provider session history を読み、stop / restart 後も直近100件を返す。発言 listen は live UDS polling のみで、保存 snapshot へ fallback しない。listen は個別に読めない oversized message を切り捨てず cursor を進めて警告し、後続の読める発言を報告する。resume 時は `harnessPhase: running` と新しい `modifiedAt` を再開処理より先に保存し、新しい socket path を記録する。

operator ロールは人間が Issue TTY / TUI で直接担う場合と、user との対話を通じて LLM の operator-agent に委ねる場合がある。watch report は質問の追加・回答・一覧消失とその観測根拠を operator-agent に渡し、状況を把握した上で operator として判断できる材料を整える。operator-agent はその状況を user に説明し、判断に必要な情報が欠ける場合は推測せず明示する。

現行の `ensemble issue` では、人間が TTY / CLI 経由で conductor を監督する（プロンプト terms の「オペレータ」）。operator-agent はその **代替・補助の実行者**として足す。Open Question の外部連携（[#481](https://github.com/otolab/agents-ensemble/issues/481)）は operator 層の入出力として扱う。

**Phase 1 の設定・ランタイム**: LLM は **worker の ACP ではなく** `createConductorAgentFactory` 経路（`conductor.backend` / `conductor.model`、認証は [ADR 0028](adr/0028-authentication-delegation-and-ensemble-auth.md) の conductor 席と同経路）。config も conductor 解決を流用。別 `agentId`・operator 用プロンプト／ツール。`ensemble operator-agent` は `~/.ensemble/operator-agent/<repoKey>/session.json` の agent ID を既定で resume し、`/exit` で ID を破棄して次回を新規 session にする。通常の TTY EOF / SIGINT / SIGTERM では backend session を閉じ、ID を保持して再開可能にする。詳細は [ADR 0031](adr/0031-operator-agent-layer.md)。

### レイヤー

| レイヤー | 技術 | 役割 |
|---------|------|------|
| **CLI** | Node.js (`packages/cli`) | コマンド解析、環境、終了処理 |
| **Core** | TypeScript (`packages/core`) | ACP ブリッジ、dispatch、型の共有 |
| **Operator** | `@agents-ensemble/operator-agent` | TTY 対話、operator prompt、複数 session watch pool、稼働中 UDS client、observe 不能時の保存 snapshot polling |
| **Conductor** | `@cursor/sdk` または Pi 1.x (`pi-coding-agent` / `pi-ai`) | 設定された backend による判断・dispatch 制御の主体 |
| **Worker** | `agent acp` | Skill に沿った実作業（種別ごとに起動文書・Skill が異なる） |
| **共有媒体** | GitHub Issue / PR | セッション会話に依存しない状態と履歴 |
| **手順の正本** | Skill（dispatch 先の clone / worktree 上） | worker が読む手順 |

### Conductor harness と operator-agent の対応

operator-agent は ADR 0014 の dispatch 原則を operator 側の報告に適用する。Issue harness 全体を operator-agent に依存させず、ConductorSession には UDS の小さな observation / message handler だけを置く。

| 関心 | Conductor harness（Issue session） | operator-agent（複数 session 横断） |
|------|--------------------------------------|-------------------------------------|
| 対象 | 1 Issue の worker・permission・GitHub event | watch pool に登録した複数 conductor session |
| 入力と queue | `SessionEventQueue` が `SessionEvent` を保持 | operator-agent queue が TTY user input と session / Open Question report を保持 |
| 観測入口 | worker runtime、permission pipeline、GitHub monitor | 稼働中は session UDS `session.observe`、到達不能時は Open Questions YAML・session-state YAML・SessionResumeStore に保存した情報 |
| cursor / 永続化 | session sequence、GitHub monitor cursor、SessionResumeStore | `~/.ensemble/operator-agent/<repoKey>/watch-state.json` に watch 設定・per-session cursor・未 dispatch report を保存 |
| 束ね dispatch | [ADR 0014](adr/0014-conductor-dispatch-batch-coalescing.md) の source key・到着順・優先度で 1 束を 1 `agent.send` | user を最優先、Open Question report、直前 session の一回継続、残り session の到着順で束ねて 1 `agent.send` |
| hold | `set_dispatch_hold` が conductor 向け trigger を保留し `operator.message` を通す | 会話 hold と `set_report_hold` による手動 hold の OR で自動 report を保留し、TTY user input と `operator.message.send` を通す |
| 通信方向 | harness queue から conductor へ送る | harness の UDS から operator-agent へ snapshot を報告し、逆方向の `operator.message.send` は既存 conductor queue に enqueue |
| 実行中 TTY | Issue TUI が `dispatch 保留中（N 件）` を表示 | operator-agent は hold の理由（会話 / 手動）と保留件数を表示 |

監視間隔と debounce は watch ごとに `register_session_watch` の `pollIntervalMs` / `debounceMs` で設定する。session ごとの UDS path が記録されているだけでは稼働中と判断せず、接続できた snapshot を live Registry observation として扱う。watch に cursor がない場合、最初の snapshot を通知なしで baseline に記録する。その後は新しく加わった `status: open` の質問に加え、既知の質問の `open → answered` と、前回 open だった ID が snapshot から消えた変化を検知する。回答済み遷移では question ID・質問・取得できた answer / assent / selectedChoice・`answeredBy`・`answeredAt` を報告する。`answeredBy: operator` は operator ロールでの記録を示すが、人間と operator-agent のどちらが操作したかまでは示さない。`answeredBy: conductor` は conductor 側の操作を示す。単に一覧から消えた場合は解決や回答者を推測せず、消失として報告する。追加・回答・消失が同じ poll で観測された場合、質問 ID 順の番号付き report とし、同じ ID の回答済み遷移を新規追加に重ねて数えない。同じ質問の後続 YAML flush は per-session cursor で重複排除する。UDS が使えない間は `open-questions.yaml` と session-state YAML を poll するため、停止中セッションの変更も次回 poll で取り込む。Open Question report は `open_question:${conductorAgentId}` source key で既存 queue の batching / hold を通り、本文には対象 Issue と session ID、観測元を付ける。poll cursor と未 dispatch report は operator-agent state に保存するため、operator-agent の再起動後は未送信 report を queue に戻す。

TTY user input が始まると自動の会話 hold が有効になり、watch polling を続けながら report dispatch を保留する。operator の応答が `finished` / `completed` で戻り、次の user input が queue に無い場合に自動解除する。連続入力が queue に残る間は hold を維持し、`/resume-watch` は会話 hold だけを手動解除する。手動 report hold と会話 hold は独立しており、いずれかが有効なら保留する。

`~/.ensemble/operator-agent/<repoKey>/watch-state.json` が無い場合、watch pool は空 state で起動し、登録済み watch・cursor・未 dispatch report は失われます。監視再開には watch の再登録が必要です。最初の successful snapshot は Open Question cursor に限って既存 OQ ID の silent baseline となり、その時点までに追加された質問は通知として replay されません。一方、session-state は独立した `reportedAt` cursor で判定するため、初回 poll でも snapshot に状態があれば最新 status を報告することがあります。JSON / schema が不正なら初期化は失敗し、state を空へリセットしません。復旧手順は [稼働中 harness control API reference](live-open-question-control-api.md#operator-agent-watch-state-の欠損破損と復旧) を参照してください。手動・会話 report hold は永続化されず、再起動後はどちらも解除状態です。

watch report を含む `agent.send` は `finished` / `completed` のときだけ成功として acknowledge し、永続 pending から削除する。`cancelled`、`error`、その他完了を確認できない status では report を同じ ID で遅延再 queue し、再起動後も pending から復元する。送信成功後・ack 永続化前の終了では再送と重複が起こりうるため at-least-once であり、受け手は対象 session の現在状態を確認する（設計判断は [ADR 0037](adr/0037-operator-agent-session-watch-and-dispatch.md)、[ADR 0038](adr/0038-operator-agent-conversation-report-hold.md)）。

Issue harness 側では `session.observe` が全 Open Question と sequence、完了済み `report_session_state` の保存値を返す。`operator.message.send` は通常の operator message として既存 queue に入り、`{ queued: true, delivery }` は queue 受付を示す。dispatch 完了 ack ではない。`delivery` は `idle | next | interrupt` で、省略時は `next`（詳細は [Issue #525](https://github.com/otolab/agents-ensemble/issues/525)）。

repo 単位のランタイム状態は `resolveEnsemblePaths({ repoRoot })` が決める repoKey（正規化した絶対 repoRoot の SHA-256）を使い、`~/.ensemble/sessions/<repoKey>/` と `~/.ensemble/operator-agent/<repoKey>/` に保存する。project `.ensemble/` には team profile、repo config、Pi project resources が残ります。isolated Git worktree は元 repo に登録され、現行の解決・再利用処理が project-local path を前提とするため `.ensemble/worktrees/issue-N` に置きます（[ADR 0044](adr/0044-user-scoped-runtime-storage.md)）。

---

## 3. Conductor（SDK / Pi）

conductor の LLM backend は Cursor SDK と Pi 1.x (`createAgentSession`) から起動時に選択できます。既定は Cursor SDK で、両 backend とも同じ harness / worker ACP 経路を使います。方針の記録は [ADR 0025](adr/0025-conductor-agent-backend-sdk-and-pi.md)（**proposed**）を参照してください。

### 責務

1. **状態把握** — Issue コメント、PR、CI、ラベル等（GitHub REST / GraphQL API）
2. **遷移判断** — 次にどの worker 種別を起動するか、人間へ聞くか（**機械ルール表に固定しない**）
3. **dispatch・制御** — worker を起動し、実行中も permission 応答等で制御する（自動許諾ポリシーを含む）
4. **承認集約** — 各 worker の `session/request_permission` を conductor が受け、ポリシー or 人間へ
5. **エスカレーション** — 判断不能・マージ前等をユーザーへ（CLI 問い合わせ）

### 演奏しないことの担保

| 手段 | 内容 |
|------|------|
| `mode: "agent"` | SDK 実行モード（[adr/0006-conductor-agent-mode.md](adr/0006-conductor-agent-mode.md)）。振る舞いの正本は下記プロンプト / materials |
| `customTools` | conductor 用: `ask_human`, `answer_open_question`, `list_open_questions`, `get_open_question`, `resolve_permission`, `register_github_watch`, `unregister_github_watch`, `report_session_state`。最後の tool は 80 文字以内の状態一文と報告時刻をセッションごとの `session-state.yaml` に atomic 保存し、その場で結果も返す。worker は profile に登録され、ACP attach は eager または初回 `prompt_worker` 時 |
| プロンプト / materials | PromptModule と profile materials で指揮専任・委任方針を明示（conductor の正本） |

conductor は **理解と dispatch に専念**し、ファイル編集・テスト実行は worker の domain とする。

**agents-ensemble リポジトリに `.cursor/` は置かない。** 開発用 IDE 設定と混同し、hooks がローカル作業を阻害する。conductor / worker のツール方針はコードと起動オプションで与える。

### modular-prompt と SDK の分担

| レイヤ | 役割 |
|--------|------|
| **modular-prompt** | conductor の **system prompt 文**（persona / guidelines / materials）。`compile` → 初回または reload 時に適用 |
| **`agent.send(message)`** | 会話への **user ターン 1 本**。オペレータ発話・自律ターンの状態通知 |
| **SDK 会話** | LLM 会話履歴の正本 |

Conductor backend は、**SDK では compiled prompt を初回 user send に渡し、Pi では native system 受け口へ渡す**。Pi の初回 user send は Issue URL を含む短い kickoff です。

worker（ACP）は `session/prompt` でターン更新全体を渡す。conductor（SDK）は **`send` = user 行の append** であり、毎ターン CompiledPrompt 相当を渡すモデルではない。

### SDK の使い方（想定）

```typescript
// apiKey 省略時は SDK が CURSOR_API_KEY → ~/.cursor/sdk/auth.json の順で解決
// model 省略時は resolveConductorModelId() → default（Auto）
await using conductor = await Agent.create({
  model: { id: "default" },
  mode: "agent",
  local: {
    cwd: orchestratorWorkspace,
    customTools: { ask_human, answer_open_question, list_open_questions, get_open_question, resolve_permission, register_github_watch, unregister_github_watch, report_session_state },
  },
});

// 初回: modular-prompt で組み立てた system prompt + Issue 初回ブリーフィング
await conductor.send(buildConductorSessionStart(context));

// 以降: オペレータ発話は user ターンとして直接送る
await conductor.send(operatorMessage);

// 自律ターン: worker 状態など短い user 通知（設計は #28 参照）
await conductor.send(workerStatusUpdate);
```

`runConductorSession` は `<repoRoot>/.agents/mcp.json` と `~/.ensemble/mcp.json` を user → project の順で解決し、backend 中立な同じ `mcpServers` map を conductor factory に渡す。Cursor SDK はそれを `Agent.create` / `Agent.resume` のトップレベル inline MCP として使い、Pi は `.ensemble/pi` の `settings.json` / `auth.json` / `models.json` / `extensions/` / `skills/` / `prompts/` / `themes/` を user → project で解決したうえで、Pi 1.x の `DefaultResourceLoader` に `createMcpExtension({ loadConfig })` を登録し、`createAgentSession` へ注入する。Pi へ渡す直前に Cursor 形式の `${env:VAR}` / `${workspaceFolder}` placeholder を conductor cwd / process environment へ解決する。SessionResumeStore には canonical MCP map digest を保存し、resume 時に現在の digest と比較して変更を fail fast する（digest に秘密値は保存しない）。Pi の自前 MCP client / transport は持たず、接続・tool discovery・OAuth・resource tools は公式 extension に委ねる。Pi は stdio / Streamable HTTP を使え、SSE は未対応である。Pi の settings.json は `pi-headless-settings.ts` のコード正本にある対応キーだけを参照し、`.ensemble/pi` の user → project deep merge 結果をチャネル別に適用する。`SettingsManager` は in-memory で作り、Pi 標準の `<cwd>/.pi/settings.json` を読み込まない。`compaction.*` / `branchSummary.*` は create 時と resume 時に適用し、reload 後は起動時スナップショットを再適用する。reload または snapshot 復元に失敗した session は close / dispose して unusable とし、cleanup が成功した単一の元エラーはそのまま返すが、元エラーと cleanup error が併発した場合は `AggregateError.errors` に両方を含めて返す。失敗後は再利用せず resume/create する。`sessionDir` は無視し、transcript は harness の `~/.ensemble/sessions/<repoKey>/pi/` に保存する。thinking・package・TUI など未対応キーは無視する。Pi の skills は `DefaultResourceLoader` で索引し、system prompt にカタログを載せる（`profile.conductor.piSkills`、省略時は有効）。prompts は headless user prompt の `/name args` 展開へ接続する。themes は JSON resource として解決するが、conductor に TUI renderer はないため表示へ適用しない。Pi では compiled modular prompt を native system prompt として使い、resource root の `SYSTEM.md` / `APPEND_SYSTEM.md` は読み込まない。`local.settingSources` や Pi の `.pi/mcp.json` への同期は行わず、resume 時も同じチャネル適用を行う。MCP 設定は conductor 専用で、ACP worker の `session/new` には渡さない。

**Conductor backend にチャット UI はない。** CLI（TTY）では Ink TUI（`createIssueSessionTuiHost`）が非ブロッキング入力と `pane` / `stream` レイアウト表示を担い、`submitOperatorInput` 経由で `operator.message` をキューへ積む。非 TTY は `bindAsyncOperatorInput` / CLI 初回メッセージ / `ENSEMBLE_OPERATOR_MESSAGE`。ConductorSession はキューから dispatch するだけ。テストは `bindOperatorInput` にフェイクを渡す（`createTestOperatorInputBinding`）。ConductorSession がイベント列経由で backend の agent に渡す（[ADR 0008](adr/0008-human-dialogue-open-questions.md)、[ADR 0009](adr/0009-conductor-session-event-queue.md)）。**観測と表示の分離**（TUI / stdout 対話 / stderr harness / 終了 JSON）は [session-logging.md](session-logging.md)。

`stream` の settled columns shrink は端末の physical reflow と Ink の論理フレームを再同期するため、保持済み activity history を replay する recovery transaction を持つ（[ADR 0026](adr/0026-tui-stream-shrink-recovery.md)）。通常の native scrollback / `alternateScreen: false` モデルと `pane` の bounded activity window は維持する。

Cursor conductor の初回セットアップは `ensemble auth login`（`Cursor.auth.login()` 相当）です。Pi conductor も同じ CLI を backend 分岐付きで使え、`ensemble auth login --provider <id>` は Pi 1.x の `ModelRuntime` に API key または OAuth credential を保存します。Pi の project `auth.json` は読取専用の優先層で、login の書込み先は `~/.ensemble/pi/auth.json` または `conductor.pi.agentDir` の user 層です。project 層の明示的な OAuth credential は refresh 経路を持たないため実行時に拒否し、OAuth は user 層の runtime へ保存します。MCP HTTP OAuth は Pi の MCP extension が別の credential store と対話フローで管理します。`ensemble auth status` / `ensemble models list` は選択 backend の認証・モデルを表示します。worker の ACP は `agent login` で足ります。

- **長寿命**: 1 Issue あたり 1 conductor session（`agent.send` でターンを重ねる）
- **resume**: 別プロセスから backend 固有の `resume(conductorAgentId)` で再開可能。Cursor は SDK の session、Pi は SessionResumeStore に記録された `conductorAgentId` を Pi session id として `~/.ensemble/sessions/<repoKey>/pi/` の JSONL transcript を復元する。harness の SessionResumeStore（`~/.ensemble/sessions/<repoKey>/{conductorAgentId}.json`）には profile・worker `acpSessionId`・MCP map digest・teardown lifecycle・`harnessPhase` / `modifiedAt` を保存し、OpenQuestionRegistry のスナップショットは `~/.ensemble/sessions/<repoKey>/{conductorAgentId}/open-questions.yaml` に保存する。`running` / `idle` は conductor send と worker prompt の in-flight から記録し、terminal phase（`close` / `abort` / `exit`）は後続 flush で上書きしない。`modifiedAt` と `updatedAt` は harness による SessionResumeStore 保存時刻に揃える。operator status の最新報告と最大 50 件の履歴（状態 YAML は最大 16 KiB）は `~/.ensemble/sessions/<repoKey>/{conductorAgentId}/session-state.yaml` に保存し、statusLine の `reportedAt` は別の時刻として扱う。resume 時は conductor 再開処理の前に `running` と新しい `modifiedAt` を保存する。YAML の質問一覧を優先し、YAML がない既存セッションは SessionResumeStore から復元して YAML を生成する。移行期間中は両方に同一内容を保存する。worker の累積 tool-call snapshot は別ファイル（`~/.ensemble/sessions/<repoKey>/{conductorAgentId}.tool-calls`）に保存し、resume 時は stable worker name で新しい runtime `workerId` に結び直して ACP `sessionId` を保持する。tool-call history の欠損・破損は resume を妨げない。保持期限と上限は [harness-events.md](harness-events.md) を参照。resume 時に backend または MCP map が起動時の解決結果と SessionResumeStore の値から変わっていれば fail fast する（[ADR 0011](adr/0011-session-sidecar-resume.md)、[ADR 0025](adr/0025-conductor-agent-backend-sdk-and-pi.md)、[ADR 0031](adr/0031-operator-agent-layer.md)、[ADR 0032](adr/0032-tool-call-snapshot-history.md)、[ADR 0039](adr/0039-session-resume-state-and-operator-projection.md)、[session-logging.md](session-logging.md#4-sessionresumestore-と-open-question-yaml)）。
- **live harness control**: `runConductorSession` はセッションごとの UDS listener を所有し、接続先の path を SessionResumeStore の `harnessSocketPath` に記録する。socket は短い owner-only runtime directory に置く。回答状態の正本は Open Questions YAML で、SessionResumeStore 内の JSON は mirror として更新する。operator message は event queue で扱い、回答 YAML には保存しない。shutdown 時は受理済み request を最大 5 秒 drain し、期限超過時は driver を abort する。API の schema、ack/error、security と運用手順は [live harness control API reference](live-open-question-control-api.md)、設計判断は [ADR 0033](adr/0033-live-open-question-control-uds.md)、[ADR 0035](adr/0035-open-question-shutdown-commit-order.md)、[ADR 0036](adr/0036-live-open-question-answer-contract.md) を参照。
- **ripgrep**: local agent の ignore scan 用。`ConductorAgent` 起動前に `ensureCursorSdkRipgrepPath()` が `@cursor/sdk-<platform>-<arch>/bin/rg` または PATH の `rg` を `CURSOR_RIPGREP_PATH` に設定する（[#43](https://github.com/otolab/agents-ensemble/issues/43)）。設定の利用者向け入口は [settings.md](settings.md) のランタイム設定を参照してください。
- **proxy**: `ConductorAgent` 起動前に `ensureCursorSdkProxy()` が Cursor の `settings.json` を読み、フラット形式の `http.proxy` / `http.noProxy` を `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` へ不足分だけ反映する。ネスト形式も互換入力として扱うが、両方に同じ設定がある場合はフラット形式を優先する。解決順は既存の環境変数 → Cursor settings → 未設定で、標準パスは macOS / Linux / Windows ごとに異なる。`cursor.general.disableHttp2: true` は SDK の `local.useHttp1ForAgent: true` に変換する。`http.proxyStrictSSL` と `http.proxySupport: "override"` は SDK に対応する公開設定がなく未対応。設定の利用者向け入口は [settings.md](settings.md) のランタイム設定を参照してください。

### conductor が読む入力

| 入力 | 必須 | 説明 |
|------|------|------|
| Issue / PR | ○ | 事実・履歴の正本 |
| 作業 Skill | ○ | worker が実行する手順（参照用に conductor も知る） |
| 作業基準文書 | 任意 | フロー / Issue ごとの自然言語メモ（形式固定しない） |
| `SCORE_*.md` 等 | 任意 | conductor の理解メモ（CONDUCTOR_MODE の SCORE 相当） |

**WORKFLOW ファイルのスキーマは固定しない**（[design.md](design.md)）。状態は Issue / PR と conductor の判断材料に分散する。

---

## 4. Worker（ACP）

conductor が制御する実行単位。**種別（kind）** によって読む Skill と起動時のシステムプロンプトが変わる。各 worker は **独立 session で自律的に** Skill に沿って動く。team profile（`profiles/`）が種別ごとの定義を返す。

| 種別（例） | 役割の例 |
|-----------|---------|
| **implementer** | 実装・Issue 更新・PR・対応 |
| **reviewer** | 独立検証（コンテキスト 0） |
| **librarian** | ドキュメント整備・所在調査 |

種別は固定列挙にしない。プロファイルが **Skill 名** と **worker 用システムプロンプト（起動文書）** を conductor に渡し、dispatch 時に worker へ与える。

### なぜ ACP か

| 要件 | SDK サブ | ACP（タスク単位 spawn） |
|------|---------|-------------------------|
| 親会話からの分離 | 弱い | **session 独立** |
| Skill 追加直後の反映 | `reload` + 再 spawn | **新プロセスで再発見** |
| permission の仲介 | ほぼ不可 | **conductor がクライアント** |
| reviewer のコンテキスト 0 | 難しい | 新 session + 種別用起動文書のみ |

### 起動パターン

`session.lazyWorkers`（既定 `false`）で attach 時期を選ぶ。どちらの設定でも profile worker はセッション開始時に登録され、worktree は harness が解決する。

- **eager（既定）**: セッション開始時に各 worker について ACP process を spawn し、attach / init prompt を実行する。
- **lazy**: profile 名と kind を登録し、初期状態を `sleeping` とする。対象への通常の初回 `prompt_worker` が ACP attach / init prompt を始め、その init prompt が終わってから元の instruction を別の `session/prompt` ラウンドとして送る。専用 wake 操作はない。

実際の attach 時:

1. `spawn(command, args, { cwd, env, ... })` — **ツール・環境は起動オプションで明示**（既定は `agent acp` = preset `cursor`）
2. JSON-RPC: `initialize` → `authenticate` → `session/new`（または SessionResumeStore に記録された ACP session ID を使う `session/load`）
3. `session/prompt` に **種別用起動プロンプト** + Skill 名 / Issue URL（resume では resume prompt）
4. `session/update` を conductor が購読（進捗）
5. `session/request_permission` → conductor が応答
6. init 完了後は ACP session を保持し、後続 `prompt_worker` を同じ session に送る。終了時に bridge を閉じる。

lazy mode の初回 instruction は init prompt と別ラウンドにする。これにより `source: harness` の init と `source: conductor` の指示が区別され、各 `worker.round` と prompt lifecycle event の対称性を維持する。初回 instruction は init / permission 待ちの間 runtime queue に保持する。

`list_workers` / `get_worker_status` は登録済み worker 全員を返し、runtime state `sleeping` は未 attach、`idle` は attach 済みで prompt を実行していない状態を表す。TUI は `sleep` / `idle` と表示を分ける。resume は SessionResumeStore の attach policy を復元し、ACP session ID を持つ worker だけを先に `session/load` する。未使用 worker は sleeping のまま。旧 SessionResumeStore に policy がない場合は eager とする。

worker は **agents-ensemble の `.cursor/` を読まない**。Skill 名と起動文書は conductor が与え、手順の正本は dispatch 先の worktree（`cwd`）上の Skill ファイルとする。

| 種別 | Issue worktree | ACP cwd（`workers[].workspace`） | 備考 |
|------|----------------|----------------------------------|------|
| **implementer** | 作成・共有（規約） | 省略時は Issue worktree | 実装作業の主役 |
| **reviewer** | 既存に参加 | 省略時は Issue worktree | レビュー Skill |
| **librarian** | Issue worktree（正本は Issue） | 別 repo を指定可 | ドキュメント整備等 |

起動プロンプトのパターン例は [prompts/worker-bootstrap.md](prompts/worker-bootstrap.md)。**どの種別をいつ dispatch するか、どの Skill・起動文書を渡すかはプロファイルが決める。** profile の `workers[].workspace` で worker ごとに ACP cwd を上書きできる（[elements.md](elements.md)）。

### Worker の前提

- **自律実行** — session 内では Skill に沿って自走する。worker 同士は直接通信しない
- **Issue / PR に報告** — 作業報告・状態は Issue コメント / PR に書き、他 worker が読む
- **Issue worktree に紐づく** — implementer は worktree を作成し、**未指定 worker** は同じ Issue worktree を ACP cwd として共有する（規約）
- **per-worker ACP cwd** — profile の `workers[].workspace` で worker ごとに ACP の cwd を上書き可能（Issue worktree とは別。外部 repo では isolated worktree を自動作成しない）
- **worker ACP spawn** — 正本は ensemble config の `acp.defaultPreset` / `acp.env`（[config.md](config.md)）。team profile に ACP はない。preset 解決: CLI `--default-acp-*` / `ENSEMBLE_DEFAULT_ACP_CLI` / config `acp.defaultPreset`（[settings.md](settings.md)、[ADR 0019](adr/0019-worker-acp-cli-presets.md)）
- **worktree のライフサイクル** — isolated モードではセッション開始時に `.ensemble/worktrees/issue-N` を作成（既存なら再利用）。TTY + post-loop の `/exit` 正常終了時は cleanup を試み、未コミット変更がある場合は削除を拒否する。`/close` は attach 済み worker ACP session ID / cwd を runtime から snapshot し、初回 prompt が完了イベントを出す前でも SessionResumeStore に再開情報を残す。monitor の pending outbox を含む SessionResumeStore を best effort で flush してから worker / conductor を force teardown し、usage cost collection を待たずに TTY プロセスを正常終了（exit 0）する。worktree cleanup は行わず、同じ Issue の `--continue` では `issueUrl` と `repoRoot` から worktree を再導出して再利用する（[ADR 0030](adr/0030-tty-close-lifecycle.md)）。`in-repo` では削除しない。ローカルブランチ `ensemble/issue-N` は残す
- **新規 worktree のベース** — 可能なら `git fetch` 後の `origin` デフォルトブランチ（`origin/HEAD` または `main`）から `ensemble/issue-N` を切る。remote なし・fetch 失敗時はローカル HEAD にフォールバック
- 手順は **Skill が正本**（`SKILL.md`、必要なら `CASE_STUDIES.md`）— worktree の `cwd` から解決
- ツール可否・MCP 等は **`spawn` / `session/new` のオプションで明示**
- description 本文は checkbox の check 以外は基本触らない

---

## 5. 承認フロー・worker 制御・オペレータ対話

### 双方向フロー（常駐 worker・数往復）

[ADR 0012](adr/0012-conductor-worker-prompt-roundtrip.md) を参照。

```
セッション開始 ──登録──► worker roster ──lazyWorkers=true──► sleeping（ACP 未起動）
eager または初回 prompt_worker ──attach / init──► worker 常駐（agent acp プロセス + ACP session）
conductor ──prompt_worker──► WorkerOutboundQueue ──sendWorkerMessage──► 初回は attach / init 後に instruction、以降 session/prompt
conductor ──list_workers / get_worker_status──► WorkerRuntime（読み取り専用・イベント列に積まない）
conductor ──register/unregister_github_watch──► GitHubMonitor cursor（明示 PR watch）──► 即時 bootstrap poll（register 時）
conductor ──get_session_usage / get_usage──────► SessionUsageTracker（読み取り専用・イベント列に積まない）
worker    ──permission──────► ConductorInbox ──► SessionEventQueue ──► agent.send
worker    ──Issue / PR 報告──► （非同期正本。harness 非経由）
worker    ──ラウンド終了──────► worker.completed ──► SessionEventQueue ──► agent.send
ensemble 終了 ──stop────────► 全 worker bridge close
```

- GitHub monitor は Search で後から初めて見つけた PR にも CI bootstrap を適用する。CI は GraphQL の CheckRun `checkSuite.commit.oid` / StatusContext `commit.oid` を使って check を commit SHA ごとに集約し、SessionResumeStore の `lastAggregateBySha[sha]` に `running` / `failed` / `completed` を保存する。集約状態が変わったときだけ既存 kind `ci.completed` を通知し、SHA を解決できない check は除外する。status poll が失敗した場合は `ciBootstrapPending` を保存し、次回の成功まで初期化を完了扱いにしない
- **常駐** = ensemble 中 `agent acp` プロセスを殺さない（attach / init prompt 後も bridge 保持）。
- **sendWorkerMessage** = 既存 session への `session/prompt`（dispatch ではない）。
- **worker 登録と attach** = profile worker 名はセッション開始時にすべて登録される。`session.lazyWorkers: true` のとき sleeping worker への通常の初回 `prompt_worker` が attach / init を起動し、init 後に instruction を送る。起動済み worker はセッション終了まで常駐する。
- **`list_workers` / `get_worker_status`** = harness 上の worker 状態照会（読み取り専用）。`prompt_worker` は作業指示専用。オペレータの状態質問には状態照会ツールを使い、Issue / PR を読まず tool 結果で答える。返却は YAML。セッションイベント列には積まない（[Issue #70](https://github.com/otolab/agents-ensemble/issues/70)）。
- **`get_session_usage` / `get_usage`** = harness が蓄積した LLM トークン使用量照会（読み取り専用）。conductor 各 backend の agent send、worker 各 prompt は usage（無い場合は prompt/response から推定、`source: estimated`）を使う。コンテキスト上限は SDK 1.0.27 時点で取得不可のため既定は `limit: null`（[Issue #102](https://github.com/otolab/agents-ensemble/issues/102)）。返却は YAML。イベント列には積まない。
- 同一 worker は ACP 制約により prompt **直列**（per-worker キュー）。worker 間は並行可。
- **`worker.completed` は 1 ラウンドの終了**。進捗の正本は Issue / PR。

### permission（conductor 制御）

```
worker (ACP)                    conductor (Cursor SDK / Pi)  オペレータ
     │                               │                          │
     │ session/request_permission    │                          │
     │ ─────────────────────────────>│  段1: policy 自明 allow/deny → 即応答
     │                               │  段2: pending → イベント列 + resolve_permission
     │                               │  段3: 要確認 → ask_human（登録のみ・非ブロック）
     │                               │         OpenQuestionRegistry に enqueue
     │                               │  operator.message（任意タイミング）◄──────│
     │                               │  （選択中への回答 or 自由チャット）          │
     │                               │  answer_open_question（チャット済み代行記録）│
     │                               │  resolve_permission                      │
     │ permission response           │                          │
     │ <─────────────────────────────│                          │
```

- **worker → ユーザー直結はしない**。人間への出口は conductor 経由のみ（[ADR 0007](adr/0007-permission-pipeline.md)、pending 通知は [ADR 0010](adr/0010-permission-pending-event-delivery.md)）。ACP request に options がある場合、応答は承認／拒否の `kind` に対応する backend の `optionId` を選ぶ。options が無い／不明な場合は legacy fallback を使う
- **段1 自明許可** — `PermissionPipeline` + policy（read-only allowlist 等）
- **段2 conductor** — 非自明は pending。`resolve_permission` で allow/deny。**init prompt ラウンド中でも同様**（完了を待ってから処理しない — [ADR 0016](adr/0016-bootstrap-permission-conductor-wait.md)）
- **段3 human** — conductor が `ask_human` で **質問を登録**（非ブロッキング）。オペレータ回答は **別ターンのチャット入力**（[ADR 0008](adr/0008-human-dialogue-open-questions.md)）
- 並列 worker 時は request id / workerId で correlation
- conductor は harness 状態を **ポーリング待機してはならない**（外部 `Await` 等）。変化は `SessionEventQueue` のみが通知する（[ADR 0016](adr/0016-bootstrap-permission-conductor-wait.md)）。worker prompt ライフサイクルは [harness-events.md](harness-events.md) §2.2（#133: bootstrap 廃止・`source` 統一）

### オペレータ対話（watch、open question、メッセージ）

Issue session 内で worker に指示し、ユーザへ結果を返す agent は引き続き **conductor**。operator-agent は稼働中 harness の session UDS を介して Open Question の一覧取得・回答、watch 用 snapshot の取得、明示的な outbound `operator.message.send` の送信、最後の conductor 成功応答の読み取りを行う。watch pool は `session.observe` が使えないと保存済み YAML / SessionResumeStore の情報を読むが、最後の応答取得など個別の live control は停止・接続不能時にエラーとなり、保存済み情報へ fallback しない。Open Question 回答は回答 API で記録し、通常 message は回答から独立した既存 operator message queue に入り、operator-agent が worker を直接 dispatch することはない。

| レイヤ | 役割 |
|--------|------|
| **modular-prompt** | system prompt 文（指揮方針・materials） |
| **オペレータメッセージ** | `agent.send` の user ターン（CLI TTY / CLI 初回引数 / `ENSEMBLE_OPERATOR_MESSAGE` / operator-agent UDS） |
| **OpenQuestionRegistry** | TODO リスト（`inq-N`）。tool で読む |
| **UDS control API** | Open Question の一覧・回答、watch 用 `session.observe` snapshot、`operator.message.send`、`session.last_conductor_message.get`、`session.conductor_messages.list` を扱う。回答と message は独立し、message は既存 `submitOperatorInput` 経由で event queue に入る |
| **SDK 会話** | LLM 会話履歴の正本（オペレータ発話・tool 結果を含む） |

**ツール使い分け**

| 状況 | tool |
|------|------|
| まだ答えていない | `ask_human`（登録のみ） |
| チャットですでに答えている | `answer_open_question` |
| 一覧・詳細が必要 | `list_open_questions` / `get_open_question` |
| permission 判断 | `resolve_permission`（要確認時は open question を先に処理） |

`ask_human` の `responseType` は `text`、`yes_no`、`choice` を指定できます。`yes_no` の回答は全文を保持し、共通パーサーの結果を `assent: yes | no | unclear` として記録します。`approved` は `relatedPermissionId` を持つ `yes_no` に限り、`yes` / `no` から導出します。`choice` は `choices: [{ id, label }]` を回答候補として登録します。オペレータは候補以外の自由記述でも回答でき、回答全文は常に保存されます。ID / 一意な label / 1 始まり番号で一意に解決できた場合だけ option id を `selectedChoice` に記録し、重複 label など曖昧な入力は自由記述として扱います。conductor が `answer_open_question` で代行記録する場合も、候補に解決できない回答を自由記述として記録できます。

稼働中 harness は Open Question の live list / answer、watch pool 用 `session.observe` snapshot、`operator.message.send`、`session.last_conductor_message.get`、`session.conductor_messages.list` を UDS で提供します。operator-agent は SessionResumeStore から path を得て live control client として接続します。`get_last_conductor_message` は最後の成功応答だけを返します。operator-agent の `list_conductor_messages` は UDS の list method ではなく、SessionResumeStore から backend / cwd を読み provider session history を再構成します。履歴は直近100件で、Pi では `sendCount` / `dispatchSource`、Cursor では run ID / `requestId` が provider ごとの識別情報です。発言 listen は独立した cursor で新しい発言を polling します。watch pool は observe の接続失敗や旧 harness での未対応時に保存 snapshot へ fallback します。個別の live control と発言 listen は停止・接続不能時にエラーとなり、fallback しません。通常 message は Open Question の回答として記録されず、watch snapshot の取得とも独立しています。wire format、request/result schema、回答 acknowledgement と `{ queued: true, delivery }` response、停止時の unknown outcome、security / privacy は [live harness control API reference](live-open-question-control-api.md) を参照してください。

オペレータメッセージは `delivery: 'idle' | 'next' | 'interrupt'` を指定でき、省略時は `next` です。TTY は `/idle ...` / `/next ...` / `/interrupt ...` prefix、operator-agent は `send_operator_message` tool から指定します。`idle` は実行中 worker や送信可能な自律イベントの処理が落ち着くまでキューに残り、post-loop でも Driver が送ります。max-turns 後も operator message は送信可能で、dispatch hold は配送可能になった operator message を保留しません。`interrupt` は backend の run cancel を試し、失敗時は `next` と同じ次回 dispatch に戻ります（[#86](https://github.com/otolab/agents-ensemble/issues/86)）。

**ConductorSession ループ**（[ADR 0009](adr/0009-conductor-session-event-queue.md)）

Driver / Policy / View の 3 層（Issue #62）:

| 層 | 責務 | モジュール |
|----|------|------------|
| **SessionPolicy** | `canDispatchConductorSend`, `shouldStopIssueLoop`, `autonomousTurnsAfterConductorSend` / `autonomousTurnsAfterConductorBatch` | `session-policy.ts` |
| **SessionDriver** | イベントキュー消費・max-turns 登録・`agent.send` 呼び出し | `conductor-session-driver.ts` |
| **SessionView** | TTY Ink TUI / CLI 初回引数 / `ENSEMBLE_OPERATOR_MESSAGE` | CLI `createIssueSessionTuiHost` / `bindAsyncOperatorInput`（[operator-input.md](operator-input.md)） |

```
operator (View) ──submit──► operator.message ──► SessionEventQueue
                                                      │
worker / harness ──enqueue──►─────────────────────────┤
                                                      ▼
                                            SessionDriver (ループ)
                                                      │
                                            SessionPolicy (dispatch / stop)
                                                      ▼
                                              conductor.agent.send
```

- `WorkerSession` / `ConductorSession` が対。worker 由来・operator 由来のイベントは **1 本の列** に集約し、[ADR 0014](adr/0014-conductor-dispatch-batch-coalescing.md) に従い **1 束 = 1 `agent.send`**（束は 1 件のこともある。新規セッションの初回のみ system + ブリーフィング）
- **resume の初回 dispatch**: backend の `resume(conductorAgentId)` が conductor transcript を復元するため、`--continue` / `--resume` では新規セッション用の initial send を行わない。Pi は毎回 compiled `systemPrompt` を再コンパイルして native system prompt に設定する。`WorkerSession` の attach 中に到着した `permission.pending` や `worker.completed` は `SessionEventQueue` に残り、復元後の最初のイベント束として SessionDriver が dispatch する。SessionResumeStore に driver のターン状態は保存せず、再起動時のカウンタは 0 から始める。
- **permission cleanup と dispatch**: worker failure / teardown で `PermissionPipeline.pending` から除去された requestId の `permission.pending` は、SessionDriver が dispatch 直前に queue と dispatch-hold の held buffer から prune する。live な pending は通常どおり dispatch し、cleanup の順序と対象は `permission.cleanup` の SessionLogEvent に残す。
- **permission 停滞通知と優先度**: `permissionDeadlockStallMs` の既定値は `300_000ms`（300s、poll 間隔は従来の `5_000ms`）。閾値到達時は operator 向け `harness.warning` を維持し、conductor 向け `permission.stall` を同じ `SessionEventQueue` に同一停滞エピソードで 1 回だけ載せる。`operator.message` / `permission.pending` を先に選び、`permission.stall` は低優先度として後段に置く。max-turns 到達後も permission 回復用の例外として dispatch できるが、worker UI は更新しない。詳細は [ADR 0027](adr/0027-permission-stall-notification.md)。
- **dispatch hold reminder**: hold が続く間、既定 `1_800_000ms`（30 分）ごとに held buffer の最新件数を含む `harness.warning` を TTY 活動ログ / 非 TTY stderr に出す。`operator.message` の配送には介入せず、conductor の `SessionEvent` には載せず、自動解除もしない。hold release で reminder episode をリセットする。

- `maxTurns` = 直近オペレータ入力からの conductor **自律ターン上限**（入力でリセット）。`maxTurns <= 0` または CLI `--no-max-turns` で無制限（上限チェック・max-turns open question 登録なし）
- **CLI デフォルト**: TTY、または有効な CLI 初回メッセージ / `ENSEMBLE_OPERATOR_MESSAGE` あり → 無制限。非 TTY / CI で単発メッセージがない場合 → 5（暴走防止）。`--continue` / `--resume` で無視された CLI メッセージは interactive 判定と無制限化の対象外
- **通常の binding（TTY 本番 CLI）**: `bindOperatorInput` 使用時はループをブロックせず、未回答 open question があっても worker イベント等を処理し続ける。オペレータ入力は `operator.message` としてキューに載る。自律ループ停止後の post-loop 待機でも SessionDriver は停止せず、同じキューを消費する
- **初回メッセージ binding（CLI 初回メッセージ / `ENSEMBLE_OPERATOR_MESSAGE`）**: binding 直後に `operator.message` を 1 回だけ注入する。TTY では通常の binding と同じく conductor error の継続を有効にし、`postLoopWait` が有効なら `waitForOperatorExit` も有効にして、未回答 open question / 未解決 permission を post-loop の追加入力で処理できる。非 TTY では追加入力を提供しない one-shot として `waitForOperatorExit` を無効にし、conductor error / `cancelled` / 未回答 open question / 未解決 permission で入力待ちへ移らず終了する。dispatch hold が残っていても、非 TTY one-shot の停止条件より hold を優先して release を待つことはない
- **`--continue` / `--resume`**: CLI 引数の初回メッセージだけを注入せず、stderr に警告する（その分の interactive 判定・無制限 `maxTurns`・binding も有効にしない）。`ENSEMBLE_OPERATOR_MESSAGE` は従来どおり環境変数の経路で解決する
- 自律ターン上限到達（**リミット有効時のみ**）→ orchestrator が「次どうする？」（`source: max_turns`）を自動登録。オペレータは `bindOperatorInput` 経由で回答
- **GitHub 更新**（`issue.comment` / `pr.review` / `pr.review_comment` / `ci.completed`）は自律中・post-loop 中とも `github.update` として同じ経路で処理する。ターン残ありなら通常 dispatch して状況把握ターンを 1 消費し、max-turns 到達後は `operator.message` / `permission.pending` / `permission.stall` 以外を dispatch しない
- 終了条件: 通常の binding（TTY の初回メッセージ注入を含む）では error / 実行中 worker / pending permission / **未回答 open question** がある間は継続する。SDK の `cancelled` は terminal status として `stopReason: cancelled` に解決する。非 TTY の単発 binding では未回答 question / permission や dispatch hold の release を待たずに終了する
- **自律ループ停止**（`shouldStopIssueLoop`）と **プロセス終了** は別概念（[ADR 0013](adr/0013-process-lifecycle-vs-autonomous-loop.md)、初回メッセージの分類は [ADR 0023](adr/0023-tty-initial-message-post-loop.md)、TTY の `/close` 契約は [ADR 0030](adr/0030-tty-close-lifecycle.md)）。TTY は初回メッセージの有無にかかわらず自律ループ停止後も通常の post-loop 待機を続ける。`/close` と `/exit` はそこから終了する明示操作で、Ctrl+C / SIGINT は `interrupted` の割り込みである。`/close` は pending permission を deny し、monitor outbox を SessionResumeStore に保存して worker / conductor を teardown した後に exit 0 で終了するが、in-flight conductor send は再開しない。`/exit` は isolated worktree cleanup を試み、cleanup failure は warning のみで exit 0 を保つ（#448）。非 TTY one-shot と `--no-wait` の契約は変わらない

CLI: 通常の TTY は Ink TUI（非ブロッキング入力 + `pane` / `stream` レイアウト）。CLI 初回メッセージ / `ENSEMBLE_OPERATOR_MESSAGE` は TTY・非 TTY 共通で binding 直後に 1 回注入するが、TTY では通常の post-loop 待機を維持し、非 TTY では one-shot として終了する。メッセージなしの非 TTY は `bindAsyncOperatorInput`。`--continue` / `--resume` で CLI メッセージを指定した場合は単発注入せず警告する。ログ・表示の正本は [session-logging.md](session-logging.md)。対話モデルは [ADR 0008](adr/0008-human-dialogue-open-questions.md)。

---

## 6. 情報の流れ（Issue + worktree 中心）

```
Issue URL ──► worktree 作成（implementer dispatch 時）
     │
     ├── Skill（手順）     conductor が dispatch 時に指定
     │
     ▼
worker（種別ごと）──write──► Issue コメント
     │                       PR / レビューコメント
     │                       コード差分（worktree）
     ▼
他 worker ──read──► Issue / PR から状態を復元
     │
     ▼
conductor ──read──► 次の worker 種別の判断
```

- **会話の resume** — worker ACP は `session/load` + SessionResumeStore の `acpSessionId` と `acpCwd`（[ADR 0011](adr/0011-session-sidecar-resume.md)）。Issue / PR は作業報告の共有バスとして引き続き正本
- **Issue worktree** — 1 Issue あたり 1 つを規約（`--worktree`）。worker ごとの ACP cwd は profile `workspace` で別指定可

---

## 7. パッケージ構成

```
agents-ensemble/
├── packages/
│   ├── cli/          # ensemble コマンド（ユーザー入口）
│   └── core/         # conductor ループ、ACP ブリッジ、共有型
├── docs/
└── package.json      # pnpm workspace
```

| パッケージ | 依存（想定） | 責務 |
|-----------|-------------|------|
| `@agents-ensemble/cli` | `core`, `commander` | `ensemble issue` 等 |
| `@agents-ensemble/core` | `@cursor/sdk`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` | ConductorAgent, AcpWorkerBridge, dispatch |

CLI は薄く、オーケストレーション本体は core に集約する。

---

## 8. 典型シーケンス（参考）

固定フローではない。conductor が文脈で省略・繰り返す。参考フレームは [prompts/issue-workflow.md](prompts/issue-workflow.md)。

```
ensemble issue https://github.com/org/repo/issues/123
  → conductor 起動（Cursor SDK 既定 / Pi opt-in）
  → Issue / Skill を読む
  → dispatch implementer（ACP, worktree 作成）
  → implementer: 実装 → Issue 更新 → PR 作成
  → conductor: register_github_watch で PR を明示登録 → PR / CI を読む
  → dispatch reviewer（ACP, 既存 worktree）
  → reviewer: PR コメント（Issue / PR に記録）
  → （ループ）dispatch implementer（レビュー対応）
  → dispatch implementer（人間レビュー依頼）
  → 人間: マージ
  → dispatch implementer（Issue クローズ・報告）
```

---

## 9. 既存資産との境界

| 資産 | agents-ensemble との関係 |
|------|---------------------------|
| CONDUCTOR_MODE | conductor の行動原則の正本 |
| periodic-checker | GH 通知のトリガー入力の一つ |
| 作業 / レビュー Skill（dispatch 先） | worker が実行する手順の正本 |
| `karte-auto-docs` / search-docs | worker（特に librarian 種別）の参照先 |

---

## 10. 非目標・制約

- IDE サイドパネル Agent へのメッセージ注入
- 汎用マルチエージェントフレームワーク
- WORKFLOW ファイルのスキーマ標準化
- conductor によるファイル直接編集
- Cloud Agent 前提の設計（初期は **local SDK + local ACP**）

---

## 11. 関連ドキュメント

| 文書 | 内容 |
|------|------|
| [design.md](design.md) | 大原則・固くしないもの |
| [orchestrator.md](orchestrator.md) | conductor の責務（運用寄り） |
| [elements.md](elements.md) | skill, worker, issue 等 |
| [prompts/issue-workflow.md](prompts/issue-workflow.md) | フェーズ参考（手順） |
| [prompts/worker-bootstrap.md](prompts/worker-bootstrap.md) | 起動プロンプト例（手順） |
| [documentation-policy.md](documentation-policy.md) | 文書の種類と更新ルール |
| [testing-strategy.md](testing-strategy.md) | unittest / integration / e2e の分離 |
| [session-logging.md](session-logging.md) | SessionLogger・stdout/stderr・終了 JSON |
| [adr/0008-human-dialogue-open-questions.md](adr/0008-human-dialogue-open-questions.md) | open question / オペレータ対話 |
| [adr/0031-operator-agent-layer.md](adr/0031-operator-agent-layer.md) | operator 層・operator-agent・接続密度 |
