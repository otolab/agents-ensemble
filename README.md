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
| **worker** | `agent acp` | `ensemble issue` の常駐 worker | `agent login` | `CURSOR_API_KEY`（子プロセスへ継承） |
| **Issue 取得** | `gh` CLI | conductor が Issue 本文・コメントを読む | `gh auth login` | `GH_TOKEN` 等 |

### 初回セットアップ（ローカル）

```bash
# worker 用（agent CLI）
agent login
agent status

# conductor 用（SDK）
pnpm ensemble auth login
pnpm ensemble auth status
pnpm ensemble auth logout

# Issue 取得用
gh auth login
```

`agent login` だけでは **conductor には渡りません**。`ensemble issue` を使う場合は `ensemble auth login` を別途一度実行してください。

### conductor（SDK）の ripgrep

local agent は workspace scan（`.gitignore` / `.cursorignore`）に **ripgrep** を使う（[SDK ドキュメント](https://cursor.com/docs/sdk/typescript)）。`ensemble` は起動時に `@cursor/sdk-<platform>-<arch>` 同梱の `rg` を `CURSOR_RIPGREP_PATH` に設定する。同梱が無い場合は PATH の `rg` にフォールバックする。どちらも無いと stderr に `Ripgrep path not configured` が出る（ignore マッピングが効かない）。

```bash
# 手動で指定する場合
export CURSOR_RIPGREP_PATH="$(command -v rg)"
```

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

`ensemble auth logout` は stored login（`~/.cursor/sdk/auth.json`）のみを削除します。`CURSOR_API_KEY` には影響しません。

### conductor send の認証エラーと in-process 再接続

長時間アイドルや PC の sleep/wakeup 後、SDK の gRPC 接続が stale になり `Authentication error` や message 欠落の `status: "error"` が返ることがあります（同一 API key は有効なまま）。`ensemble issue` は **同一 `agentId` を維持したまま** `close` → `Agent.resume(sameId)` → 失敗していた send を 1 回再試行します。

ACP worker は別プロセスのため、この間も生存します。自動再接続でも復旧できない場合（真の key 失効など）は、従来どおり stderr の `[auth]` 手順（手動 `logout` → `login` → `--resume` / `--continue`）が表示されます。

- **非 TTY / CI**: 上記 in-process `resume` のみ（`CURSOR_API_KEY` の挙動変更なし）
- **`agent.reload()`**: filesystem config 再読込用で、接続復旧には使いません
- **起動時** `Agent.create` / `Agent.resume` の auth 失敗: 本 Issue スコープ外（別 Issue 候補）

詳細: [docs/conductor-auth-reconnect.md](docs/conductor-auth-reconnect.md)

conductor send が認証エラーを返し、上記の自動再接続でも復旧できないとき、stderr に `[auth]` 付きの復旧手順が出ます。典型:

```bash
ensemble auth logout && ensemble auth login
ensemble issue <issue-url> --repo-root <path> --resume <agentId>   # または --continue
```

`agentId` は終了時 stdout JSON の `agentId` を参照。SDK 側の transparent reconnect は upstream 改善待ち（forum 上で確認済み）。harness は `Agent.resume(sameId)` による in-process 再接続を実装済み。

### worker（ACP）の認証

worker は `spawn('agent', ['acp'])` で起動し、**子プロセスの `agent` が自分で認証**します。親（ensemble）は API key を渡しません。子プロセスは `process.env` を継承するため、`CURSOR_API_KEY` を設定していればそれも使えます。

### コマンド別の前提

| コマンド | 必要な認証 |
|---------|-----------|
| `ensemble issue` | `agent login`（または `CURSOR_API_KEY`）+ `ensemble auth login`（または `CURSOR_API_KEY`）+ `gh auth login` |
| `pnpm test:integration` | `agent login` + `test-acp.yaml` |
| `pnpm test:e2e` | 上記 + `ensemble auth login` + `gh` + `test-acp.yaml`（`issueUrl` 等） |

### モデル指定

conductor のデフォルトモデルは `default`（`ensemble models list` 上の Auto。`auto` エイリアスも同義）。`--model` で別 id を指定できます。利用可能な id は `ensemble models list` で確認できます（API カタログ。実行時の team ブロックとは一致しない場合あり）。

環境変数 `CONDUCTOR_MODEL_ID` でも上書きできます（integration / e2e の `test-acp.yaml` の `conductorModelId` と同じ優先順位: CLI `--model` > 環境変数 > `default`）。

```bash
ensemble models list
ensemble models list --json
ensemble issue <issue-url> --repo-root <path>              # default（Auto）
ensemble issue <issue-url> --repo-root <path> --model auto # default と同義
```

`<issue-url>` にはフル GitHub Issue URL のほか、`--repo-root` の `origin` から解決する **Issue 番号**（`31` や `#31`）も指定できます。bash/zsh では `#` 以降がコメントになるため、`#31` は **クォート**してください。

```bash
ensemble issue 31 --repo-root .
ensemble issue '#31' --repo-root .
```

e2e では `test-acp.yaml` の `conductorModelId`（未指定時 `auto`）を使います。

## インストール

npm から CLI をグローバルインストールできます（Node.js 22 以上）。

```bash
npm install -g @agents-ensemble/cli
# または
pnpm add -g @agents-ensemble/cli

ensemble --help
```

ライブラリとして `@agents-ensemble/core` を使う場合:

```bash
pnpm add @agents-ensemble/core
```

リリース手順は [docs/RELEASE_GUIDE.md](docs/RELEASE_GUIDE.md) を参照。

## 開発

**前提**: Node.js 22、pnpm 10.12.1 以上（`package.json` の `packageManager` に合わせる。Corepack 利用可）。

```bash
corepack enable   # 初回のみ（任意）
pnpm install
pnpm build
pnpm ensemble --help
```

### git worktree と依存インストール

`ensemble issue` の isolated モードは Issue ごとに `.ensemble/worktrees/issue-N` を切る。各 worktree は独自の `node_modules` が必要。

TTY + post-loop で `/exit` して正常終了したとき、**isolated worktree は自動削除**される（未コミット変更がある場合は削除せず stderr に警告）。`--worktree in-repo` では削除しない。ローカルブランチ `ensemble/issue-N` は残る。`--continue` で再開するときは worktree が無ければ再作成される。

本リポジトリは pnpm の **global virtual store**（`enableGlobalVirtualStore`）を有効にしている。メイン worktree で一度 `pnpm install` すると、同一マシン上の **2 本目以降の worktree** では install がほぼ symlink 張り替えのみになる（[pnpm: Git Worktrees](https://pnpm.io/git-worktrees)）。

```bash
# メイン worktree で warm-up（初回 or lockfile 更新後）
pnpm install

# worktree 作成後（ensemble が切った .ensemble/worktrees/issue-N など）
cd .ensemble/worktrees/issue-42
pnpm install --frozen-lockfile
```

CI では global virtual store は自動無効（cold cache のため）。

```bash
# テスト（testing-strategy.md 参照）
pnpm test:run           # unittest（CI 必須）
pnpm test:integration   # 実 agent acp（test-acp.yaml 要）
pnpm test:e2e           # CLI 縦切り（test-acp.yaml 要）

# e2e 設定（初回）
cp packages/core/test/integration/test-acp.yaml.example \
   packages/core/test/integration/test-acp.yaml
# issueUrl / repoRoot を編集してから:
pnpm test:e2e

# Stage 2: conductor オーケストレーション
ensemble issue <issue-url> --repo-root <path> [--worktree isolated|in-repo] [--profile <name>] [--resume <agentId>] [--continue] [--no-github-monitor] [--github-monitor-debounce-ms <n>] ...
# <issue-url> はフル URL または 31 / '#31' 等の番号 shorthand 可（# はクォート）
```

**GitHub 監視**（既定で有効）: セッション中に Issue コメント・関連 PR のレビュー / CI 完了を `gh` で poll し、debounce 後に conductor へ `## GitHub 更新` を届ける（自動 `prompt_worker` なし）。詳細は [docs/harness-events.md](docs/harness-events.md) §2.5。

| フラグ | 意味 |
|--------|------|
| `--no-github-monitor` | GitHub 更新監視を無効化 |
| `--github-monitor-debounce-ms <n>` | 更新通知の debounce（ms）。デフォルト 30000 |

**worker 作業ディレクトリ**（`--worktree`）は Conductor セッション開始時に **1 回だけ** resolve し、profile の全 worker が共有する。

| 値 | 意味 |
|----|------|
| `isolated`（既定） | Issue 専用 worktree（`.ensemble/worktrees/issue-N`） |
| `in-repo` | メイン worktree で直接作業する **特別モード** |

**CLI 出力（TTY 時）** — 詳細は [docs/session-logging.md](docs/session-logging.md)。

| 出力先 | 内容 |
|--------|------|
| **stdout** | 終了時の **SessionSummary** JSON。TTY では `operator>` / `conductor>` の対話もここ |
| **stderr** | harness テレメトリ（`[harness]` / `[open question]` 等） |

終了 JSON は exit report（会話ログではない）。resume の正本は sidecar。

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
ensemble issue 31 --repo-root .
# またはフル URL:
ensemble issue https://github.com/org/repo/issues/1 --repo-root .
# JSON 出力の agentId を控える（例: agent-abc123）
```

**再開（同一 Issue の続き）**

`--continue` は同一 `issueUrl` + `repoRoot` の sidecar のうち `updatedAt` が最新のものを自動選択する（`--resume` と排他）。

```bash
ensemble issue https://github.com/org/repo/issues/1 \
  --repo-root . \
  --continue
```

stderr に選んだ `conductorAgentId` が `[continue] resuming session: conductorAgentId=...` として出る。sidecar が無い場合は明確なエラーで終了（新規開始なら `--continue` なし）。

`conductorAgentId` を直接指定する場合:

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

`ensemble issue` では profile の `workers` で指定した worker が **セッション開始時に attach** され、**終了（または `--resume` / `--continue` 再開）まで `agent acp` プロセスを維持**する。

| 経路 | 用途 |
|------|------|
| **bootstrap（attach）** | 役割・permission・待機 prompt。実作業の開始トリガーではない |
| **`prompt_worker`（conductor SDK tool）** | 常駐 worker へ作業指示（`session/prompt`）。busy 時は per-worker キュー、`preempt: true` で割り込み |
| **`worker.completed` イベント** | 1 ラウンド完了を conductor へ通知（タスク完了の意味ではない） |

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

- **TTY / `ENSEMBLE_OPERATOR_MESSAGE` あり**: デフォルトは **無制限**（`--no-max-turns` / `--max-turns 0` と同等）
- **非 TTY / CI**: デフォルトは **5**（暴走防止）
- `--max-turns <n>` で上限を明示指定できる（`0` は無制限）
- `--no-max-turns` でリミットを無効化できる
- オペレータが入力するとカウンタはリセットされる
- 上限到達時（リミット有効時のみ）は orchestrator が open question「次どうする？」（`source: max_turns`）を自動登録し、conductor は送らず待機する
- オペレータは次ターン開始前に TTY で回答（自由チャット可）
- チャットですでに答えている場合は conductor が `answer_open_question` で代行記録
- TTY（Ink TUI）では **Shift+↑/↓ で open question を選択**し、入力欄から回答を送信する（↑/↓ は複数行入力のカーソル移動）
- 非 TTY では未回答が 1 件のときはそのまま入力で回答、複数件のときは自由な指示として扱う

```bash
ENSEMBLE_OPERATOR_MESSAGE='yes, continue' ensemble issue ...
```

非 TTY かつ `ENSEMBLE_OPERATOR_MESSAGE` 未設定のとき、open question 待ちでループが進まない（TTY 待機相当）。

### プロセス待機（post-loop）

TTY 実行時、自律作業が一段落（conductor `finished` + 待ち事項なし）しても **デフォルトではプロセスを維持**する。追加指示を入力するか、`/exit`（または `exit`）で終了する。終了 JSON はプロセス終了時に stdout へ出力（従来どおり）。

`/exit` 終了時（isolated モード）は当該 Issue の worktree を削除する（[git worktree と依存インストール](#git-worktree-と依存インストール)）。

- `--no-wait`: 自律ループ停止後に即終了（従来動作）
- 非 TTY / CI: 従来どおり自動終了

詳細は [docs/adr/0013-process-lifecycle-vs-autonomous-loop.md](docs/adr/0013-process-lifecycle-vs-autonomous-loop.md)。

認証の詳細は上記 [認証](#認証) を参照。

## ライセンス

MIT
