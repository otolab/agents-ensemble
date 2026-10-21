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

Pi backend の初回セットアップ、resource root、provider 認証、`ensemble auth` / `ensemble models list`、missing key / 401 からの復旧は [Pi conductor セットアップと認証](https://github.com/otolab/agents-ensemble/blob/main/docs/pi-conductor-setup.md) が正本です。Pi の user root は `~/.ensemble/pi/`、project root は `<repoRoot>/.ensemble/pi/` が既定で、`conductor.pi.agentDir` / `conductor.pi.projectDir` で上書きできます。

Pi の認証 CLI は backend に分岐します。Cursor は Cursor SDK のログイン、Pi は provider 単位のログインです。TTY の動作、OAuth の stderr 出力、project OAuth の制約、認証優先順、復旧手順は [Pi conductor セットアップと認証](https://github.com/otolab/agents-ensemble/blob/main/docs/pi-conductor-setup.md) を参照してください。

Pi は headless の `createAgentSession` を使い、Pi CLI の `<cwd>/.pi/` 設定とは独立しています。resource discovery、`settings.json` の headless 対応範囲、`models.json`、MCP の制約は [config.md](https://github.com/otolab/agents-ensemble/blob/main/docs/config.md) と [ADR 0025](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0025-conductor-agent-backend-sdk-and-pi.md) を参照してください。

headless conductor の設定キーと create / reload / resume の適用範囲は [config.md の headless 対応範囲](https://github.com/otolab/agents-ensemble/blob/main/docs/config.md#settingsjson-の-headless-対応範囲) を参照してください。

Pi の MCP transport、OAuth、resource tools、resume 時の制約は [ADR 0025](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0025-conductor-agent-backend-sdk-and-pi.md) にまとめています。

backend はセッション開始時に選択され、resume の途中では切り替えられません。system prompt の渡し方、認証、resume の差分は [ADR 0025](../adr/0025-conductor-agent-backend-sdk-and-pi.md) にまとまっています。

backend を選んだ後の主経路は共通です。リポジトリのディレクトリで、対象 Issue を同じ `ensemble issue <url>` コマンドに渡します。

## permission 停滞警告の閾値

`ensemble issue` の `--permission-deadlock-stall-ms <n>` で、worker の permission が停滞したときに警告・conductor 通知を出すまでの時間を上書きできます。既定値は **`300_000ms`（300 秒）**です。設定値の解決順と API 名は [設定値リファレンス](https://github.com/otolab/agents-ensemble/blob/main/docs/settings.md) を参照してください。poll 間隔と worker UI の挙動はこのオプションでは変更しません。

## 最小クイックスタート

初回だけ、worker・選択した conductor backend・GitHub API の認証を準備します。

既定の `cursor` preset は、npm パッケージに含まれない Cursor Agent CLI の `agent` コマンドを使用します。先に [Cursor Agent CLI の公式インストール手順](https://cursor.com/docs/cli) に従ってインストールしてください。

| 対象 | 準備 |
|------|------|
| worker（既定の Cursor ACP） | `agent login` |
| conductor（Cursor SDK、既定） | `ensemble auth login` |
| conductor（Pi、API key） | `ensemble auth login --provider <id>`（TTY の secret prompt） |
| conductor（Pi、OAuth） | `ensemble auth login --provider <id>`（TTY。URL / device code は stderr） |
| GitHub API（gh CLI を使う場合） | `gh auth login` |

```bash
# worker（既定の Cursor ACP）
agent login

# conductor（Cursor SDK を使う場合）
ensemble auth login

# conductor（Pi を使う場合。provider 省略時は settings.json から解決）
ensemble auth login --provider <provider-id>
ensemble auth status
ensemble models list

# GitHub API（gh CLI を使う場合）
gh auth login
```

GitHub API トークンを直接渡す場合は、`gh auth login` の代わりに `GITHUB_TOKEN` または `GH_TOKEN` を設定してください。

リポジトリを clone したディレクトリで、対象 Issue を指定して起動します。

```bash
cd /path/to/your/repository
ensemble issue https://github.com/OWNER/REPOSITORY/issues/123
```

人間との TTY 対話を operator-agent に委ねる場合は `ensemble operator-agent [--repo-root <path>]` を使います。Issue セッションとは別の agent session で起動し、backend・model・profile・認証は conductor の設定を共有します。Pi backend ではユーザー／プロジェクト側の Pi extension を operator session に読み込みません。

operator-agent は既定で前回の operator 会話を再開します。初回起動では新しい session を作り、backend 固有の会話履歴は backend の保存先に、再開に使う backend・repoRoot・agentId は `.ensemble/operator-agent/session.json` に保存します。TTY の EOF、Ctrl+C（SIGINT）、SIGTERM など通常の終了では agent を閉じて再開可能な状態を保ちます。`/exit` または `exit` は連続性を明示的に切り、次回起動を新規 session にします。既存の会話を残したまま新しい会話を始める場合は `ensemble operator-agent --new` を使います。強制終了や電源断では終了時の flush は保証されません。

TTY の会話では `user>` を控えめに、`operator>` をシアンで表示し、operator の本文は次の行から表示します。応答の段落間の空行は保たれ、連続する空行は最大 1 行に整理されます。起動・終了・エラー表示にも同じ余白を設けます。`NO_COLOR` が設定されている場合は色を使いません。

`.ensemble/sessions/` の保存済み sidecar から得られる情報はスナップショットとして読み取り専用です。稼働中 harness への UDS live control が使える場合に限り、`list_live_open_questions` で一覧を取得し、operator が選んだ回答を `answer_live_open_question` で送れます。また `send_operator_message` から conductor へ指示を送り、`next`（既定）・`idle`・`interrupt` の配信時期を指定できます。harness 停止中または接続不能ならライブ操作はエラーになり、保存 YAML への自動 fallback はしません。メッセージ送信の成功応答はキュー受理を示し、処理完了の確認ではありません。セキュリティとログの扱いは [session logging](../session-logging.md#4-sidecar-と-open-question-yaml) を参照してください。

初回の作業指示は、Issue 参照の後ろに CLI 引数として渡せます。複数の引数はスペース 1 つで結合され、前後の空白は除かれます。

```bash
ensemble issue https://github.com/OWNER/REPOSITORY/issues/123 受け入れ条件を確認して実装してください
ensemble issue https://github.com/OWNER/REPOSITORY/issues/123 "まずテストから始めてください"
```

これは TTY / 非 TTY の両方で、セッション開始後に 1 回だけ `operator.message` として conductor へ送られます。CLI メッセージと `ENSEMBLE_OPERATOR_MESSAGE` は併用できず、両方が空でない場合は起動エラーになります。`--continue` / `--resume` では CLI メッセージは注入されず、stderr に警告が出ます。詳細は [オペレータ入力](https://github.com/otolab/agents-ensemble/blob/main/docs/operator-input.md) と [設定値リファレンス](https://github.com/otolab/agents-ensemble/blob/main/docs/settings.md) を参照してください。

TTY で worktree とセッション状態を残してプロセスを閉じるには `/close` を入力します。正常に閉じると exit code 0 で終了し、再開するときは同じ Issue に `--continue` を付けます。`/exit` は isolated worktree の cleanup を試みて終了します（cleanup に失敗しても warning のみで exit code は 0、[#448](https://github.com/otolab/agents-ensemble/issues/448)）。Ctrl+C / SIGINT は `interrupted` として中断し、worktree cleanup を行いません。詳しくは [オペレータ入力](https://github.com/otolab/agents-ensemble/blob/main/docs/operator-input.md) を参照してください。

## 利用者向け doc

設定・TUI・認証の詳細は README に重複させず、次の正本を参照してください。

| 文書 | 内容 |
|------|------|
| [Pi conductor セットアップと認証](https://github.com/otolab/agents-ensemble/blob/main/docs/pi-conductor-setup.md) | Pi backend の resource root、provider 認証、`auth/models` CLI、障害復旧 |
| [設定値リファレンス](https://github.com/otolab/agents-ensemble/blob/main/docs/settings.md) | CLI / 環境変数 / config / profile / TUI と user-wide conductor instructions |
| [ensemble 共通設定](https://github.com/otolab/agents-ensemble/blob/main/docs/config.md) | `.ensemble/config.yaml` の書き方・スキーマ・MCP 設定 |
| [オペレータ入力](https://github.com/otolab/agents-ensemble/blob/main/docs/operator-input.md) | TUI レイアウトと入力の利用者向け挙動 |
| [TUI ショートカット](https://github.com/otolab/agents-ensemble/blob/main/docs/cli-text-input-keybindings.md) | 入力ショートカットの対応状況と実装方針 |
| [ユーザ定義 team profile](https://github.com/otolab/agents-ensemble/blob/main/docs/user-teams.md) | `~/.ensemble/teams/` の profile 配置と解決順 |
| [conductor 認証再接続](https://github.com/otolab/agents-ensemble/blob/main/docs/conductor-auth-reconnect.md) | send 経路の in-process 再接続設計 |
| [Session usage と終了サマリ](https://github.com/otolab/agents-ensemble/blob/main/docs/session-metrics.md) | 終了サマリの開始時刻（`startedAt`）・経過時間（`durationMs`）と、TTY / JSON の token・cache・cost・compaction 表示および取得範囲 |

GitHub 上の全ドキュメントは [docs/README.md](https://github.com/otolab/agents-ensemble/blob/main/docs/README.md) から参照できます。
