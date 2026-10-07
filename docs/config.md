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
  verbose: false                      # CONDUCTOR_VERBOSE / --verbose 相当
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
| `conductor.verbose` | harness 詳細 telemetry の表示 | `--verbose` | `CONDUCTOR_VERBOSE` |
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

`conductor.backend: pi` のとき、Pi 1.x の標準ファイル名・ディレクトリを次の 2 層から解決します。プロジェクト層がユーザ層を上書きします。

| 層 | 既定パス |
|----|----------|
| ユーザ | `~/.ensemble/pi/` |
| プロジェクト | `<repoRoot>/.ensemble/pi/` |

`conductor.pi.agentDir` / `conductor.pi.projectDir` は resource root のパスだけを上書きします。相対パスは `<repoRoot>` 基準、`~` はユーザ home 基準です。各 root の Pi 標準 resource を次のように解決します。

- `settings.json` / `auth.json`: user → project の deep merge。credential は provider 単位で project entry を優先します。
- `models.json`: Pi 標準の `providers` / `models` / built-in `modelOverrides` / request headers を model 解決へ反映します。
- `extensions/`: ExtensionAPI の tool を読み込み、fixed harness tools と local extension tools を conductor の custom tools として追加します。同名の harness tool は上書きしません。MCP は下記の Pi 公式 extension が担当します。
- `skills/`: `SKILL.md` を読み込み、model invocation が有効な skill 本文を compiled system prompt の後ろに追加します。`/skill:<name>` で明示的に展開できます。
- `prompts/`: Markdown template を読み込み、`/name args` の user prompt を Pi 標準の引数置換で展開します。
- `themes/`: Pi 標準 JSON として読み込み、project 同名を優先します。conductor は headless `AgentSession` のため TUI renderer がなく、theme の色・表示設定はモデル入出力には適用しません。

Pi の認証 CLI は provider 単位です。`ensemble auth login --provider <id>` は API-key provider なら secret prompt の値を user root の `auth.json`（既定 `~/.ensemble/pi/auth.json`）へ保存し、OAuth provider なら Pi 1.x の `ModelRuntime.login` を TTY / stderr 経由で実行します。`--provider` を省略した場合は `settings.json` の `defaultProvider` または選択モデルから解決します。`logout` / `status` も同じ provider 解決を使います。project `auth.json` は既存の project-over-user 読取優先を維持しますが、login の書込み先にはなりません。project 層の明示的な OAuth credential は runtime が安全に refresh できないため実行時には使わず、user 層でのログインを案内します。Pi 標準どおり `models.json` / `settings.json` の API キーと header には `!command`（シェルコマンドの stdout）も指定できます。このコマンドは conductor プロセスの shell で実行され、同プロセスの OS 権限・環境を使うため、信頼できる設定でのみ使用してください。これは Pi と同じ accepted risk です。Pi の MCP HTTP OAuth は conductor provider OAuth とは別に、公式 MCP extension が `mcp-auth.json` と対話フローを管理します。`ensemble models list` は `ModelRegistry` と project resource の解決結果から認証済み model だけを表示します。

#### `settings.json` の headless 対応範囲

conductor は Pi 1.x の `createAgentSession` / `DefaultResourceLoader` を headless で使います。TUI と package manager は起動しないため、`settings.json` は Pi 標準のファイル名と resource path の意味を保ちますが、headless conductor が実際に参照するキーだけを契約とします。

この契約のコード正本は [`pi-headless-settings.ts`](../packages/core/src/conductor/pi-headless-settings.ts) の `PI_HEADLESS_SETTING_DEFINITIONS` です。各キーには、conductor 内の `model-selection` / `auth-fallback` / `resource-path`、Pi SDK の `settings-manager-override` のいずれかの適用チャネル、または `ignored` が定義されています。表はコード正本を利用者向けに説明したものです。表にないキーも `ignored` と同じ扱いです。

実際に効くキーは次のとおりです。

| キー | 適用チャネル | headless conductor での意味 |
|------|--------------|----------------------------|
| `defaultProvider` / `defaultModel` | `model-selection` | 明示的な `provider/model` がない場合のモデル選択。`model` / `modelId` は conductor の互換 alias として同じ選択に使います。 |
| `apiKey` / `apiKeys` | `auth-fallback` | `auth.json` に provider credential がない場合の認証 fallback。 |
| `extensions` / `skills` / `prompts` / `themes` | `resource-path` | 各 resource root を基準に追加で読む path。通常の `extensions/` 等の discovery と併用します。 |
| `compaction.*` | `settings-manager-override` | Pi の `AgentSession` が行う manual / automatic compaction。`enabled`、`reserveTokens`、`keepRecentTokens`、`modelOverrides` だけを user → project の deep merge 結果から `SettingsManager` へ渡します。 |
| `branchSummary.*` | `settings-manager-override` | Pi の branch summary。`reserveTokens` / `skipPrompt` だけを `compaction.*` と同じ merge 結果から `SettingsManager` へ渡します。 |

#### Pi 標準の `<cwd>/.pi/settings.json` との関係

Pi SDK の file-backed `SettingsManager` は通常、`agentDir/settings.json` と `<cwd>/.pi/settings.json` を自動的に読み込みます。しかし headless conductor はこの経路を使わず、**`SettingsManager.inMemory()` にコード正本で allowlist した settings-manager チャネルだけを渡します**。したがって、`<cwd>/.pi/settings.json`（および Pi 標準の `agentDir/settings.json`）に書いた値が headless conductor へ漏れることはありません。

headless conductor の設定正本は常に `~/.ensemble/pi/settings.json` と `<repoRoot>/.ensemble/pi/settings.json` です。Pi CLI 用の `<cwd>/.pi/settings.json` とのコピー・symlink・自動マイグレーション・書き換えは行いません。`.pi` の設定を使う別の Pi CLI と、`ensemble issue` の Pi backend は独立しています。

#### create / reload / resume の適用ポリシー

- **create**: `loadPiResources` が `.ensemble/pi` の user → project を deep merge し、モデル選択・認証・resource path は各チャネルで使い、`compaction.*` / `branchSummary.*` は allowlist 後に in-memory `SettingsManager` へ適用します。
- **reload**: Pi `AgentSession.reload()` の後に、create 時に解決した同じ settings-manager スナップショットを再適用します。実行中の `.ensemble/pi/settings.json` の変更を hot reload する契約ではないため、設定変更を反映するには `resume` または新しい create が必要です。`AgentSession.reload()` または snapshot の再適用が失敗した場合は、snapshot の復元を試みた後、session を close / dispose して unusable とします。失敗が 1 つだけで close / dispose が成功した場合はその元のエラーを reject し、reload と snapshot 復元の両方、または close / dispose の cleanup error も発生した場合は `AggregateError` を reject します。`AggregateError.errors` には発生した元の reload / snapshot エラーと cleanup error が含まれます。失敗した session は send で再利用せず、同じ transcript を続ける場合も `resume`、新しい作業なら create で再作成してください。
- **resume**: 新しい Pi session を作るため `.ensemble/pi` を再読込し、create と同じチャネル適用を行ってから既存 transcript を開きます。resume でも `<cwd>/.pi/settings.json` は読みません。

Pi の `settings.md` にあるが headless conductor が適用しないキーは、Pi SDK の SettingsManager へ渡さず、拒否せず警告なしで無視します。

| 無視するキー（または prefix） | 適用されない挙動 |
|------------------------------|------------------|
| `defaultThinkingLevel` / `modelThinkingLevels` / `thinkingBudgets` / `enabledModels` | thinking level、budget、model cycling の設定 |
| `hideThinkingBlock` / `showCacheMissNotices` / `cacheWarming` / `steeringMode` / `followUpMode` | transcript 表示、cache、対話キューの設定 |
| `defaultTools` / `codemode.*` | Pi built-in coding tools の選択。conductor は built-in coding tools を無効にし、harness / MCP / local extension と公式 codemode/tool-search extension の loadout を使います。 |
| `packages` | Pi package の install・解決。package が提供する resource は自動導入しません。 |
| `enableSkillCommands` | skill command の登録 toggle。読み込んだ skill の `/skill:<name>` 展開可否はこのキーで変更できません。 |
| `sessionDir` | Pi の settings にある session 保存先は conductor では変更できません。transcript は常に harness が `<repoRoot>/.ensemble/pi/sessions/` で管理します。 |
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

解決済み設定は conductor の両 backend に同じ map として渡す。Cursor SDK では `Agent.create` / `Agent.resume` の inline MCP として、Pi では Pi 1.x の `DefaultResourceLoader` に `createMcpExtension({ loadConfig })` を extension factory として登録し、`createAgentSession` の起動時に注入する。Pi 側で `.pi/mcp.json` へ同期・コピー・symlink は行わず、resume 時も harness が解決した同じ map を再注入する。sidecar にはこの map の canonical SHA-256 digest だけを保存し、resume 時に現在の digest と比較するため、設定変更は新しい session を要求する。digest に秘密値そのものは保存しない。MCP 接続の管理、tool discovery、OAuth、resource tools は Pi 公式 extension に委ね、core は MCP client/transport を実装しない。

`env` / `headers` / `cwd` は harness 境界で Cursor 形式の placeholder を解決してから Pi 公式 extension に渡す。`${env:VAR}` は現在の process environment の値、`${workspaceFolder}` / `${workspaceFolderBasename}` は conductor の cwd へ変換し、値が見つからない placeholder は literal のまま渡さず明確なエラーにする。Pi 標準の `$VAR` / `${VAR}` は公式 resolver に委ねる。Pi は `stdio` と Streamable HTTP (`http`) をサポートするが、shared `mcp.json` の `sse` 定義は Pi 1.x ではサポートしないため、Pi conductor の起動時に明確なエラーにする。HTTP の `auth` (`CLIENT_ID` / `CLIENT_SECRET` / `scopes`) は Pi の MCP OAuth 設定へ渡され、認可フローと credential 保存は公式 extension が管理する。`.cursor/mcp.json` や `.pi/mcp.json` へのコピー・symlink、`settings.json` の書き換えは行わず、ACP worker にはこの設定を渡さない。MCP server tool は公式名 `mcp__<server>__<tool>`（長すぎる・衝突する場合は Pi の hash suffix）で公開される。resources がある場合は公式の `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` が提供される。`codemode` / `tool_search` の exposure は公式 extension の設定に従う。

Pi backend は `@earendil-works/pi-coding-agent@1.0.x` の公式 MCP extension を使う。MCP 未設定時は extension に空の解決結果を渡し、conductor は harness tools と local extension tools だけで起動する。

JSON が不正、または `mcpServers` / サーバー定義の形式が不正な場合は、そのファイルを `[mcp]` 警告とともにスキップする。もう一方の層が有効ならそちらは引き続き読み込み、両方をスキップした場合は MCP なしで起動する。MCP のホットリロードは行わない。実行中の session の設定を変更した場合は、resume 時に digest mismatch として fail fast するため、新しい session を開始する。

## 秘密情報を config に書かない

**token 本体を config に平文で保存しない。** 認証は環境変数、`gh auth login`、Cursor の `ensemble auth login`、または Pi の provider 単位 `ensemble auth login` / `ModelRuntime` を使う。MCP HTTP OAuth の credential は Pi 公式 extension の管理領域に保存する。

## スキーマ外キー

YAML に未知のキーがあっても **無視する**（警告なし）。将来のスキーマ拡張用に残してよい。既知キーで型が合わない値も **該当キーのみ**無視し、下位層またはデフォルトにフォールバックする。

## 関連

- [settings.md](settings.md) — 全設定層の一覧・解決パターン（本書は config.yaml 詳細）
- [ADR 0020](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0020-ensemble-config-setting-resolution.md) — 解決順の設計判断
- [ADR 0018](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0018-team-profile-four-layer-resolution.md) — `.ensemble/` 配下の規約（team-profile）
- [#223](https://github.com/otolab/agents-ensemble/issues/223) — config 基盤
- [#228](https://github.com/otolab/agents-ensemble/issues/228) — Phase 1 拡張
