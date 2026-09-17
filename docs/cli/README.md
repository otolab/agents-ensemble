# agents-ensemble CLI

> **正本:** npm の `@agents-ensemble/cli` と GitHub の CLI 利用者向け入口。インストール・最小クイックスタート・doc 索引を掲載します。

`@agents-ensemble/cli` は、GitHub Issue を起点に conductor が worker を起動・制御する CLI です。

## インストール

Node.js 22 以上を用意し、npm または pnpm でインストールします。

```bash
npm install -g @agents-ensemble/cli
# または
pnpm add -g @agents-ensemble/cli

ensemble --help
```

## 最小クイックスタート

初回だけ、worker・conductor・GitHub API の認証を準備します。

既定の `cursor` preset は、npm パッケージに含まれない Cursor Agent CLI の `agent` コマンドを使用します。先に [Cursor Agent CLI の公式インストール手順](https://cursor.com/docs/cli) に従ってインストールしてください。

```bash
# worker（既定の Cursor ACP）
agent login

# conductor（Cursor SDK）
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

## 独立 reviewer の手動起動

既存の Issue worktree で、conductor の常駐 worker とは別の ACP reviewer session を 1 回だけ起動できます。

```bash
ensemble dispatch reviewer https://github.com/OWNER/REPOSITORY/pull/456 \
  --skill pr-review \
  --worktree-path /path/to/repository/.ensemble/worktrees/issue-123
```

`--worktree-path` を省略する場合は、Issue URL と clone root から既存 worktree を解決します。

```bash
ensemble dispatch reviewer https://github.com/OWNER/REPOSITORY/pull/456 \
  --skill pr-review \
  --issue-url https://github.com/OWNER/REPOSITORY/issues/123 \
  --repo-root /path/to/repository
```

reviewer の結果は `prUrl`、`worktree`、`stopReason` を含む JSON で出力されます。worktree は事前に worker dispatch 等で作成しておいてください。

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
