# ensemble 共通設定（config.yaml）

> **正本:** `.ensemble/config.yaml` の配置・書き方・スキーマと conductor MCP 設定。本書以外の設定層の一覧・解決パターンは [settings.md](settings.md) を参照します。

`.ensemble/config.yaml` は harness 横断の設定の正本。team-profile（`profile.yaml`）や conductor backend の認証とは別系統。

conductor に渡す MCP 設定もこの config.yaml とは別の JSON ファイルで管理する（下記の [Conductor MCP 設定](#conductor-mcp-設定mcpjson) を参照）。

## 配置と解決順

| 層 | パス | 優先度 |
|----|------|--------|
| プロジェクト | `<repoRoot>/.ensemble/config.yaml` | 読み込み有効時に選択された user config を上書き |
| user config（明示指定時） | `--config <path>` | 標準 user config の代わりに user 層として読み込む |
| user config（標準） | `~/.ensemble/config.yaml` | `--config` 未指定時に user 層として読み込む |

- 設定層は **deep merge**（コード内 default → 選択された user config → project config）。project config の読み込みが有効な場合、同一キーは project 側が優先
- `--config` 指定時は `~/.ensemble/config.yaml` を読み込まず、指定ファイルを user 層の代替として扱う
- project config の読み込み可否は選択された user config の `config.loadProjectConfig` で制御する。`--config` は標準 user config の値を引き継がないため、明示ファイルにこのキーがなければ default の `true` が使われる
- `--config` の相対パスはコマンドを実行したディレクトリを基準に解決し、`~` / `~/...` は home に展開する。指定先が存在しない場合は起動エラー
- config ファイルが無い場合は **コード内デフォルト**
- 項目ごとの **環境変数・CLI フラグは、config の各層より優先**

選択された user config の `config.loadProjectConfig: false` を指定すると、project config を読み込まず user 層までで解決します。既定値は `true` です。この制御キーは user 層でのみ有効で、project 側に同じキーを書いても無視されます。`--config` を使う場合は明示ファイル内の値が有効になり、標準 `~/.ensemble/config.yaml` の toggle は読み込まれません。project config を読み込んだ場合は絶対パスを、user 設定でスキップした場合はその旨を起動時に stderr へ表示します。project config が無く、読み込みが有効な場合は表示しません。

`config.loadProjectConfig` は project 層を読むかどうかを選び、`--config <path>` は user 層に使うファイルを選びます。両者は独立しており、明示ファイルを指定しただけでは project config の読み込み可否は変わりません。

### 設定項目ごとの解決順（Phase 1）

すべての Phase 1 キーで次の順序を **実装・テストで固定**している:

```
CLI 明示指定 > 環境変数 > project .ensemble/config.yaml（読み込み有効時） > 選択された user config > コード内デフォルト
```

project 層が無効な場合は、CLI 明示指定 > 環境変数 > 選択された user config > コード内デフォルトで解決します。

一回の起動で user config を切り替える場合は、任意の YAML ファイルを指定します。指定ファイルは標準 user config の代わりに読み込みます。project config は別層として適用され、同じ項目があれば project の値が優先されます（project 層を無効にする場合は、選択された user config で `config.loadProjectConfig: false` を指定します）。

```yaml
# ~/.ensemble/litellm.config.yaml
conductor:
  model: YOUR_LITELLM_MODEL_ID

acp:
  defaultPreset: codex
  env:
    MODEL_PROVIDER: litellm
```

```sh
ensemble issue 42 --config ~/.ensemble/litellm.config.yaml
ensemble operator-agent --config ~/.ensemble/litellm.config.yaml
```

token などの秘密情報はこのファイルへ平文で書かず、provider が参照する環境変数や認証ストアで管理します。

`loadEnsembleConfig(repoRoot, { configPath })` はコード内 default → 選択された user config → project config（読み込み有効時）の順で merge した `EnsembleConfig` を返します。`configPath` がなければ標準 user config を user 層として使います。明示指定ファイルにない項目はコード内 default から引き継ぐため、標準 user config の値は漏れません。`config.loadProjectConfig` は選択された user config から解決し、明示ファイルにも指定できます。project config 内の同名キーは無視されます。各 `resolve*Setting` はその merged config を **config 層**として参照します。

`conductor.backend` はこの共通順序の例外です。CLI / 環境変数による上書きはなく、選択した profile の `profile.conductor.backend` > merged config（project > 選択された user config）> `cursor` の順で解決します。

`ensemble issue` は GitHub monitor / Issue コンテキスト取得より前に config を読み込みます。`ensemble operator-agent` も `--config` を指定でき、同じ default → 選択された user config → project config（読み込み有効時）の loader を使います。`--config` は team profile の `--profile` とは別系統で、profile 名から config ファイルを推測しません。

#### resume と config 変更

起動時に解決した `EnsembleConfig` 全体の canonical SHA-256 digest を SessionResumeStore に記録します。resume 時に現在の config と digest が異なる場合は、conductor agent の resume 前にエラーにします。`conductor.model` や `acp.env` だけの変更も対象です。worker の ACP spawn fingerprint も env map の digest を保持し、値そのものは保存しません。旧 SessionResumeStore に平文 env map が残っている場合は、resume 整合性の検証前に値を digest へ置換して原子的に書き戻します。そのため config digest mismatch で resume を拒否する場合も、既存の平文値をファイルに残しません。新しい SessionResumeStore には config の値やファイルパスを保存しません。

同じ実効設定なら config ファイルの場所や YAML 内のキー順が変わっても resume できます。digest を持たない旧 resume state は互換性のため resume できますが、設定の一致は検証できない旨を warning で知らせます。設定を切り替えて作業を続ける場合は新しい session を開始してください（[ADR 0042](adr/0042-explicit-config-replaces-user-layer.md)）。

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
  default: implementer-and-reviewer-v2 # ENSEMBLE_DEFAULT_PROFILE 相当

config:
  loadProjectConfig: true              # 選択された user config で制御。false で project config を無視

conductor:
  backend: pi                        # cursor（既定） | pi
  model: default                      # CONDUCTOR_MODEL_ID 相当
  verbose: false                      # CONDUCTOR_VERBOSE / --verbose 相当
  pi:
    # 任意。省略時は ~/.ensemble/pi と <repoRoot>/.ensemble/pi
    agentDir: ~/.ensemble/pi
    projectDir: .ensemble/pi

acp:
  defaultPreset: codex                # ENSEMBLE_DEFAULT_ACP_CLI 相当
  env:                                # codex-acp 子プロセス spawn に渡す env（選択された user config → project deep merge）
    MODEL_PROVIDER: litellm           # Codex provider ID。接続設定は Codex config 側

session:
  worktree: isolated                  # --worktree 既定（isolated | in-repo）
  lazyWorkers: false                  # true: 初回 prompt_worker まで worker ACP attach を遅延
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
    debounceMs: 60000
    pollIntervalMs: 120000
    activePollIntervalMs: 60000
    stopPollWaitMs: 5000

tui:
  layout: stream                      # TTY での既定（pane に戻す場合は明示）
  forceHyperlink: auto                # FORCE_HYPERLINK 相当（auto | on | off）
```

### キー一覧

| キー | 意味 | CLI 上書き | env 上書き |
|------|------|-----------|-----------|
| `config.loadProjectConfig` | project `.ensemble/config.yaml` を読み込むか（既定: `true`、選択された user config のみ有効） | — | — |
| `profile.default` | 既定 team profile（名前またはパス） | `--profile` | `ENSEMBLE_DEFAULT_PROFILE` |
| `conductor.model` | conductor モデル id | `--model` | `CONDUCTOR_MODEL_ID` |
| `conductor.verbose` | harness 詳細 telemetry の表示 | `--verbose` | `CONDUCTOR_VERBOSE` |
| `conductor.backend` | conductor LLM backend（`cursor` / `pi`） | — | — |
| `conductor.pi.agentDir` | Pi user resource root のパス上書き | — | — |
| `conductor.pi.projectDir` | Pi project resource root のパス上書き | — | — |
| `acp.defaultPreset` | worker ACP built-in preset | `--default-acp-cli` 等 | `ENSEMBLE_DEFAULT_ACP_CLI` |
| `acp.env` | codex-acp 等 spawn 時の env（string map） | — | — |
| `session.worktree` | worker workspace モード | `--worktree` | — |
| `session.lazyWorkers` | 初回 `prompt_worker` まで worker ACP attach を遅延 | — | — |
| `session.maxTurns.tty` / `nonTty` | 自律ターン上限 | `--max-turns` / `--no-max-turns` | — |
| `session.postLoop.wait` | post-loop 待機（TTY） | `--no-wait` | — |
| `tui.layout` | TTY レイアウト（`pane` / `stream`） | — | `ENSEMBLE_TUI_LAYOUT` |
| `tui.forceHyperlink` | Issue リンク OSC 8（`auto` / `on` / `off`） | — | `FORCE_HYPERLINK`（`1`/`0`） |
| `github.auth.allowGhAuthTokenFallback` | `gh auth token` フォールバック | — | — |
| `github.monitor.enabled` | Issue / PR 監視 | `--no-github-monitor` | — |
| `github.monitor.debounceMs` | 更新 debounce | `--github-monitor-debounce-ms` | — |
| `github.monitor.pollIntervalMs` 他 | poll 間隔（コード内既定のみ） | — | — |

`config.loadProjectConfig` は config の merge 対象を決めるメタ設定です。project YAML の値は、設定結果にも project config の読み込み判断にも使われません。`--config` 指定時は、その明示ファイルが選択された user config なので、このキーもそこから解決します。

### ACP spawn env（`acp.env`）

`acp.env` は codex-acp 等の子プロセス spawn 時に渡す環境変数の正本です。**team profile に ACP 設定はない**（`acp` / `workers[].acp` を YAML に書くと load 時エラー）。

#### 設定レイヤーの用語（混同防止）

| レイヤー | 正本 | 扱うもの |
|----------|------|----------|
| **team profile** | `profile.yaml` / `--profile` | conductor と workers（kind・workspace・Skill 素材など）。**ACP はこのレイヤーに属さない** |
| **ensemble config** | `.ensemble/config.yaml` | ACP（preset・`env`）、session・GitHub・conductor model 等 |
| **Codex profile** | `~/.codex/config.toml` + `codex --profile <name>` | Codex CLI の世界の profile（ensemble team profile とは無関係） |

#### env のマージ順（後勝ち）

spawn 解決時、子プロセスへ渡す env は次の順でマージされます。

1. **builtin preset 既定** — 例: codex の `INITIAL_AGENT_MODE: agent`
2. **config `acp.env`** — 選択された user config（`--config` 指定時は標準 user config を置換）→ project の deep merge 済み

`acp.env` は他キーと同様に deep merge し、project 層が user 層の値を上書きします。`--config` 指定時は明示ファイルが user 層となり、標準 user config は読み込みません。CLI / 環境変数による `acp.env` の個別キー上書きは Phase 1 では未提供。spawn 時は `process.env` を基底に `spawn.env` が上書きする（[ADR 0028](adr/0028-authentication-delegation-and-ensemble-auth.md)）。

#### LiteLLM（OpenAI 互換ゲートウェイ）向け config 例

Codex worker の接続先は Codex の provider 設定で定義し、`acp.env.MODEL_PROVIDER` で使う provider ID を選びます。ensemble はこの環境変数を `codex-acp` に渡すだけで、TOML ファイルを選んだり読み込んだりはしません。

`@agentclientprotocol/codex-acp` は `packages/core/package.json` で **2.3.0** に pin されています。この版でも、`CODEX_CONFIG` は Codex session config に merge する **JSON オブジェクト文字列**として `JSON.parse` されます。TOML のパスを設定すると JSON parse に失敗します。`MODEL_PROVIDER` は新しい session に渡す **provider ID** で、設定ファイルの選択には使われません。`INITIAL_AGENT_MODE` は初期の承認・sandbox mode を選び、Codex preset の既定 `agent` は workspace-write + on-request です（有効な mode ID は `read-only`、`workspace-write`、`agent`、`agent-full-access`）。空または未知の mode ID は既定の `agent` に戻ります。ensemble はこれらの値を解釈せず、`acp.env` から子プロセスへ渡します。

Codex の model ID はトップレベルの `model`、provider は `model_provider` で指定し、provider IDに対応する `[model_providers.<id>]` から接続先・API形式・認証方法を読みます。worker では Codex が通常の設定レイヤー（主に `~/.codex/config.toml`）を読み、必要であれば `CODEX_CONFIG` の JSON が session config に加わります。`MODEL_PROVIDER=litellm` だけでは、Codex は別ファイル `litellm.config.toml` を探さず、model IDも選びません。

`CODEX_CONFIG` の JSON には `model`、`model_provider`、`model_providers` などCodex session configのキーを含められます。ただし `MODEL_PROVIDER` を設定した場合は、codex-acp が新しいsessionの provider IDとしてその値を別途渡し、JSON内の `model_provider` より優先します。model IDとprovider IDに対応する定義は、それぞれCodexの通常configかJSON設定に必要です。model IDはLiteLLM側で提供されるものを指定してください。

以下の例では秘密値を記載せず、環境変数名を使います。実際の `LITELLM_API_KEY` はシェル等で設定してください。

#### A. provider 設定を正本 config にまとめる（推奨）

provider 定義を `~/.codex/config.toml` に置き、ensemble config では provider ID だけを指定します。Codex CLI と worker が同じ provider 定義を参照し、worker の接続先は `MODEL_PROVIDER` で切り替えられます。

```toml
# ~/.codex/config.toml
model = "YOUR_LITELLM_MODEL_ID"
model_provider = "litellm"

[model_providers.litellm]
name = "LiteLLM"
base_url = "https://litellm.example/v1"
wire_api = "responses"
env_key = "LITELLM_API_KEY"
```

```yaml
# ~/.ensemble/config.yaml または <repo>/.ensemble/config.yaml
acp:
  defaultPreset: codex
  env:
    MODEL_PROVIDER: litellm
```

`model` にはLiteLLM側で提供する実際のmodel IDを指定します。Codex CLI とworkerの両方がこのmodel設定を使います。`MODEL_PROVIDER` はworker sessionで使うproviderだけを選び、model IDは変更しません。別providerへ切り替える場合は、そのproviderでも同じmodel IDが利用できることを確認してください。Codex CLIで別の既定providerを使う場合は、`model_provider` をそのprovider IDにします。認証値は設定ファイルに書かず、Codexが参照する環境変数で渡してください。

#### B. Codex CLI のprofile overlayを使う

Codex CLI の `codex --profile litellm` は、まず `~/.codex/config.toml` を読み、その上に `~/.codex/litellm.config.toml` を重ねます。profile ファイルには `[profiles.litellm]` ではなく通常のトップレベル設定を書きます。Codex 0.134.0 以降、`config.toml` 内の `[profiles.litellm]` と `profile = "litellm"` による指定は使われません。

```toml
# ~/.codex/litellm.config.toml — Codex CLI 用 overlay
model = "YOUR_LITELLM_MODEL_ID"
model_provider = "litellm"

[model_providers.litellm]
name = "LiteLLM"
base_url = "https://litellm.example/v1"
wire_api = "responses"
env_key = "LITELLM_API_KEY"
```

このprofile overlayは **Codex CLI 用**です。ensemble worker は `codex-acp` から Codex `app-server` を起動する経路であり、`codex --profile` を指定できません。worker にはAのように provider 定義を `~/.codex/config.toml` に置くか、Cのように `CODEX_CONFIG` でsession設定を渡してください。Codex の `config.toml` に別TOMLを読み込む公式include機能はありません。CLI profileとworkerで別ファイルを正本にする場合、worker側の設定にも同じprovider定義が必要です。手動で同期するか、設定生成で両方を作成してください。

#### C. worker 用 JSON 設定を別ファイルで管理する

小規模な設定や検証では、worker 専用の JSON ファイルを用意し、その**内容**を `CODEX_CONFIG` に渡せます。`CODEX_CONFIG` 自体にはファイルパスではなくJSON文字列を設定します。例えば、次のファイルを作成します。

```json
{
  "model": "YOUR_LITELLM_MODEL_ID",
  "model_providers": {
    "litellm": {
      "name": "LiteLLM",
      "base_url": "https://litellm.example/v1",
      "wire_api": "responses",
      "env_key": "LITELLM_API_KEY"
    }
  }
}
```

そのファイルの内容を環境変数に読み込み、`acp.env` では `CODEX_CONFIG` を上書きしないで起動します。

```sh
export CODEX_CONFIG="$(jq -c . "$HOME/.codex/ensemble-worker.json")"
ensemble issue 123
```

```yaml
# ~/.ensemble/config.yaml または <repo>/.ensemble/config.yaml
acp:
  defaultPreset: codex
  env:
    MODEL_PROVIDER: litellm
```

`jq -c` は JSON を1行に整形して環境変数へ渡します。`acp.env` に `CODEX_CONFIG` を設定した場合は、親プロセスから継承した値より `acp.env` の値が優先されます。設定を別ファイルで保ちたい場合は、ファイル内容を起動前に環境変数へ変換してください。CではCodex CLIのprovider設定は変わらず、JSONはworker sessionにのみ適用されます。

#### Codex CLI と ensemble worker の違い

| 起動方法 | 設定の選択・読み込み | LiteLLM の指定 |
|----------|--------------------|----------------|
| `codex --profile litellm` | Codex CLI が `~/.codex/config.toml` に `~/.codex/litellm.config.toml` をoverlay | profileファイルに `model`、`model_provider`、provider 定義を記述 |
| ensemble の Codex worker | `codex-acp` → Codex `app-server`。`--profile` は渡せない。Codex の通常 config とsession設定を利用 | `MODEL_PROVIDER` でprovider IDを選択し、`model` は通常config（A）または `CODEX_CONFIG` JSON（C）で指定 |

`CODEX_CONFIG_PROFILE` によるprofile名指定は Codex 側で未実装です（[openai/codex#38104](https://github.com/openai/codex/issues/38104)）。したがって worker のprofile選択手段としては使えません。

#### resume と `acp.env` 変更

`acp.env` を含む解決済み config の変更は、通常は SessionResumeStore の config digest 比較で worker の再 attach 前に検出されます。digest のない旧 resume state では config 一致を検証できないため warning を出して resume を続けますが、worker の ACP spawn fingerprint（[ADR 0011](adr/0011-session-sidecar-resume.md)）があれば再 attach 時にも spawn を照合します。fingerprint は env map の digest だけを持ち、環境変数の値は保存しません。env を変えたあと続けるには新規セッションを開始してください。

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
- `skills/`: Pi 標準の skill discovery（`DefaultResourceLoader`）で索引します。system prompt には name / description / location のカタログを載せ、本文は `read` または `/skill:<name>` で読みます。`settings.json` の `skills` 配列で `.claude/skills` 等の追加パスを指定できます。profile の `conductor.piSkills`（省略時は有効）で無効化できます。
- `prompts/`: Markdown template を読み込み、`/name args` の user prompt を Pi 標準の引数置換で展開します。
- `themes/`: Pi 標準 JSON として読み込み、project 同名を優先します。conductor は headless `AgentSession` のため TUI renderer がなく、theme の色・表示設定はモデル入出力には適用しません。

Pi の初回セットアップ、provider 認証、認証優先順、TTY / stderr の login、project OAuth の制約、`ensemble models list`、missing key / 401 の復旧は [Pi conductor セットアップと認証](pi-conductor-setup.md)を正本とします。この config reference では、headless conductor が `settings.json` の `apiKey` / `apiKeys` を認証 fallback として使い、`models.json` の provider `apiKey` と `!command` も Pi resource として解決することだけを定義します。`!command` は conductor process の shell と OS 権限で実行されるため、信頼できる設定でのみ使用してください。`gcloud auth print-identity-token` 等を連続実行しないためのキャッシュ付きヘルパーは harness では提供せず、[pi-conductor-setup.md の `!command` とトークン取得](pi-conductor-setup.md#command-とトークン取得の連続実行litellm--gcloud-等) と Node 実装の [scripts/pi/cached-auth.mjs](../scripts/pi/cached-auth.mjs) を参照してください。`@agents-ensemble/cli` の配布物には `scripts/pi/cached-auth.mjs` と、これへ委譲する非推奨の `.sh` wrapper が含まれます。既存 `~/.ensemble/pi/cached-auth.sh` コピーからの移行と p50 測定手順も Pi セットアップガイドに記載しています。Pi の MCP HTTP OAuth は provider OAuth とは別に、公式 MCP extension が管理します。

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
| `defaultTools` / `codemode.*` | `defaultTools` は headless conductor では無視します。built-in coding tools は profile の `conductor.builtinTools`（省略・未指定は有効、`false` のみ無効）で制御し、`config.yaml` には同キーを設けません。 |
| `packages` | Pi package の install・解決。package が提供する resource は自動導入しません。 |
| `enableSkillCommands` | skill command の登録 toggle。読み込んだ skill の `/skill:<name>` 展開可否はこのキーで変更できません。 |
| `sessionDir` | Pi の settings にある session 保存先は conductor では変更できません。transcript は `~/.ensemble/sessions/<repoKey>/pi/` に保存し、旧 `<conductorCwd>/.ensemble/pi/sessions/` から再開時に移行します。 |
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

## 移行

### env / コード default → config

| 従来（env / コード default） | config キー | 備考 |
|------------------------------|-------------|------|
| `ENSEMBLE_DEFAULT_PROFILE` | `profile.default` | env は CI 上書き用として維持 |
| `CONDUCTOR_MODEL_ID` | `conductor.model` | 同上 |
| `ENSEMBLE_DEFAULT_ACP_CLI` | `acp.defaultPreset` | 同上 |
| CLI `--worktree` 既定 `isolated` | `session.worktree` | |
| eager worker attach | `session.lazyWorkers: false` | 未指定も eager（後方互換） |
| TTY 無制限 / 非 TTY 5 | `session.maxTurns.tty` / `nonTty` | |
| TTY post-loop 待機 ON | `session.postLoop.wait` | |
| monitor 各種定数 | `github.monitor.*` | |
| `ENSEMBLE_TUI_LAYOUT` | `tui.layout` | env は invocation 上書き用として維持 |
| `FORCE_HYPERLINK` | `tui.forceHyperlink` | `1`/`0` ↔ `on`/`off`。未設定 ↔ `auto` |

**config 未作成時**は従来どおり env とコード default のみが効く（後方互換）。

`session.lazyWorkers` は既定 `false` です。`true` にすると profile の全 worker を session に登録して TUI / `list_workers` に `sleeping` と表示し、初回の通常 `prompt_worker` で対象 worker だけを attach / init します。init prompt 完了後に最初の instruction を別ラウンドで送り、その後はセッション終了まで常駐します。resume は SessionResumeStore に保存した設定を使い、ACP session のある worker は再 attach、まだ使っていない worker は sleeping のままにします。lazy 設定のない旧 SessionResumeStore は eager として扱います。

### team profile `acp` の削除

team profile の `acp` / `workers[].acp` は **削除済み**。YAML に残すと profile load 時にエラーになる。

1. `acp.defaultPreset` → `.ensemble/config.yaml` の `acp.defaultPreset`
2. `acp.env` / `workers[].acp.env` → `acp.env`（user / project の適切な層へ）
3. profile 側の `acp` ブロックを削除

worker 単位の ACP 切り替えは将来の config 側設計とし、現状は横断 `defaultPreset` + `env` を正本とする。

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

解決済み設定は conductor の両 backend に同じ map として渡す。Cursor SDK では `Agent.create` / `Agent.resume` の inline MCP として、Pi では Pi 1.x の `DefaultResourceLoader` に `createMcpExtension({ loadConfig })` を extension factory として登録し、`createAgentSession` の起動時に注入する。Pi 側で `.pi/mcp.json` へ同期・コピー・symlink は行わず、resume 時も harness が解決した同じ map を再注入する。SessionResumeStore にはこの map の canonical SHA-256 digest だけを保存し、resume 時に現在の digest と比較するため、設定変更は新しい session を要求する。digest に秘密値そのものは保存しない。MCP 接続の管理、tool discovery、OAuth、resource tools は Pi 公式 extension に委ね、core は MCP client/transport を実装しない。

`env` / `headers` / `cwd` は harness 境界で Cursor 形式の placeholder を解決してから Pi 公式 extension に渡す。`${env:VAR}` は現在の process environment の値、`${workspaceFolder}` / `${workspaceFolderBasename}` は conductor の cwd へ変換し、値が見つからない placeholder は literal のまま渡さず明確なエラーにする。Pi 標準の `$VAR` / `${VAR}` は公式 resolver に委ねる。Pi は `stdio` と Streamable HTTP (`http`) をサポートするが、shared `mcp.json` の `sse` 定義は Pi 1.x ではサポートしないため、Pi conductor の起動時に明確なエラーにする。HTTP の `auth` (`CLIENT_ID` / `CLIENT_SECRET` / `scopes`) は Pi の MCP OAuth 設定へ渡され、認可フローと credential 保存は公式 extension が管理する。`.cursor/mcp.json` や `.pi/mcp.json` へのコピー・symlink、`settings.json` の書き換えは行わず、ACP worker にはこの設定を渡さない。MCP server tool は公式名 `mcp__<server>__<tool>`（長すぎる・衝突する場合は Pi の hash suffix）で公開される。resources がある場合は公式の `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` が提供される。`codemode` / `tool_search` の exposure は公式 extension の設定に従う。

Pi backend は `@earendil-works/pi-coding-agent@1.2.x` の公式 MCP extension を使う。MCP 未設定時は extension に空の解決結果を渡し、conductor は harness tools と local extension tools だけで起動する。

JSON が不正、または `mcpServers` / サーバー定義の形式が不正な場合は、そのファイルを `[mcp]` 警告とともにスキップする。もう一方の層が有効ならそちらは引き続き読み込み、両方をスキップした場合は MCP なしで起動する。MCP のホットリロードは行わない。実行中の session の設定を変更した場合は、resume 時に digest mismatch として fail fast するため、新しい session を開始する。

## 秘密情報を config に書かない

**token 本体を config に平文で保存しない。** 認証は環境変数、`gh auth login`、Cursor の `ensemble auth login`、または Pi の provider 単位 `ensemble auth login` / `ModelRuntime` を使う。MCP HTTP OAuth の credential は Pi 公式 extension の管理領域に保存する。

## スキーマ外キー

YAML に未知のキーがあっても **無視する**（警告なし）。将来のスキーマ拡張用に残してよい。既知キーで型が合わない値も **該当キーのみ**無視し、下位層またはデフォルトにフォールバックする。

## 関連

- [pi-conductor-setup.md](pi-conductor-setup.md) — Pi conductor の初回セットアップ・認証・復旧（利用者向け正本）
- [settings.md](settings.md) — 全設定層の一覧・解決パターン（本書は config.yaml 詳細）
- [ADR 0028](adr/0028-authentication-delegation-and-ensemble-auth.md) — worker の認証移譲とCodex runtime設定
- [Codex profiles / custom model providers](https://developers.openai.com/codex/config-advanced#profiles) — Codex CLI profile overlay、`model`、`model_provider` の現行仕様
- [codex-acp 2.3.0 runtime options](https://github.com/agentclientprotocol/codex-acp/blob/v2.3.0/README.md#runtime-options) — `INITIAL_AGENT_MODE` / `CODEX_CONFIG` / `MODEL_PROVIDER` などの説明
- [codex-acp 2.3.0 起動処理](https://github.com/agentclientprotocol/codex-acp/blob/v2.3.0/src/index.ts#L38-L64) — 環境変数の parse と Codex app-server 設定への受け渡し
- [codex-acp 2.3.0 初期 mode](https://github.com/agentclientprotocol/codex-acp/blob/v2.3.0/src/AgentMode.ts#L35-L90) — mode ID ごとの承認・sandbox 設定
- [ADR 0020](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0020-ensemble-config-setting-resolution.md) — 解決順の設計判断
- [ADR 0018](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0018-team-profile-four-layer-resolution.md) — `.ensemble/` 配下の規約（team-profile）
- [#223](https://github.com/otolab/agents-ensemble/issues/223) — config 基盤
- [#228](https://github.com/otolab/agents-ensemble/issues/228) — Phase 1 拡張
