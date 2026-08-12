# アーキテクチャ

`ensemble` の技術構成。前提は **SDK で conductor**、**ACP で worker**。複数 agent が **conductor を中心とするスター型**で接続する。

設計の大原則（スター型・Issue 紐づけ・遷移の非機械化など）は [design.md](design.md) を正本とする。本文はプロセス分離と通信経路を記述する。

関連: [otolab/my-logs#2027](https://github.com/otolab/my-logs/issues/2027)、CONDUCTOR_MODE（`mode-controller` の `conductor` モード）

---

## 1. 目的とスコープ

### 何をするシステムか

手順が明確な GitHub Issue を起点に、**conductor が演奏せず** worker を起動・制御し、作業を進める CLI（`ensemble`）。作業とプロセスは **1 Issue + worktree** に紐づく。

- **最小ユースケース**: `ensemble issue <url>` → worker 起動 → Issue / PR 上で作業
- **直近スコープ**: #2027 で整理した「小さな作業単位の Issue ベースフロー」
- **対象外（初期）**: 汎用タスクオーケ、IDE 内 Agent の代替

### CONDUCTOR_MODE との関係

| CONDUCTOR_MODE | agents-ensemble |
|----------------|-----------------|
| スコアを深く理解するが演奏しない | conductor プロセスは **実作業ツールを持たない** |
| 理解・判断・指示・検証 | `gh` / Issue / PR を読み、dispatch・エスカレーション |
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
    worker (reviewer) ─────┼───── conductor (SDK)
                           │         │
                           │         │ gh / CLI
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
│  conductor (@agents-ensemble/core + Cursor SDK)               │
│  スター型の中心。長寿命 Agent 1 本                              │
│  ・Issue / PR / CI の読取（gh 等）                            │
│  ・次の worker 種別の判断（LLM。ルール表は固定しない）          │
│  ・worker の dispatch・制御（種別・Skill・起動文書）            │
│  ・permission の集約（自動許諾含む）→ 必要時に人間へ            │
│  ・実作業ツールは SDK mode + customTools で制限                 │
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

### レイヤー

| レイヤー | 技術 | 役割 |
|---------|------|------|
| **CLI** | Node.js (`packages/cli`) | コマンド解析、環境、終了処理 |
| **Core** | TypeScript (`packages/core`) | ACP ブリッジ、dispatch、型の共有 |
| **Conductor** | `@cursor/sdk` | 判断・dispatch 制御の主体 |
| **Worker** | `agent acp` | Skill に沿った実作業（種別ごとに起動文書・Skill が異なる） |
| **共有媒体** | GitHub Issue / PR | セッション会話に依存しない状態と履歴 |
| **手順の正本** | Skill（dispatch 先の clone / worktree 上） | worker が読む手順 |

---

## 3. Conductor（SDK）

### 責務

1. **状態把握** — Issue コメント、PR、CI、ラベル等（主に `gh`）
2. **遷移判断** — 次にどの worker 種別を起動するか、人間へ聞くか（**機械ルール表に固定しない**）
3. **dispatch・制御** — worker を起動し、実行中も permission 応答等で制御する（自動許諾ポリシーを含む）
4. **承認集約** — 各 worker の `session/request_permission` を conductor が受け、ポリシー or 人間へ
5. **エスカレーション** — 判断不能・マージ前等をユーザーへ（CLI 問い合わせ）

### 演奏しないことの担保

| 手段 | 内容 |
|------|------|
| `mode: "agent"` | SDK 実行モード（[adr/0006-conductor-agent-mode.md](adr/0006-conductor-agent-mode.md)）。振る舞いの正本は下記プロンプト / materials |
| `customTools` | conductor 用: `ask_human`, `answer_open_question`, `list_open_questions`, `get_open_question`, `resolve_permission`（[ADR 0007](adr/0007-permission-pipeline.md), [ADR 0008](adr/0008-human-dialogue-open-questions.md)）。worker 起動はセッション開始時 |
| プロンプト / materials | PromptModule と profile materials で指揮専任・委任方針を明示（conductor の正本） |

conductor は **理解と dispatch に専念**し、ファイル編集・テスト実行は worker の domain とする。

**agents-ensemble リポジトリに `.cursor/` は置かない。** 開発用 IDE 設定と混同し、hooks がローカル作業を阻害する。conductor / worker のツール方針はコードと起動オプションで与える。

### modular-prompt と SDK の分担

| レイヤ | 役割 |
|--------|------|
| **modular-prompt** | conductor の **system prompt 文**（persona / guidelines / materials）。`compile` → 初回または reload 時に適用 |
| **`agent.send(message)`** | 会話への **user ターン 1 本**。オペレータ発話・自律ターンの状態通知 |
| **SDK 会話** | LLM 会話履歴の正本 |

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
    customTools: { ask_human, answer_open_question, list_open_questions, get_open_question, resolve_permission },
  },
});

// 初回: modular-prompt で組み立てた system prompt + Issue 初回ブリーフィング
await conductor.send(buildConductorSessionStart(context));

// 以降: オペレータ発話は user ターンとして直接送る
await conductor.send(operatorMessage);

// 自律ターン: worker 状態など短い user 通知（設計は #28 参照）
await conductor.send(workerStatusUpdate);
```

**SDK にチャット UI はない。** CLI（TTY）では Ink TUI（`createIssueSessionTuiHost`）が非ブロッキング入力と 4 ペイン表示を担い、`submitOperatorInput` 経由で `operator.message` をキューへ積む。非 TTY は `bindAsyncOperatorInput` / `ENSEMBLE_OPERATOR_MESSAGE`。ConductorSession はキューから dispatch するだけ。テストは `bindOperatorInput` にフェイクを渡す（`createTestOperatorInputBinding`）。ConductorSession がイベント列経由で `agent.send` に渡す（[ADR 0008](adr/0008-human-dialogue-open-questions.md)、[ADR 0009](adr/0009-conductor-session-event-queue.md)）。**観測と表示の分離**（TUI / stdout 対話 / stderr harness / 終了 JSON）は [session-logging.md](session-logging.md)。

conductor の初回セットアップは `ensemble auth login`（`Cursor.auth.login()` 相当）。worker の ACP は `agent login` で足りるが、**CLI ログインは SDK に自動では渡らない**。

- **長寿命**: 1 Issue あたり 1 conductor session（`agent.send` でターンを重ねる）
- **resume**: 別プロセスから `Agent.resume(conductorId)` で再開可能。harness sidecar（`.ensemble/sessions/{conductorAgentId}.json`）に open question・profile・worker `acpSessionId` を保存（[ADR 0011](adr/0011-session-sidecar-resume.md)）
- **ripgrep**: local agent の ignore scan 用。`ConductorAgent` 起動前に `ensureCursorSdkRipgrepPath()` が `@cursor/sdk-<platform>-<arch>/bin/rg` または PATH の `rg` を `CURSOR_RIPGREP_PATH` に設定する（[#43](https://github.com/otolab/agents-ensemble/issues/43)）。詳細は [README の ripgrep 節](../README.md#conductorsdk-の-ripgrep)

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

conductor が制御する実行単位。**種別（kind）** によって読む Skill と起動時のシステムプロンプトが変わる。各 worker は **独立 session で自律的に** Skill に沿って動く。プロファイル（未実装）が種別ごとの定義を返す想定。

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

各 dispatch で:

1. `spawn("agent", ["acp"], { cwd, env, ... })` — **ツール・環境は起動オプションで明示**
2. JSON-RPC: `initialize` → `authenticate` → `session/new`（`cwd`, `mcpServers` 等）
3. `session/prompt` に **種別用起動プロンプト** + Skill 名 / Issue URL
4. `session/update` を conductor が購読（進捗）
5. `session/request_permission` → conductor が応答
6. 完了後 session 終了（次フェーズは **新 session**）

worker は **agents-ensemble の `.cursor/` を読まない**。Skill 名と起動文書は conductor が与え、手順の正本は dispatch 先の worktree（`cwd`）上の Skill ファイルとする。

| 種別 | worktree | 備考 |
|------|----------|------|
| **implementer** | 作成 | 実装作業の主役 |
| **reviewer** | 既存に参加 | レビュー Skill |
| **librarian** | 対象 repo 次第 | ドキュメント整備等（条件付き） |

起動プロンプトのパターンは [prompts.md](prompts.md)。**どの種別をいつ dispatch するか、どの Skill・起動文書を渡すかはプロファイルが決める。**

### Worker の前提

- **自律実行** — session 内では Skill に沿って自走する。worker 同士は直接通信しない
- **Issue / PR に報告** — 作業報告・状態は Issue コメント / PR に書き、他 worker が読む
- **worktree に紐づく** — implementer は worktree を作成し、以降の worker は同じ Issue の worktree を共有する
- **worktree のライフサイクル** — isolated モードではセッション開始時に `.ensemble/worktrees/issue-N` を作成（既存なら再利用）。TTY + post-loop で `/exit` 正常終了時に削除（未コミット変更がある場合は削除拒否）。`in-repo` では削除しない。ローカルブランチ `ensemble/issue-N` は残す
- **新規 worktree のベース** — 可能なら `git fetch` 後の `origin` デフォルトブランチ（`origin/HEAD` または `main`）から `ensemble/issue-N` を切る。remote なし・fetch 失敗時はローカル HEAD にフォールバック
- 手順は **Skill が正本**（`SKILL.md`、必要なら `CASE_STUDIES.md`）— worktree の `cwd` から解決
- ツール可否・MCP 等は **`spawn` / `session/new` のオプションで明示**
- description 本文は checkbox の check 以外は基本触らない（#2027 運用）

---

## 5. 承認フロー・worker 制御・オペレータ対話

### 双方向フロー（常駐 worker・数往復）

[ADR 0012](adr/0012-conductor-worker-prompt-roundtrip.md) を参照。

```
セッション開始 ──attach（待機 prompt）──► worker 常駐（agent acp プロセス + ACP session）
conductor ──prompt_worker──► WorkerOutboundQueue ──sendWorkerMessage──► session/prompt
conductor ──list_workers / get_worker_status──► WorkerRuntime（読み取り専用・イベント列に積まない）
conductor ──get_session_usage / get_usage──────► SessionUsageTracker（読み取り専用・イベント列に積まない）
worker    ──permission──────► ConductorInbox ──► SessionEventQueue ──► agent.send
worker    ──Issue / PR 報告──► （非同期正本。harness 非経由）
worker    ──ラウンド終了──────► worker.completed ──► SessionEventQueue ──► agent.send
ensemble 終了 ──stop────────► 全 worker bridge close
```

- **常駐** = ensemble 中 `agent acp` プロセスを殺さない（bootstrap 後も bridge 保持）。
- **sendWorkerMessage** = 既存 session への `session/prompt`（dispatch ではない）。
- **`list_workers` / `get_worker_status`** = harness 上の worker 状態照会（読み取り専用）。`prompt_worker` は作業指示専用。オペレータの状態質問には状態照会ツールを使い、Issue / PR を読まず tool 結果で答える。返却は YAML。セッションイベント列には積まない（[Issue #70](https://github.com/otolab/agents-ensemble/issues/70)）。
- **`get_session_usage` / `get_usage`** = harness が蓄積した LLM トークン使用量照会（読み取り専用）。conductor 各 `agent.send` は `@cursor/sdk` の `RunResult.usage`、worker 各 prompt は ACP 応答の `usage`（無い場合は prompt/response から推定、`source: estimated`）。コンテキスト上限は SDK 1.0.27 時点で取得不可のため既定は `limit: null`（[Issue #102](https://github.com/otolab/agents-ensemble/issues/102)）。返却は YAML。イベント列には積まない。
- 同一 worker は ACP 制約により prompt **直列**（per-worker キュー）。worker 間は並行可。
- **`worker.completed` は 1 ラウンドの終了**。進捗の正本は Issue / PR。

### permission（conductor 制御）

```
worker (ACP)                    conductor (SDK)              オペレータ
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

- **worker → ユーザー直結はしない**。人間への出口は conductor 経由のみ（[ADR 0007](adr/0007-permission-pipeline.md)、pending 通知は [ADR 0010](adr/0010-permission-pending-event-delivery.md)）
- **段1 自明許可** — `PermissionPipeline` + policy（read-only allowlist 等）
- **段2 conductor** — 非自明は pending。`resolve_permission` で allow/deny。**bootstrap ラウンド中でも同様**（完了を待ってから処理しない — [ADR 0016](adr/0016-bootstrap-permission-conductor-wait.md)）
- **段3 human** — conductor が `ask_human` で **質問を登録**（非ブロッキング）。オペレータ回答は **別ターンのチャット入力**（[ADR 0008](adr/0008-human-dialogue-open-questions.md)）
- 並列 worker 時は request id / workerId で correlation
- conductor は harness 状態を **ポーリング待機してはならない**（外部 `Await` 等）。変化は `SessionEventQueue` のみが通知する（[ADR 0016](adr/0016-bootstrap-permission-conductor-wait.md)）

### オペレータ対話（open question）

ユーザとの接点は **conductor のみ**（第二経路なし）。

| レイヤ | 役割 |
|--------|------|
| **modular-prompt** | system prompt 文（指揮方針・materials） |
| **オペレータメッセージ** | `agent.send` の user ターン（CLI TTY / `ENSEMBLE_OPERATOR_MESSAGE`） |
| **OpenQuestionRegistry** | TODO リスト（`inq-N`）。tool で読む |
| **SDK 会話** | LLM 会話履歴の正本（オペレータ発話・tool 結果を含む） |

**ツール使い分け**

| 状況 | tool |
|------|------|
| まだ答えていない | `ask_human`（登録のみ） |
| チャットですでに答えている | `answer_open_question` |
| 一覧・詳細が必要 | `list_open_questions` / `get_open_question` |
| permission 判断 | `resolve_permission`（要確認時は open question を先に処理） |

**ConductorSession ループ**（[ADR 0009](adr/0009-conductor-session-event-queue.md)）

Driver / Policy / View の 3 層（Issue #62）:

| 層 | 責務 | モジュール |
|----|------|------------|
| **SessionPolicy** | `canDispatchConductorSend`, `shouldStopIssueLoop`, `autonomousTurnsAfterConductorSend` / `autonomousTurnsAfterConductorBatch` | `session-policy.ts` |
| **SessionDriver** | イベントキュー消費・max-turns 登録・`agent.send` 呼び出し | `conductor-session-driver.ts` |
| **SessionView** | TTY Ink TUI / `ENSEMBLE_OPERATOR_MESSAGE` | CLI `createIssueSessionTuiHost` / `bindAsyncOperatorInput`（[operator-input.md](operator-input.md)） |

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

- `WorkerSession` / `ConductorSession` が対。worker 由来・operator 由来のイベントは **1 本の列** に集約し、[ADR 0014](adr/0014-conductor-dispatch-batch-coalescing.md) に従い **1 束 = 1 `agent.send`**（束は 1 件のこともある。初回のみ system + ブリーフィング）

- `maxTurns` = 直近オペレータ入力からの conductor **自律ターン上限**（入力でリセット）。`maxTurns <= 0` または CLI `--no-max-turns` で無制限（上限チェック・max-turns open question 登録なし）
- **CLI デフォルト**: TTY / `ENSEMBLE_OPERATOR_MESSAGE` あり → 無制限。非 TTY / CI → 5（暴走防止）
- **TTY（本番 CLI）**: `bindOperatorInput` 使用時はループをブロックせず、未回答 open question があっても worker イベント等を処理し続ける。オペレータ入力は `operator.message` としてキューに載る
- 自律ターン上限到達（**リミット有効時のみ**）→ orchestrator が「次どうする？」（`source: max_turns`）を自動登録。オペレータは `bindOperatorInput` 経由で回答
- 終了条件: error / 実行中 worker / pending permission / **未回答 open question** がある間は継続
- **自律ループ停止**（`shouldStopIssueLoop`）と **プロセス終了** は別概念（[ADR 0013](adr/0013-process-lifecycle-vs-autonomous-loop.md)）。TTY デフォルトでは自律ループ停止後も post-loop 待機し、`/exit` までプロセス維持。`/exit` 正常終了時は isolated worktree を削除（未コミット変更がある場合は拒否）。`--no-wait` で従来の即終了に戻せる

CLI: TTY は Ink TUI（非ブロッキング入力 + 4 ペイン）、非 TTY は `ENSEMBLE_OPERATOR_MESSAGE` / `bindAsyncOperatorInput`。ログ・表示の正本は [session-logging.md](session-logging.md)。対話モデルは [ADR 0008](adr/0008-human-dialogue-open-questions.md)。

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

- **会話の resume** — worker ACP は `session/load` + sidecar の `acpSessionId`（[ADR 0011](adr/0011-session-sidecar-resume.md)）。Issue / PR は作業報告の共有バスとして引き続き正本
- **worktree が作業の物理的な紐づけ** — 1 Issue あたり 1 worktree（規約）

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
| `@agents-ensemble/core` | `@cursor/sdk` | ConductorAgent, AcpWorkerBridge, dispatch |

CLI は薄く、オーケストレーション本体は core に集約する。

---

## 8. 典型シーケンス（参考）

固定フローではない。conductor が文脈で省略・繰り返す。参考フレームは [pipeline.md](pipeline.md)。

```
ensemble issue https://github.com/org/repo/issues/123
  → conductor 起動（SDK）
  → Issue / Skill を読む
  → dispatch implementer（ACP, worktree 作成）
  → implementer: 実装 → Issue 更新 → PR 作成
  → conductor: PR / CI を読む
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

## 10. 段階導入

| 段階 | 内容 |
|------|------|
| **0** | 本アーキテクチャ + CLI スケルトン（現状） |
| **1** | ACP ブリッジ + 手動 dispatch 相当（固定プロンプトで worker 1 回） |
| **2** | SDK conductor が Issue を読み、判断して dispatch |
| **3** | permission 仲介、reviewer ループ、CLI 人間エスカレーション |

Stage 3 までが初期スコープ。以降（#20 非同期化の完了、プロファイルなど）は別 Issue で追う。

各段階のテストレベル（unittest / integration / e2e）と完了ゲートは [testing-strategy.md](testing-strategy.md) を正本とする。Stage 1 は ACP ブリッジを unittest で作りきってから integration → e2e（CLI 縦切り）の順。

遷移の **機械ルール表は導入しない**（[design.md](design.md)）。段階は実装の厚みであり、判断ロジックの固定化ではない。

---

## 11. 非目標・制約

- IDE サイドパネル Agent へのメッセージ注入
- 汎用マルチエージェントフレームワーク（#2027 外のフロー）
- WORKFLOW ファイルのスキーマ標準化
- conductor によるファイル直接編集
- Cloud Agent 前提の設計（初期は **local SDK + local ACP**）

---

## 12. 関連ドキュメント

| 文書 | 内容 |
|------|------|
| [design.md](design.md) | 大原則・固くしないもの |
| [orchestrator.md](orchestrator.md) | conductor の責務（運用寄り） |
| [elements.md](elements.md) | skill, worker, issue 等 |
| [pipeline.md](pipeline.md) | フェーズ参考 |
| [prompts.md](prompts.md) | 起動プロンプト |
| [implementation.md](implementation.md) | 実装メモ・段階導入の要約 |
| [testing-strategy.md](testing-strategy.md) | unittest / integration / e2e の分離 |
| [session-logging.md](session-logging.md) | SessionLogger・stdout/stderr・終了 JSON |
| [adr/0008-human-dialogue-open-questions.md](adr/0008-human-dialogue-open-questions.md) | open question / オペレータ対話 |
