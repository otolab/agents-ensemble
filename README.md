# agents-ensemble

Issue を指定して起動する、エージェントオーケストレーション CLI。

`ensemble` がオーケストレータ（conductor）として worker を制御し、作業を進める。worker は **セッション開始時に attach され ensemble 終了まで常駐**する。conductor からの作業指示は harness 内の `prompt_worker`（ACP `session/prompt`）で届く。

## ステータス

Stage 2 まで実装済み（SDK conductor + ACP worker + e2e smoke）。詳細は [docs/](docs/) と GitHub Issues を参照。

## ドキュメント

[docs/](docs/) に設計・検討事項を整理している。技術構成の正本は [docs/architecture.md](docs/architecture.md)（SDK conductor + ACP worker）。

## 認証

agents-ensemble は **SDK（conductor）** と **ACP（worker）** の2系統を使う。認証ストアは共有されない。

| 経路 | 技術 | 何に使うか | ローカル開発 | CI / 自動化 |
|------|------|-----------|-------------|------------|
| **conductor** | `@cursor/sdk` | `ensemble issue` | `ensemble auth login` | `CURSOR_API_KEY` |
| **worker** | `agent acp` | `ensemble dispatch worker`（one-shot）、`ensemble issue` の常駐 worker | `agent login` | `CURSOR_API_KEY`（子プロセスへ継承） |
| **Issue 取得** | `gh` CLI | conductor が Issue 本文・コメントを読む | `gh auth login` | `GH_TOKEN` 等 |

### 初回セットアップ（ローカル）

```bash
# worker 用（agent CLI）
agent login
agent status

# conductor 用（SDK）
pnpm ensemble auth login
pnpm ensemble auth status

# Issue 取得用
gh auth login
```

`agent login` だけでは **conductor には渡りません**。`ensemble issue` を使う場合は `ensemble auth login` を別途一度実行してください。

### conductor（SDK）の認証解決順

`@cursor/sdk` は次の順で API key を探します（`ConductorAgent` も同じ）。

1. `apiKey` オプション（明示指定）
2. 環境変数 `CURSOR_API_KEY`
3. `ensemble auth login` で保存したキー（`~/.cursor/sdk/auth.json`）

```bash
# CI やスクリプト向け（ローカル stored login の代わり）
export CURSOR_API_KEY="cursor_..."
```

Dashboard からキーを発行する場合: [Cursor Dashboard → API Keys](https://cursor.com/dashboard/api)

### worker（ACP）の認証

worker は `spawn('agent', ['acp'])` で起動し、**子プロセスの `agent` が自分で認証**します。親（ensemble）は API key を渡しません。子プロセスは `process.env` を継承するため、`CURSOR_API_KEY` を設定していればそれも使えます。

### コマンド別の前提

| コマンド | 必要な認証 |
|---------|-----------|
| `ensemble dispatch worker` | `agent login` または `CURSOR_API_KEY` |
| `ensemble issue` | 上記 + `ensemble auth login`（または `CURSOR_API_KEY`）+ `gh auth login` |
| `pnpm test:integration` | `agent login` + `test-acp.yaml` |
| `pnpm test:e2e` | 上記 + `ensemble auth login` + `gh` + `test-acp.yaml`（`issueUrl` 等） |

### モデル指定

conductor のデフォルトモデルは `composer-2.5`。team 設定でブロックされる場合は `--model` で変更します。

```bash
ensemble issue <issue-url> --repo-root <path> --model auto
```

e2e では `test-acp.yaml` の `conductorModelId`（未指定時 `auto`）を使います。

## 開発

```bash
pnpm install
pnpm build
pnpm ensemble --help

# テスト（testing-strategy.md 参照）
pnpm test:run           # unittest（CI 必須）
pnpm test:integration   # 実 agent acp（test-acp.yaml 要）
pnpm test:e2e           # CLI 縦切り（test-acp.yaml 要）

# e2e 設定（初回）
cp packages/core/test/integration/test-acp.yaml.example \
   packages/core/test/integration/test-acp.yaml
# issueUrl / repoRoot を編集してから:
pnpm test:e2e

# Stage 1: 手動 worker dispatch
ensemble dispatch worker <issue-url> --skill <name> --repo-root <path>

# Stage 3: 手動 reviewer dispatch
ensemble dispatch reviewer <pr-url> --skill <name> --worktree-path <path>
# または --issue-url <url> --repo-root <path> で worktree を解決

# Stage 2: conductor オーケストレーション
ensemble issue <issue-url> --repo-root <path> [--worktree isolated|in-repo] [--profile <name>] [--resume <agentId>] ...
```

**worker 作業ディレクトリ**（`--worktree`）は Conductor セッション開始時に **1 回だけ** resolve し、profile の全 worker が共有する。

| 値 | 意味 |
|----|------|
| `isolated`（既定） | Issue 専用 worktree（`.ensemble/worktrees/issue-N`） |
| `in-repo` | メイン worktree で直接作業する **特別モード** |

**CLI 出力（TTY 時）**

| 出力先 | 内容 |
|--------|------|
| **stdout** | 終了時の **SessionSummary** JSON（e2e / スクリプト向け）。TTY では `operator>` / `conductor>` の対話もここに出る |
| **stderr** | harness テレメトリ（`[harness]` / `[open question]` 等）。開発者向け |

終了 JSON は会話ログではなく exit report（`sendCount`・`stopReason`・`workerResponses` 等の混合物）。resume の正本は sidecar。

### セッションの停止と再開

`ensemble issue` は harness 状態を **sidecar JSON** に永続化する。正常終了・エラー・`Ctrl+C`（SIGINT）/ `SIGTERM` いずれでも best-effort で flush する（状態変化時の増分 flush あり）。

**sidecar の場所**

```
{repoRoot}/.ensemble/sessions/{conductorAgentId}.json
```

**永続化されるもの**

| 項目 | 内容 |
|------|------|
| open question registry | 未回答・回答済みの質問一覧と `sequence` |
| worker `acpSessionId` | worker 名をキーに ACP `session/load` 用 ID |
| `profile` | セッション開始時のスナップショット（resume 時は CLI `--profile` より sidecar を優先） |
| `updatedAt` | 最終 flush 時刻（`--continue` で最新セッション選択に使用、#31） |

**載せないもの**: `worktreePath`（`issueUrl` + `repoRoot` から導出）、SDK 会話本文（SDK store が正本）

**新規セッション**

```bash
ensemble issue https://github.com/org/repo/issues/1 --repo-root .
# JSON 出力の agentId を控える（例: agent-abc123）
```

**再開（同一 Issue の続き）**

```bash
ensemble issue https://github.com/org/repo/issues/1 \
  --repo-root . \
  --resume agent-abc123
```

`--resume` 指定時に sidecar が無い場合は **起動失敗**（`SessionSidecarNotFoundError`）。SDK だけ復元して harness 状態を失う半端 resume はしない。

conductor は SDK `Agent.resume`、worker は ACP `session/load` で復元する（詳細は [ADR 0011](docs/adr/0011-session-sidecar-resume.md)）。

**CLI JSON 出力（破壊的変更）**

| 旧 | 新 |
|----|-----|
| `turnCount` | `sendCount`（完了した `agent.send` 回数） |
| `onTurnComplete`（ライブラリ） | `onSendComplete` |

`stopReason` に `interrupted`（SIGINT/SIGTERM による graceful shutdown）が追加される。

### conductor → worker（常駐）

`ensemble issue` では profile の `workers` で指定した worker が **セッション開始時に attach** され、**終了（または `--resume` 再開）まで `agent acp` プロセスを維持**する。

| 経路 | 用途 |
|------|------|
| **bootstrap（attach）** | 役割・permission・待機 prompt。実作業の開始トリガーではない |
| **`prompt_worker`（conductor SDK tool）** | 常駐 worker へ作業指示（`session/prompt`）。busy 時は per-worker キュー、`preempt: true` で割り込み |
| **`worker.completed` イベント** | 1 ラウンド完了を conductor へ通知（タスク完了の意味ではない） |
| **`ensemble dispatch worker`** | CLI one-shot（常駐モデルとは別経路。検証・手動用） |

**Issue / PR に書いただけでは worker は動かない。** トリガーは conductor の `prompt_worker` のみ（詳細は [ADR 0012](docs/adr/0012-conductor-worker-prompt-roundtrip.md)、[architecture.md §5](docs/architecture.md)）。

### プロファイル

同梱プロファイルは `profiles/` に置き、`build` 時に `dist/profiles/` へコピーされる（詳細は [docs/elements.md](docs/elements.md)）。

```bash
# 省略時 → 同梱 default
ensemble issue <url> --repo-root .

# カスタム（同梱に無い名前は <cwd>/profiles/<name>/ を参照）
ensemble issue <url> --repo-root . --profile custom

# ファイル直接指定
ensemble issue <url> --repo-root . --profile ./my-profile.yaml
```

同梱 `default` の例 (`profiles/default/profile.yaml`):

```yaml
workers:
  - name: main
    kind: worker
materials:
  - id: team
    title: 役割分担
    file: team.md
```

e2e は `agents.ping` + `workers: [ping]` で pong 応答を検証する（`packages/cli/test/e2e/fixtures/e2e-smoke/profile.yaml`）。`prompt_worker` 往復 smoke は `fixtures/e2e-roundtrip/profile.yaml`。

### 人間エスカレーション（非対話環境）

conductor の `ask_human` は質問を **open question（TODO リスト）として登録**する（非ブロッキング）。一覧は `list_open_questions`、詳細は `get_open_question`。オペレータ発話は `agent.send` の user ターンとして届く（system prompt に毎ターン埋め込まない）。

### オペレータ入力と自律ターン予算

- `--max-turns`（デフォルト 5）は **直近のオペレータ入力から conductor が自律的に動けるターン上限**
- オペレータが入力するとカウンタはリセットされる
- 上限到達時は orchestrator が open question「次どうする？」（`source: max_turns`）を自動登録し、conductor は送らず待機する
- オペレータは次ターン開始前に TTY で回答（自由チャット可）
- チャットですでに答えている場合は conductor が `answer_open_question` で代行記録
- 回答は `@inq:<id> <回答>` または未回答が 1 件のときはそのまま入力

```bash
ENSEMBLE_OPERATOR_MESSAGE='@inq:inq-1 yes' ensemble issue ...
```

非 TTY かつ `ENSEMBLE_OPERATOR_MESSAGE` 未設定のとき、open question 待ちでループが進まない（TTY 待機相当）。

認証の詳細は上記 [認証](#認証) を参照。

## ライセンス

MIT
