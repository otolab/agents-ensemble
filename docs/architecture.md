# アーキテクチャ

`ensemble` の技術構成。前提は **SDK で conductor（指揮者）**、**ACP で worker / reviewer 等（演奏者）**。

設計の大原則（Skill 依存・遷移の非機械化など）は [design.md](design.md) を正本とする。本文はその前提の上に、プロセス分離と通信経路を記述する。

関連: [otolab/my-logs#2027](https://github.com/otolab/my-logs/issues/2027)、CONDUCTOR_MODE（`mode-controller` の `conductor` モード）

---

## 1. 目的とスコープ

### 何をするシステムか

手順が明確な GitHub Issue を起点に、**conductor が演奏せず** worker / reviewer を起動し、作業を進める CLI（`ensemble`）。

- **最小ユースケース**: `ensemble issue <url>` → worker 起動 → Issue / PR 上で作業
- **直近スコープ**: #2027 で整理した「小さな作業単位の Issue ベースフロー」
- **対象外（初期）**: 汎用タスクオーケ、IDE 内 Agent の代替

### CONDUCTOR_MODE との関係

| CONDUCTOR_MODE | agents-ensemble |
|----------------|-----------------|
| スコアを深く理解するが演奏しない | conductor プロセスは **実作業ツールを持たない** |
| 理解・判断・指示・検証 | `gh` / Issue / PR を読み、dispatch・エスカレーション |
| エージェントへ委任 | ACP で **独立 session** の worker / reviewer |
| 結果を鵜呑みにしない | reviewer ロール + Issue / PR 上の履歴 |

CONDUCTOR_MODE は **行動原則**、agents-ensemble はその **Issue フロー専用の強制版**（プロセス・権限で補強）。

---

## 2. 全体像

```
┌─────────────────────────────────────────────────────────────┐
│  ensemble CLI (packages/cli)                               │
│  ユーザー入口・引数・終了コード                               │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  conductor (@agents-ensemble/core + Cursor SDK)             │
│  長寿命 Agent 1 本（または同等の SDK ループ）                 │
│  ・Issue / PR / CI の読取（gh 等）                          │
│  ・次ロールの判断（LLM。ルール表は固定しない）                │
│  ・worker / reviewer の dispatch                            │
│  ・permission の集約 → 必要時に人間へ                         │
│  ・実作業ツールは hooks / mode で禁止                         │
└───────────────────────────┬─────────────────────────────────┘
                            │ spawn + JSON-RPC (stdio)
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         worker ACP    reviewer ACP   librarian ACP
         (新 session)  (新 session)   (新 session)
              │             │             │
              └─────────────┴─────────────┘
                            │
              Issue ◄───────┴───────► PR
              （共有の正本・履歴）
```

### レイヤー

| レイヤー | 技術 | 役割 |
|---------|------|------|
| **CLI** | Node.js (`packages/cli`) | コマンド解析、環境、終了処理 |
| **Core** | TypeScript (`packages/core`) | ACP ブリッジ、dispatch、型の共有 |
| **Conductor** | `@cursor/sdk` | 判断・dispatch 制御の主体 |
| **Worker 等** | `agent acp` | Skill に沿った実作業・レビュー |
| **共有媒体** | GitHub Issue / PR | セッション会話に依存しない状態と履歴 |
| **手順の正本** | Skill（各作業リポジトリ） | worker / reviewer が読む手順 |

---

## 3. Conductor（SDK）

### 責務

1. **状態把握** — Issue コメント、PR、CI、ラベル等（主に `gh`）
2. **遷移判断** — 次に worker / reviewer / librarian / 人間か（**機械ルール表に固定しない**）
3. **dispatch** — 判断に基づき ACP worker 等を起動
4. **承認集約** — サブの `session/request_permission` を受け、ポリシー or 人間へ
5. **エスカレーション** — 判断不能・マージ前等をユーザーへ（CLI 問い合わせ or 秘書連携）

### 演奏しないことの担保

| 手段 | 内容 |
|------|------|
| `mode: "plan"` | 計画・調査寄り。実装は worker に委任 |
| hooks | conductor 側 cwd の `.cursor/hooks.json` で shell / write / edit を deny |
| customTools | **dispatch 専用**のみ（例: `dispatch_worker`）。built-in 作業ツールに頼らない |
| プロンプト / Skill | conductor 用 Skill が「委任のみ」を明示 |

conductor は **理解と dispatch に専念**し、ファイル編集・テスト実行は worker の domain とする。

### SDK の使い方（想定）

```typescript
await using conductor = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2.5" },
  mode: "plan",
  local: {
    cwd: orchestratorWorkspace,       // agents-ensemble または my-logs
    settingSources: ["project"],      // conductor 用 Skill
    // sandbox / autoReview は conductor 側の方針に応じて
  },
});

// conductor への入力: Issue URL、作業基準文書（任意）、dispatch 結果の要約
const run = await conductor.send(buildConductorPrompt(context));
```

- **長寿命**: 1 Issue あたり 1 conductor session（`agent.send` でターンを重ねる）
- **resume**: 別プロセスから `Agent.resume(conductorId)` で再開可能
- **reload**: `.cursor/` 変更時は `conductor.reload()`（subagents 定義等）。worker は別プロセスなので別途 spawn で鮮度を確保

### conductor が読む入力

| 入力 | 必須 | 説明 |
|------|------|------|
| Issue / PR | ○ | 事実・履歴の正本 |
| 作業 Skill | ○ | worker が実行する手順（参照用に conductor も知る） |
| 作業基準文書 | 任意 | フロー / Issue ごとの自然言語メモ（形式固定しない） |
| `SCORE_*.md` 等 | 任意 | conductor の理解メモ（CONDUCTOR_MODE の SCORE 相当） |

**WORKFLOW ファイルのスキーマは固定しない**（[design.md](design.md)）。状態は Issue / PR と conductor の判断材料に分散する。

---

## 4. Worker / Reviewer（ACP）

### なぜ ACP か

| 要件 | SDK サブ | ACP（タスク単位 spawn） |
|------|---------|-------------------------|
| 親会話からの分離 | 弱い | **session 独立** |
| Skill 追加直後の反映 | `reload` + 再 spawn | **新プロセスで再発見** |
| permission の仲介 | ほぼ不可 | **conductor がクライアント** |
| reviewer のコンテキスト 0 | 難しい | 新 session + レビュー Skill のみ |

### 起動パターン

各 dispatch で:

1. `spawn("agent", ["acp"], { cwd: targetRepo })`
2. JSON-RPC: `initialize` → `authenticate` → `session/new`
3. `session/prompt` に **ロール別起動プロンプト** + Skill 名 / Issue URL
4. `session/update` を conductor が購読（進捗）
5. `session/request_permission` → conductor が応答
6. 完了後 session 終了（次フェーズは **新 session**）

| ロール | worktree | Skill | 備考 |
|--------|----------|-------|------|
| **worker** | 作成 | 作業 Skill | 実装・Issue 更新・PR・対応 |
| **reviewer** | 既存に参加 | レビュー Skill | コンテキスト 0、独立検証 |
| **librarian** | 対象 repo 次第 | librarian Skill | auto-docs 等（条件付き） |

起動プロンプトのパターンは [prompts.md](prompts.md)。

### Worker の前提

- 手順は **Skill が正本**（`SKILL.md`、必要なら `CASE_STUDIES.md`）
- 作業リポジトリの `.cursor/skills/` を ACP 起動時に読む
- 成果・経緯は **Issue コメント / PR** に書く（会話は捨ててよい）
- description 本文は checkbox の check 以外は基本触らない（#2027 運用）

---

## 5. 承認フロー

```
worker (ACP)                    conductor (SDK)              ユーザー
     │                               │                          │
     │ session/request_permission    │                          │
     │ ─────────────────────────────>│  ポリシー判定              │
     │                               │  ├─ 自動 allow/deny      │
     │                               │  └─ 判断不能 ────────────>│
     │                               │                          │ y/n
     │                               │<──────────────────────────│
     │ permission response           │                          │
     │ <─────────────────────────────│                          │
```

- **サブ → ユーザー直結はしない**。conductor が ACP クライアントとして必ず仲介する。
- conductor 側に自動 allow/deny ポリシー（allowlist、hooks 相当）を載せられる。
- **PR マージ**は引き続き人間（#2027）。

並列 dispatch 時は `sessionId` / ロールで permission 要求をキューイングする。

---

## 6. 情報の流れ（セッションに依存しない）

```
Skill（手順）          conductor が dispatch 時に指定
       │
       ▼
worker / reviewer ──write──► Issue コメント
       │                      PR / レビューコメント
       │                      コード差分（worktree）
       ▼
conductor ──read──► 次の dispatch 判断
```

**会話履歴は共有媒体にしない。** conductor は dispatch 結果の要約と Issue / PR を読んで次を決める。

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
  → dispatch worker（ACP, worktree 作成）
  → worker: 実装 → Issue 更新 → PR 作成
  → conductor: PR / CI を読む
  → dispatch reviewer（ACP, 既存 worktree）
  → reviewer: PR コメント
  → （ループ）dispatch worker（レビュー対応）
  → dispatch worker（人間レビュー依頼）
  → 人間: マージ
  → dispatch worker（Issue クローズ・報告）
```

---

## 9. 既存資産との境界

| 資産 | agents-ensemble との関係 |
|------|---------------------------|
| CONDUCTOR_MODE | conductor の行動原則の正本 |
| 秘書スキル（my-logs） | エスカレーション・音声・tasks。**パイプライン本体は ensemble** |
| periodic-checker | GH 通知のトリガー入力の一つ |
| 作業 / レビュー Skill（各 repo） | worker / reviewer が実行する手順の正本 |
| `karte-auto-docs` / search-docs | worker / reviewer / librarian の参照先 |

---

## 10. 段階導入

| 段階 | 内容 |
|------|------|
| **0** | 本アーキテクチャ + CLI スケルトン（現状） |
| **1** | ACP ブリッジ + 手動 dispatch 相当（固定プロンプトで worker 1 回） |
| **2** | SDK conductor が Issue を読み、判断して dispatch |
| **3** | permission 仲介、reviewer ループ |
| **4** | 秘書連携エスカレーション、librarian 条件 dispatch |

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
