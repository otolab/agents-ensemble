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
| **Issue 取得** | GitHub REST / GraphQL API | conductor が Issue 本文・コメントを読む・GitHub 監視 | `gh auth login` または `export GITHUB_TOKEN=...` | `GITHUB_TOKEN` / `GH_TOKEN` |

GitHub トークンの解決順（環境変数は config より優先）と `gh auth token` フォールバックの可否は [docs/config.md](docs/config.md) を参照。テンプレはリポジトリ直下の [`config.example.yaml`](config.example.yaml)。

### 初回セットアップ（ローカル）

```bash
# worker 用（agent CLI）
agent login
agent status

# conductor 用（SDK）
pnpm ensemble auth login
pnpm ensemble auth status
pnpm ensemble auth logout

# Issue 取得用（GitHub API トークン。情報取得に gh CLI は不要）
export GITHUB_TOKEN="ghp_..."
# または gh auth login（config で gh auth token フォールバックが有効な場合）
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

worker は preset ごとに別プロセスの ACP adapter を spawn する。**親（ensemble）は API key を渡さない**。子プロセスは `process.env` を継承する。

| preset | 認証の前提 |
|--------|-----------|
| `cursor`（既定） | `agent login` または `CURSOR_API_KEY`（ACP `cursor_login`） |
| `codex` | **`codex login` 済み**（ensemble は `chat-gpt` authenticate で Codex CLI と同じセッションを再利用） |
| `claude` | **Claude Code CLI ログイン済み**（ensemble は ACP authenticate を skip） |
| `pi` | **`pi` 側のモデル/API key 設定**（ensemble は authenticate skip。Cursor 認証とは無関係） |

`codex` preset は子プロセス env に `INITIAL_AGENT_MODE=agent` を設定し、通常の Agent mode（`workspace-write` + `on-request` approval）で起動します。`agent-full-access` / `danger-full-access` は既定で有効になりません。ACP permission request に backend の options がある場合、ensemble は `allow_once` / `reject_once` などの kind に対応する実際の `optionId` を返します。options が無い backend では従来の fallback を使います。

詳細は [ADR 0019](docs/adr/0019-worker-acp-cli-presets.md)。

### コマンド別の前提

| コマンド | 必要な認証 |
|---------|-----------|
| `ensemble issue` | `agent login`（または `CURSOR_API_KEY`）+ `ensemble auth login`（または `CURSOR_API_KEY`）+ `GITHUB_TOKEN` / `GH_TOKEN` または `gh auth login`（config で gh フォールバック有効時） |
| `pnpm test:integration` | `agent login` + `test-acp.yaml` |
| `pnpm test:e2e` | 上記 + `ensemble auth login` + GitHub API トークン + `test-acp.yaml`（`issueUrl` 等） |

### モデル指定

conductor のデフォルトモデルは `default`（`ensemble models list` 上の Auto。`auto` エイリアスも同義）。`--model` で別 id を指定できます。利用可能な id は `ensemble models list` で確認できます（API カタログ。実行時の team ブロックとは一致しない場合あり）。

既定値の解決順（Phase 1 共通）: **CLI `--model` > 環境変数 `CONDUCTOR_MODEL_ID` > `.ensemble/config.yaml` の `conductor.model` > コード内 `default`**。詳細は [docs/config.md](docs/config.md)。

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

`monitor_error` で `toUpperCase` 系エラーが出る場合は `@agents-ensemble/core` **0.2.1 以降**を使用しているか確認してください（`pnpm why @agents-ensemble/core` または `ensemble --version`）。[#158](https://github.com/otolab/agents-ensemble/issues/158) / [#185](https://github.com/otolab/agents-ensemble/issues/185) 参照。

**Issue worktree**（`--worktree`）は Conductor セッション開始時に **1 回だけ** resolve し、**未指定の worker** が ACP 上で作業するディレクトリになる（Issue 用 git worktree の規約）。

| 値 | 意味 |
|----|------|
| `isolated`（既定） | Issue 専用 worktree（`.ensemble/worktrees/issue-N`） |
| `in-repo` | メイン worktree で直接作業する **特別モード** |

**per-worker ACP cwd**（profile の `workers[].workspace`）は Issue worktree **とは別概念**。指定した worker だけ別ディレクトリで ACP を起動する（例: Issue はコード repo、librarian は docs repo）。省略時は上記 Issue worktree を使う。詳細は [docs/elements.md](docs/elements.md)。

**per-worker ACP CLI**（profile の `acp` / `workers[].acp`、またはデフォルト解決）で worker が起動する ACP サーバを選べる。profile に ACP 指定がある worker は CLI / 環境変数で上書きされない。

| ソース | 例 |
|--------|-----|
| profile `workers[].acp` | `preset: claude` または `preset: pi` |
| profile `acp` | 全 worker 共通デフォルト |
| CLI `--default-acp-cli` | `ensemble issue 42 --default-acp-cli codex` または `--default-acp-cli pi` |
| CLI custom | `--default-acp-command my-agent --default-acp-arg acp` |
| 環境変数 | `ENSEMBLE_DEFAULT_ACP_CLI=claude` |
| システムデフォルト | `cursor`（= `agent acp`） |

Built-in preset の command/args は [ADR 0019](docs/adr/0019-worker-acp-cli-presets.md) を参照。`claude` / `codex` / `pi` は `@agents-ensemble/core` の **optionalDependencies** 同梱 bin（→ PATH）を spawn し、**`npx` は使わない**（#229）。optional が欠落し PATH にも無い場合、spawn 前に install 手順付きで失敗する。

**attach 時の認証**: `cursor` は `cursor_login`。`codex` は **`codex login` 済み**前提で `chat-gpt`（Codex CLI セッション再利用）。`claude` / `pi` は ACP authenticate を skip し、各 CLI の既存ログイン/設定を利用（上記 worker 認証表・ADR 0019）。

`pi` preset は `pi` CLI（`@earendil-works/pi-coding-agent`）と adapter `pi-acp` の両方が必要。`pi-acp` があっても `pi` 不在なら別メッセージで促す。

**optionalDependencies と `--no-optional`**

通常の `pnpm install` / `npm i -g @agents-ensemble/cli` では optional パッケージ（`@agentclientprotocol/codex-acp` 等）の install が試行される。`pnpm install --no-optional` や optional install 失敗時は bundled bin が入らない。PATH 上に同名 bin（例: `npm i -g @agentclientprotocol/codex-acp`）が無ければ、`ensemble issue` 起動前（worker attach 前）に `[acp]` 付きエラーと install 手順が stderr に出る。

**CLI 出力（TTY 時）** — 詳細は [docs/session-logging.md](docs/session-logging.md)。

| 出力先 | 内容 |
|--------|------|
| **stdout** | 非 TTY 終了時の **SessionSummary** JSON（`--summary-format auto` 既定） |
| **stderr** | TTY 終了時のテキストサマリ。非 TTY では harness テレメトリ（`[harness]` / `[open question]` 等） |

終了サマリは exit report（会話ログではない）。`--summary-format json|text`・`--include-full-response-text` で制御。フィールド一覧は [docs/session-metrics.md](docs/session-metrics.md)。resume の正本は sidecar。

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
| worker `acpCwd` | 上記 session を load するときの cwd（profile `workspace` 解決後の絶対パス。resume 時に profile と照合） |
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
| **startWorkers（attach + init prompt）** | 役割・permission・待機 prompt。実作業の開始トリガーではない。API: `WorkerSession.startWorkers()`（`bootstrap()` は deprecated） |
| **`prompt_worker`（conductor SDK tool）** | 常駐 worker へ作業指示（`session/prompt`）。busy 時は per-worker キュー、`preempt: true` で割り込み |
| **`worker.completed` イベント** | 1 ラウンド完了を conductor へ通知（タスク完了の意味ではない） |

**Issue / PR に書いただけでは worker は動かない。** トリガーは conductor の `prompt_worker` のみ（詳細は [ADR 0012](docs/adr/0012-conductor-worker-prompt-roundtrip.md)、[architecture.md §5](docs/architecture.md)）。

### プロファイル

同梱プロファイルは `profiles/` に置き、`build` 時に `dist/profiles/` へコピーされる（詳細は [docs/elements.md](docs/elements.md)）。

```bash
# 省略時 → config profile.default / ENSEMBLE_DEFAULT_PROFILE / 同梱 default
ensemble issue <url> --repo-root .

# config または環境変数でデフォルト指定（--profile 未指定時）
export ENSEMBLE_DEFAULT_PROFILE=my-team
ensemble issue <url> --repo-root .
# または .ensemble/config.yaml に profile.default: my-team

# カスタム（同梱に無い名前は <cwd>/profiles/<name>/ を参照）
ensemble issue <url> --repo-root . --profile custom

# ファイル直接指定
ensemble issue <url> --repo-root . --profile ./my-profile.yaml
```

| 設定 | config キー（推奨） | 環境変数（上書き用） | 優先順位（Phase 1 共通） |
|------|----------------------|----------------------|--------------------------|
| 既定 team profile | `profile.default` | `ENSEMBLE_DEFAULT_PROFILE` | CLI `--profile` > env > project config > user config > 同梱 default |
| conductor モデル | `conductor.model` | `CONDUCTOR_MODEL_ID` | CLI `--model` > env > config > `default` |
| worker ACP preset（profile 未指定 worker） | `acp.defaultPreset` | `ENSEMBLE_DEFAULT_ACP_CLI` | profile/worker `acp` > CLI `--default-acp-*` > env > config > `cursor` |
| オペレータ 1 回注入 | — | `ENSEMBLE_OPERATOR_MESSAGE` | — |

横断設定の正本・全キー一覧: [docs/config.md](docs/config.md)。**token 等の秘密情報は config に書かない。**

同梱 `implementer-and-reviewer` の例 (`profiles/implementer-and-reviewer/profile.yaml`)。`--profile default` は同じプロファイルのエイリアス:

```yaml
workers:
  - name: main
    kind: worker
  - name: librarian
    kind: librarian
    workspace: ../docs-repo   # 任意: この worker だけ別 ACP cwd
materials:
  - id: team
    title: 役割分担
    file: team.md
```

e2e は `agents.ping` + `workers: [ping]` で pong 応答を検証する（`packages/cli/test/e2e/fixtures/e2e-smoke/profile.yaml`）。`prompt_worker` 往復 smoke は `fixtures/e2e-roundtrip/profile.yaml`。per-worker workspace 用 fixture は `fixtures/e2e-workspace/profile.yaml`（本 PR では e2e 未実行。integration で fake ACP 上の cwd を検証済み）。

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


### TTY と IDE 内ターミナル

Ink TUI のオペレータ入力欄は Emacs 風ショートカット（`Ctrl+a` / `Ctrl+k` + `Ctrl+y` 等）をサポートする。macOS では **Option を Meta（+Esc）** に設定しないと `Alt+b` / `Alt+f` が特殊文字入力になり効かない（iTerm2: Profiles → Keys、Terminal.app: Use Option as Meta key）。Cursor 等の **IDE 内ターミナル** では、IDE が `Ctrl+k` 等を先取りすることがある — ターミナルにフォーカスがあることと IDE のキーバインド設定を確認する。

詳細: [docs/cli-text-input-keybindings.md](docs/cli-text-input-keybindings.md)

### プロセス待機（post-loop）

TTY 実行時、自律作業が一段落（conductor `finished` + 待ち事項なし）しても **デフォルトではプロセスを維持**する。追加指示を入力するか、`/exit`（または `exit`）で終了する。終了時は **テキストサマリを stderr** に出力（`--summary-format json` で stdout JSON に切替可）。

`/exit` 終了時（isolated モード）は当該 Issue の worktree を削除する（[git worktree と依存インストール](#git-worktree-と依存インストール)）。

- `--no-wait`: 自律ループ停止後に即終了（従来動作）
- 非 TTY / CI: 従来どおり自動終了

詳細は [docs/adr/0013-process-lifecycle-vs-autonomous-loop.md](docs/adr/0013-process-lifecycle-vs-autonomous-loop.md)。

認証の詳細は上記 [認証](#認証) を参照。

## ライセンス

MIT
