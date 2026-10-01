# agents-ensemble CLI

> **正本:** npm の `@agents-ensemble/cli` と GitHub の CLI 利用者向け入口。インストール・最小クイックスタート・doc 索引を掲載します。

`@agents-ensemble/cli` は、GitHub Issue を起点に conductor が worker を起動・制御する CLI です。conductor は Cursor SDK（既定）または Pi（opt-in）を選べます。

## インストール

Node.js 22 以上を用意し、npm または pnpm でインストールします。

```bash
npm install -g @agents-ensemble/cli
# または
pnpm add -g @agents-ensemble/cli

ensemble --help
```

## Conductor backend の選択

既定の backend は `cursor`（Cursor SDK）です。Pi を使う場合は、リポジトリの `.ensemble/config.yaml` またはユーザ設定の `~/.ensemble/config.yaml` で `conductor.backend` を `pi` にします。

```yaml
conductor:
  backend: pi
```

Pi backend は Pi の設定ファイルを読みます。モデル設定と認証情報は、次のいずれかの `settings.json` / `auth.json` に用意してください（プロジェクト設定がユーザ設定を上書きします）。

| 層 | パス |
|----|------|
| ユーザ | `~/.ensemble/pi/` |
| プロジェクト | `<repoRoot>/.ensemble/pi/` |

Pi backend では `ensemble auth login` は認証を設定しません。このコマンドは Cursor SDK 向けです。Pi の provider 認証は Pi の `auth.json` / `settings.json`（および Pi が提供する設定方法）を使います。`~/.ensemble/pi/` と `<repoRoot>/.ensemble/pi/` の `settings.json` / `auth.json` / `models.json` / `extensions/` / `skills/` / `prompts/` / `themes/` を解決し、`conductor.pi.agentDir` / `conductor.pi.projectDir` で root のみ上書きできます。skills は compiled system prompt に追加され、prompts は `/name args` として展開されます。themes は headless conductor で読み込み・project 同名解決まで行いますが、TUI renderer がないため色・表示設定は適用しません。`.ensemble/pi/SYSTEM.md` / `APPEND_SYSTEM.md` は conductor の system prompt には使わず、modular-prompt のコンパイル結果を優先します。

MCP は #354 の harness 内蔵 in-process bridge で Pi に接続します。解決済み `mcp.json` がある場合は MCP tools が、設定が無い場合も harness tools が、最小起動から常に有効です。bridge は Pi ExtensionAPI extension ではなく、harness が管理する tool adapter です。設計上の前提と制限は [ADR 0025](../adr/0025-conductor-agent-backend-sdk-and-pi.md) を参照してください。

backend はセッション開始時に選択され、resume の途中では切り替えられません。system prompt の渡し方、認証、resume の差分は [ADR 0025](../adr/0025-conductor-agent-backend-sdk-and-pi.md) にまとまっています。

backend を選んだ後の主経路は共通です。リポジトリのディレクトリで、対象 Issue を同じ `ensemble issue <url>` コマンドに渡します。

## 最小クイックスタート

初回だけ、worker・選択した conductor backend・GitHub API の認証を準備します。

既定の `cursor` preset は、npm パッケージに含まれない Cursor Agent CLI の `agent` コマンドを使用します。先に [Cursor Agent CLI の公式インストール手順](https://cursor.com/docs/cli) に従ってインストールしてください。

| 対象 | 準備 |
|------|------|
| worker（既定の Cursor ACP） | `agent login` |
| conductor（Cursor SDK、既定） | `ensemble auth login` |
| conductor（Pi） | 上記の Pi `settings.json` / `auth.json` を準備。`ensemble auth` は使わない |
| GitHub API（gh CLI を使う場合） | `gh auth login` |

```bash
# worker（既定の Cursor ACP）
agent login

# conductor（Cursor SDK を使う場合だけ）
ensemble auth login

# GitHub API（gh CLI を使う場合）
gh auth login
```

GitHub API トークンを直接渡す場合は、`gh auth login` の代わりに `GITHUB_TOKEN` または `GH_TOKEN` を設定してください。

リポジトリを clone したディレクトリで、対象 Issue を指定して起動します。

```bash
cd /path/to/your/repository
ensemble issue https://github.com/OWNER/REPOSITORY/issues/123
```

初回の作業指示は、Issue 参照の後ろに CLI 引数として渡せます。複数の引数はスペース 1 つで結合され、前後の空白は除かれます。

```bash
ensemble issue https://github.com/OWNER/REPOSITORY/issues/123 受け入れ条件を確認して実装してください
ensemble issue https://github.com/OWNER/REPOSITORY/issues/123 "まずテストから始めてください"
```

これは TTY / 非 TTY の両方で、セッション開始後に 1 回だけ `operator.message` として conductor へ送られます。CLI メッセージと `ENSEMBLE_OPERATOR_MESSAGE` は併用できず、両方が空でない場合は起動エラーになります。`--continue` / `--resume` では CLI メッセージは注入されず、stderr に警告が出ます。詳細は [オペレータ入力](https://github.com/otolab/agents-ensemble/blob/main/docs/operator-input.md) と [設定値リファレンス](https://github.com/otolab/agents-ensemble/blob/main/docs/settings.md) を参照してください。

## 利用者向け doc

設定・TUI・認証の詳細は README に重複させず、次の正本を参照してください。

| 文書 | 内容 |
|------|------|
| [設定値リファレンス](https://github.com/otolab/agents-ensemble/blob/main/docs/settings.md) | CLI / 環境変数 / config / profile / TUI の設定一覧と解決順 |
| [ensemble 共通設定](https://github.com/otolab/agents-ensemble/blob/main/docs/config.md) | `.ensemble/config.yaml` の書き方・スキーマ・MCP 設定 |
| [オペレータ入力](https://github.com/otolab/agents-ensemble/blob/main/docs/operator-input.md) | TUI レイアウトと入力の利用者向け挙動 |
| [TUI ショートカット](https://github.com/otolab/agents-ensemble/blob/main/docs/cli-text-input-keybindings.md) | 入力ショートカットの対応状況と実装方針 |
| [ユーザ定義 team profile](https://github.com/otolab/agents-ensemble/blob/main/docs/user-teams.md) | `~/.ensemble/teams/` の profile 配置と解決順 |
| [conductor 認証再接続](https://github.com/otolab/agents-ensemble/blob/main/docs/conductor-auth-reconnect.md) | send 経路の in-process 再接続設計 |

GitHub 上の全ドキュメントは [docs/README.md](https://github.com/otolab/agents-ensemble/blob/main/docs/README.md) から参照できます。
