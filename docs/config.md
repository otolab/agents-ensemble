# ensemble 共通設定（config.yaml）

> **正本:** `.ensemble/config.yaml` の配置・書き方・スキーマと conductor MCP 設定。本書以外の設定層の一覧・解決パターンは [settings.md](settings.md) を参照します。

`.ensemble/config.yaml` は harness 横断の設定の正本。team-profile（`profile.yaml`）や conductor backend の認証とは別系統。

conductor に渡す MCP 設定もこの config.yaml とは別の JSON ファイルで管理する（下記の [Conductor MCP 設定](#conductor-mcp-設定mcpjson) を参照）。

## 配置と解決順

| 層 | パス | 優先度 |
|----|------|--------|
| プロジェクト | `<repoRoot>/.ensemble/config.yaml` | 高（上書き） |
| ユーザ | `~/.ensemble/config.yaml` | 低（既定） |

- 両方ある場合は **deep merge**（プロジェクトがユーザを上書き）
- どちらも無い場合は **コード内デフォルト**
- **環境変数・CLI フラグは config より優先**（明示上書き）

### 設定項目ごとの解決順（Phase 1）

すべての Phase 1 キーで次の順序を **実装・テストで固定**している:

```
CLI 明示指定 > 環境変数 > project .ensemble/config.yaml > user ~/.ensemble/config.yaml > コード内デフォルト
```

`loadEnsembleConfig(repoRoot)` は user → project の順で merge した `EnsembleConfig` を返す。各 `resolve*Setting` はその merged config を **config 層**として参照する。

`conductor.backend` はこの共通順序の例外です。CLI / 環境変数による上書きはなく、選択した profile の `profile.conductor.backend` > user / project の deep merge 済み `config.conductor.backend` > `cursor` の順で解決します。

`ensemble issue` 起動時（GitHub monitor / Issue コンテキスト取得より前）に config を読み込む。

## テンプレート

リポジトリ直下の [`config.example.yaml`](../config.example.yaml) をコピーして使う。実運用の config は `.ensemble/` 配下のため **gitignore 対象**（方針 A）。チームで共有したい非秘密項目だけ example を更新する。

```bash
mkdir -p .ensemble
cp config.example.yaml .ensemble/config.yaml
# またはユーザ全体
mkdir -p ~/.ensemble
cp config.example.yaml ~/.ensemble/config.yaml
```

## スキーマ（Phase 1）

```yaml
profile:
  default: implementer-and-reviewer   # ENSEMBLE_DEFAULT_PROFILE 相当

conductor:
  backend: pi                        # cursor（既定） | pi
  model: default                      # CONDUCTOR_MODEL_ID 相当
  pi:
    # 任意。省略時は ~/.ensemble/pi と <repoRoot>/.ensemble/pi
    agentDir: ~/.ensemble/pi
    projectDir: .ensemble/pi

acp:
  defaultPreset: cursor               # ENSEMBLE_DEFAULT_ACP_CLI 相当

session:
  worktree: isolated                  # --worktree 既定（isolated | in-repo）
  maxTurns:
    tty: 0                            # 0 = 無制限
    nonTty: 5
  postLoop:
    wait: true                        # TTY 時 post-loop 待機（--no-wait で上書き）

github:
  auth:
    allowGhAuthTokenFallback: true
  monitor:
    enabled: true
    debounceMs: 30000
    pollIntervalMs: 60000
    activePollIntervalMs: 15000
    stopPollWaitMs: 5000

tui:
  layout: pane                        # ENSEMBLE_TUI_LAYOUT 相当
  forceHyperlink: auto                # FORCE_HYPERLINK 相当（auto | on | off）
```

### キー一覧

| キー | 意味 | CLI 上書き | env 上書き |
|------|------|-----------|-----------|
| `profile.default` | 既定 team profile（名前またはパス） | `--profile` | `ENSEMBLE_DEFAULT_PROFILE` |
| `conductor.model` | conductor モデル id | `--model` | `CONDUCTOR_MODEL_ID` |
| `conductor.backend` | conductor LLM backend（`cursor` / `pi`） | — | — |
| `conductor.pi.agentDir` | Pi user resource root のパス上書き | — | — |
| `conductor.pi.projectDir` | Pi project resource root のパス上書き | — | — |
| `acp.defaultPreset` | worker ACP built-in preset | `--default-acp-cli` 等 | `ENSEMBLE_DEFAULT_ACP_CLI` |
| `session.worktree` | worker workspace モード | `--worktree` | — |
| `session.maxTurns.tty` / `nonTty` | 自律ターン上限 | `--max-turns` / `--no-max-turns` | — |
| `session.postLoop.wait` | post-loop 待機（TTY） | `--no-wait` | — |
| `tui.layout` | TTY レイアウト（`pane` / `stream`） | — | `ENSEMBLE_TUI_LAYOUT` |
| `tui.forceHyperlink` | Issue リンク OSC 8（`auto` / `on` / `off`） | — | `FORCE_HYPERLINK`（`1`/`0`） |
| `github.auth.allowGhAuthTokenFallback` | `gh auth token` フォールバック | — | — |
| `github.monitor.enabled` | Issue / PR 監視 | `--no-github-monitor` | — |
| `github.monitor.debounceMs` | 更新 debounce | `--github-monitor-debounce-ms` | — |
| `github.monitor.pollIntervalMs` 他 | poll 間隔（コード内既定のみ） | — | — |

profile / worker に `acp` がある worker は `--default-acp-*` / config `acp.defaultPreset` より **profile 側が優先**（従来どおり）。

### Pi resource root

`conductor.backend: pi` のとき、Pi の標準ファイル名・ディレクトリを次の 2 層から解決します。プロジェクト層がユーザ層を上書きします。

| 層 | 既定パス |
|----|----------|
| ユーザ | `~/.ensemble/pi/` |
| プロジェクト | `<repoRoot>/.ensemble/pi/` |

`conductor.pi.agentDir` / `conductor.pi.projectDir` は resource root のパスだけを上書きします。相対パスは `<repoRoot>` 基準、`~` はユーザ home 基準です。各 root の Pi 標準 resource を次のように解決します。

- `settings.json` / `auth.json`: user → project の deep merge。credential は provider 単位で project entry を優先します。
- `models.json`: Pi 標準の `providers` / `models` / built-in `modelOverrides` / request headers を model 解決へ反映します。
- `extensions/`: ExtensionAPI の tool を読み込み、fixed harness tools → MCP bridge → local extension の順で追加します。同名の harness/MCP tool は上書きしません。
- `skills/`: `SKILL.md` を読み込み、model invocation が有効な skill 本文を compiled system prompt の後ろに追加します。`/skill:<name>` で明示的に展開できます。
- `prompts/`: Markdown template を読み込み、`/name args` の user prompt を Pi 標準の引数置換で展開します。
- `themes/`: Pi 標準 JSON として読み込み、project 同名を優先します。conductor は headless `pi-agent-core` のため TUI renderer がなく、theme の色・表示設定はモデル入出力には適用しません。

Pi の認証 CLI は provider 単位です。`ensemble auth login --provider <id>` は API-key provider なら secret prompt の値を user root の `auth.json`（既定 `~/.ensemble/pi/auth.json`）へ `AuthStorage.set` し、OAuth provider なら Pi の `AuthStorage.login` を TTY / stderr 経由で実行します。`--provider` を省略した場合は `settings.json` の `defaultProvider` または選択モデルから解決します。`logout` / `status` も同じ provider 解決を使います。project `auth.json` は既存の project-over-user 読取優先を維持しますが、login の書込み先にはなりません。`ensemble models list` は `ModelRegistry` と project resource の解決結果から認証済み model だけを表示します。

#### `settings.json` の headless 対応範囲

conductor は `pi-agent-core` を直接使い、`pi-coding-agent` の設定適用器・TUI・package manager は起動しません。そのため `settings.json` は Pi 標準のファイル名と resource path の意味を保ちますが、headless conductor が実際に参照するキーだけを契約とします。

実際に効くキーは次のとおりです。

| キー | headless conductor での意味 |
|------|----------------------------|
| `defaultProvider` / `defaultModel` | 明示的な `provider/model` がない場合のモデル選択。`model` / `modelId` は conductor の互換 alias として同じ選択に使います。 |
| `apiKey` / `apiKeys` | `auth.json` に provider credential がない場合の認証 fallback。 |
| `extensions` / `skills` / `prompts` / `themes` | 各 resource root を基準に追加で読む path。通常の `extensions/` 等の discovery と併用します。 |

Pi の `settings.md` にあるが headless conductor が適用しないキーは、拒否せず警告なしで無視します。

| 無視するキー（または prefix） | 適用されない挙動 |
|------------------------------|------------------|
| `defaultThinkingLevel` / `modelThinkingLevels` / `thinkingBudgets` / `enabledModels` | thinking level、budget、model cycling の設定 |
| `hideThinkingBlock` / `showCacheMissNotices` / `cacheWarming` / `steeringMode` / `followUpMode` | transcript 表示、cache、対話キューの設定 |
| `defaultTools` / `codemode.*` | Pi built-in coding tools の選択。conductor は harness / MCP / local extension の tool loadout を使います。 |
| `packages` | Pi package の install・解決。package が提供する resource は自動導入しません。 |
| `enableSkillCommands` | skill command の登録 toggle。読み込んだ skill の `/skill:<name>` 展開可否はこのキーで変更できません。 |
| `sessionDir` / `compaction.*` / `branchSummary.*` | Pi の session・compact・branch summary。session は harness の `.ensemble/pi/sessions/` が管理します。 |
| `theme` / `quietStartup` / `tuiMode` / `fullscreen*` / `terminal.*` / `images.*` / `markdown.*` | headless conductor の TUI・terminal 表示 |
| `transport` / `httpProxy` / `httpIdleTimeoutMs` / `websocketConnectTimeoutMs` / `retry.*` / `shellPath` / `shellCommandPrefix` / `npmCommand` | Pi coding-agent の network、shell、package runtime |
| `collapseChangelog` / `enableInstallTelemetry` / `enableAnalytics` / `warnings.*` | coding-agent の update、telemetry、UI warning |

表にない未対応キーも同じく無視します。`models.json`、`auth.json`、`extensions/`、`skills/`、`prompts/`、`themes/` の対応範囲は上記 resource の説明どおりです。

conductor の system prompt の基底は modular-prompt のコンパイル結果です。`.ensemble/pi/SYSTEM.md` / `APPEND_SYSTEM.md`（または resource root の同名ファイル）は conductor には読み込みません。

`.ensemble/` は既存のリポジトリ共通 gitignore 方針で無視されるため、Pi のローカル設定・認証・extension はコミットしません。

### GitHub 認証トークンの解決順

`resolveGitHubAuthToken({ config })`（`@agents-ensemble/core`）:

1. 環境変数 `GITHUB_TOKEN`
2. 環境変数 `GH_TOKEN`
3. `config.github.auth.allowGhAuthTokenFallback: true` のときのみ `gh auth token`

`allowGhAuthTokenFallback: false` のときは **`gh auth token` を呼ばない**。CI 等では `GH_TOKEN` / `GITHUB_TOKEN` を明示設定すること。

## 移行表（env → config）

| 従来（env / コード default） | config キー | 備考 |
|------------------------------|-------------|------|
| `ENSEMBLE_DEFAULT_PROFILE` | `profile.default` | env は CI 上書き用として維持 |
| `CONDUCTOR_MODEL_ID` | `conductor.model` | 同上 |
| `ENSEMBLE_DEFAULT_ACP_CLI` | `acp.defaultPreset` | 同上 |
| CLI `--worktree` 既定 `isolated` | `session.worktree` | |
| TTY 無制限 / 非 TTY 5 | `session.maxTurns.tty` / `nonTty` | |
| TTY post-loop 待機 ON | `session.postLoop.wait` | |
| monitor 各種定数 | `github.monitor.*` | |
| `ENSEMBLE_TUI_LAYOUT` | `tui.layout` | env は invocation 上書き用として維持 |
| `FORCE_HYPERLINK` | `tui.forceHyperlink` | `1`/`0` ↔ `on`/`off`。未設定 ↔ `auto` |

**config 未作成時**は従来どおり env とコード default のみが効く（後方互換）。

## Conductor MCP 設定（mcp.json）

MCP 設定は次の 2 層から読み込み、`mcpServers` のサーバー名単位でマージする。

| 層 | パス | 優先度 |
|----|------|--------|
| プロジェクト | `<repoRoot>/.agents/mcp.json` | 高（同名を上書き） |
| ユーザ | `~/.ensemble/mcp.json` | 低（既定） |

プロジェクト設定が同名サーバーを定義した場合は、ユーザ設定の定義全体を置き換える。片方だけ存在する場合はその設定を使い、両方とも無い場合は MCP なしで起動する。

ファイル形式は Cursor SDK の `mcp.json` 形式（`mcpServers` オブジェクト）を使う。

```json
{
  "mcpServers": {
    "example": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": {
        "API_KEY": "${env:API_KEY}"
      }
    }
  }
}
```

解決済み設定は conductor の両 backend に同じ map として渡す。Cursor SDK では `Agent.create` / `Agent.resume` の inline MCP として、Pi では harness 内蔵 MCP bridge が MCP client と Pi `AgentTool` に変換して使う。この bridge は Pi の ExtensionAPI extension をロードするものではなく、`@agents-ensemble/core` 内で `@modelcontextprotocol/sdk` client を接続する in-process thin bridge である。どちらも `resume` と認証・transport エラーからの in-process reconnect で同じ設定を再注入する。Pi は MCP 設定がある場合、session 開始前に全サーバーへ接続して tools を発見するため、接続または bridge の読み込みに失敗したら起動を fail する。

設定値の `${env:...}` や `${workspaceFolder}` などの展開は Cursor SDK では SDK に任せ、Pi bridge では起動時の process environment と conductor cwd を使って同じ参照を展開する。Pi bridge は `stdio` / `http`（Streamable HTTP）/ `sse`、`env`、`cwd`、`headers` を扱う。Cursor SDK が提供する OAuth 対話（`auth` 定義）は Pi bridge の制限により未対応で、該当定義は明確なエラーにする。`.cursor/mcp.json` や `.pi/mcp.json` へのコピー・symlink、`settings.json` の書き換えは行わず、ACP worker にはこの設定を渡さない。Pi MCP tools は `mcp_<server>_<tool>` という衝突回避済みの名前で表示され、resources/prompts の専用 API は今回の bridge の対象外とする。Pi MCP tool の `callTool` 例外または MCP `isError` は成功結果に変換せず、`AgentTool.execute` の throw として model loop に伝える。Pi では extension の読み込み有無にかかわらず、harness tools と解決済み MCP bridge tools が conductor の tool loadout に含まれる。

Pi bridge は `@modelcontextprotocol/sdk@1.30.0` を core に同梱する。依存が欠落した環境で MCP 設定を持つ Pi backend を起動した場合は、インストールすべき固定バージョンを含むエラーで停止する。MCP 未設定時は bridge をロードせず、両 backend とも従来どおり MCP なしで起動する。

JSON が不正、または `mcpServers` / サーバー定義の形式が不正な場合は、そのファイルを `[mcp]` 警告とともにスキップする。もう一方の層が有効ならそちらは引き続き読み込み、両方をスキップした場合は MCP なしで起動する。MCP のホットリロードは行わないため、変更後は新しいセッションを開始する。

## 秘密情報を config に書かない

**token 本体を config に平文で保存しない。** 認証は環境変数、`gh auth login`、Cursor の `ensemble auth login`、または Pi の provider 単位 `ensemble auth login` / `AuthStorage` を使う。

## スキーマ外キー

YAML に未知のキーがあっても **無視する**（警告なし）。将来のスキーマ拡張用に残してよい。既知キーで型が合わない値も **該当キーのみ**無視し、下位層またはデフォルトにフォールバックする。

## 関連

- [settings.md](settings.md) — 全設定層の一覧・解決パターン（本書は config.yaml 詳細）
- [ADR 0020](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0020-ensemble-config-setting-resolution.md) — 解決順の設計判断
- [ADR 0018](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0018-team-profile-four-layer-resolution.md) — `.ensemble/` 配下の規約（team-profile）
- [#223](https://github.com/otolab/agents-ensemble/issues/223) — config 基盤
- [#228](https://github.com/otolab/agents-ensemble/issues/228) — Phase 1 拡張
