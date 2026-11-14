# 設定値リファレンス

> **正本:** `ensemble` の CLI / 環境変数 / config / profile / TUI 設定の対応表と解決順。本書の `config.yaml` スキーマ詳細は [config.md](config.md) を参照します。

## 設定の層

| 層 | 正本 | 用途 |
|----|------|------|
| **CLI フラグ** | `ensemble issue` 等 | invocation 単位の明示上書き |
| **環境変数** | シェル / CI | 一時上書き・秘密情報・自動化注入 |
| **明示 user config** | `--config <path>` | 指定時は標準 user config の代わりに使う |
| **project config** | `<repoRoot>/.ensemble/config.yaml` | リポジトリ単位の既定 |
| **user config** | `~/.ensemble/config.yaml` | マシン全体の既定 |
| **user instructions** | `~/.ensemble/AGENTS.md` | profile に依存しない conductor / worker 共通の運用前提 |
| **team profile** | `profile.yaml`（[elements.md](elements.md)） | worker 構成・workspace（**ACP は含まない → [config.md](config.md)**） |
| **Codex profile** | `~/.codex/config.toml` + `codex --profile` | Codex CLI の profile（ensemble team profile とは無関係） |
| **MCP** | `.agents/mcp.json` / `~/.ensemble/mcp.json` | conductor 向け MCP（[config.md § MCP](config.md#conductor-mcp-設定mcpjson)） |
| **コード default** | `packages/core/src/config/defaults.ts` 等 | config 未作成時のフォールバック |

config は default → 選択された user config → project config（読み込み有効時）の順に **deep merge** します。`--config <path>` を指定した場合は明示ファイルを user config 層として使い、標準 user config は読み込みません。project config は `config.loadProjectConfig` が有効な場合に適用され、同じキーは project config が優先します。この toggle は選択された user config から解決するため、明示ファイルにも指定できます。秘密情報（token 本体）は **config に平文で書かない**（[config.md](config.md)）。

セッションの再開状態、Open Question / operator status YAML、tool-call 履歴、operator-agent の watch 状態、Pi transcript は `~/.ensemble/` に repo ごとに保存します。repoKey は正規化した絶対 `repoRoot` の SHA-256 です。project `.ensemble/` は team profile と repo 固有 config / Pi resources を置く層です。isolated worktree は Git の repo 登録に加え、現行の解決・再利用処理が project-local path を前提とするため `<repoRoot>/.ensemble/worktrees/issue-N` に残します。配置・旧保存先からの移行方針は [ADR 0044](adr/0044-user-scoped-runtime-storage.md) を参照してください。

## 解決パターン

すべての項目が同じ順序ではない。実装は `packages/core/src/config/resolve-settings.ts` の `resolve*Setting` か、各機能の専用解決関数に従う。

### パターン A — Phase 1 横断（env あり）

```
CLI > 環境変数 > project config（読み込み有効時） > 選択された user config > コード default
```

`profile.default` / `conductor.model` / `conductor.reasoning` / `acp.defaultPreset` など。設計判断は [ADR 0020](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0020-ensemble-config-setting-resolution.md)。

`conductor.reasoning` は `ensemble issue` で `--reasoning` > `CONDUCTOR_REASONING` > merged config、`ensemble operator-agent` で `CONDUCTOR_REASONING` > merged config の順に解決します。両方のコマンドが同じ config / env 値を使い、値がなければ reasoning を渡さず Pi / Cursor の既定に任せます。Pi は選択 model が対応する native thinking level を検証し、Cursor は SDK model catalog から対応 parameter を一意に特定できる場合に適用します。値・未対応時の扱いは [config.md § Conductor reasoning](config.md#conductor-reasoning) を参照してください。

conductor model は `ensemble issue --model` / `RunConductorSessionOptions.modelId` > `CONDUCTOR_MODEL_ID` > merged config の `conductor.model` > backend default の順で解決します。`runConductorSession` の直接呼び出しでも同じ選択値を conductor factory の create / resume に渡します。既定値は Cursor では Auto、Pi では Pi resource の `settings.json` にある既定モデルです。custom factory では config またはコード上の既定値だけで `default` になった場合、従来どおり `modelId: undefined` を渡して factory 自身の既定値を使います。API の明示値または環境変数が `default` / `auto` を選んだ場合は `'default'` を渡し、その優先順位を保てるようにします。

`ensemble issue` と `ensemble operator-agent` は `--config <path>` を受け付けます。指定したファイルが user config 層を置き換え、標準 user config は読み込みません。project config の読み込みは独立して `config.loadProjectConfig` で制御し、同一キーでは project config が優先されます。明示ファイルに toggle がなければ default の `true` が使われます。team profile の `--profile` とは別系統です。

```sh
ensemble issue 42 --config ~/.ensemble/litellm.config.yaml
ensemble operator-agent --config ~/.ensemble/litellm.config.yaml
```

user 層の差し替えは [ADR 0042](adr/0042-explicit-config-replaces-user-layer.md)、project toggle との組み合わせは [ADR 0043](adr/0043-explicit-user-config-and-project-toggle.md) に記録しています。

`conductor.backend` は、選択した profile の `conductor.backend` を project/user の deep merge 済み config より優先し、どちらも未指定なら `cursor` を使います。`profile.conductor.builtinTools` は profile だけで制御し、省略・未指定は有効、`false` のみ built-in coding tools を無効にします。`profile.conductor.piSkills` は Pi backend のみで、Pi 標準の skill discovery を制御し、省略・未指定は有効、`false` で skill 索引を止めます。`config.yaml` や `settings.json.defaultTools` ではこの制御を行いません。`cursor` は Cursor SDK 経路、`pi` は Pi 1.x `createAgentSession` 経路を選びます。Pi は compiled conductor instructions を native system prompt に載せ、`~/.ensemble/pi` と `<repoRoot>/.ensemble/pi` の `settings.json` / `auth.json` / `models.json` / `extensions/` / `skills/` / `prompts/` / `themes/` を解決します。skills は Pi の `DefaultResourceLoader` で索引し、カタログを system prompt に載せて本文は `read` / `/skill:` で読みます。prompts は `/name args` で展開します。themes は headless conductor のため読み込み・project 同名解決のみ行い、TUI 表示には使いません。Pi user root は `conductor.pi.agentDir` → `PI_CODING_AGENT_DIR` → `~/.ensemble/pi`、project root は `conductor.pi.projectDir` → `<repoRoot>/.ensemble/pi` の順で解決します。`.ensemble/pi/SYSTEM.md` / `APPEND_SYSTEM.md` は無視します。`ensemble auth login|logout|status` は backend に分岐し、Pi では provider 単位に `ModelRuntime` を使います。API key は TTY の secret prompt から user 層へ保存し、OAuth は Pi の OAuth flow を stderr 対話で実行します（SSH でも URL / device code を利用できます）。MCP HTTP OAuth は Pi 公式 MCP extension が別の credential store で扱います。resume では SessionResumeStore に保存した backend と起動時の解決結果が一致しない場合、次のエラーで conductor を起動せず失敗します。

```text
Session resume state conductorBackend mismatch: pi !== cursor
```

旧 SessionResumeStore にこのフィールドがない場合は、従来どおり `cursor` として扱います。Pi の `conductorAgentId` は Pi の session id としても使われ、transcript は `~/.ensemble/sessions/<repoKey>/pi/` の JSONL に保存されます。旧 `<conductorCwd>/.ensemble/pi/sessions/` は再開時に読み取り、user 側へ移行します。`--continue` / `--resume` ではその transcript を復元し、Issue context から compiled `systemPrompt` を毎回再コンパイルして native system prompt に再注入します。

SessionResumeStore には `ensembleConfigDigestScheme` と config digest を保存します。新しい session の `resume-feasibility` digest が含むのは merge 後の `session.worktree`、`acp.defaultPreset`、`acp.pi.runtime` です。BYO は既定値として省略するため既存の digest は変わらず、builtin / BYO の切り替えは resume を拒否します。`acp.tags` の mapping 全体は resume 判定では neutral とし、tag mapping の変更だけでは resume を拒否しません。`acpModelConfigDigest` と worker spawn fingerprint は model / reasoning / Cursor fast / env の診断情報を保持しますが、その差は resume 判定で比較しません。fingerprint では preset と Pi runtime marker を照合し、marker のない旧 Pi session は BYO として扱います。`custom` の場合は command / args も照合します。旧 sidecar は scheme 省略 / `full` として全 `EnsembleConfig` を比較するため、従来どおり config 変更が resume を拒否する場合があります。resume・再保存後も旧 scheme と digest の意味を保ちます。旧 `resume-feasibility` store で ACP model digest が欠ける場合は warning を出しますが、resume は止めず、digest もバックフィルしません。scheme 省略 / `full` で config digest が欠けていれば従来どおり warning 後に全体照合を省きます。未知の scheme と `resume-feasibility` scheme の digest 欠落は拒否します。config 値や file path は保存しません。詳細は [config.md § resume と config 変更](config.md#resume-と-config-変更)、[ADR 0048](adr/0048-session-resume-feasibility-config-digest.md)、[worker modelTag と resume digest](adr/0062-worker-acp-model-tags.md)、[conductor.reasoning の分類](adr/0051-conductor-reasoning-resume-digest.md)、[Cursor runtime と worker metadata](adr/0054-cursor-acp-runtime-verification.md)、[Pi ACP runtime](adr/0067-pi-acp-upstream-package-wrapper.md)、[Pi の resume 安全性](adr/0068-builtin-pi-home-and-resume-safety.md)、[Cursor model-only CLI 契約](adr/0055-cursor-model-only-cli-contract.md) を参照してください。

新しい `resume-feasibility` digest は `conductor.model` / `conductor.reasoning` を対象外にするため、これらの config 変更だけでは resume を拒否しません。Issue の `--model` / `--reasoning` と `CONDUCTOR_MODEL_ID` / `CONDUCTOR_REASONING` は各 run で再解決します。scheme のない旧 sidecar と `full` sidecar は従来どおり config 全体を比較するため、model / reasoning / env の config 変更で resume が拒否されることがあります。

### パターン B — Phase 1 横断（env なし）

```
CLI > project config > user config > コード default
```

`session.worktree` / `session.maxTurns.*` / `session.postLoop.wait` / `github.monitor.*` など。

### パターン C — ACP preset 解決

worker spawn 時の ACP preset 解決（[ADR 0019](adr/0019-worker-acp-cli-presets.md)）:

```
CLI --default-acp-* > ENSEMBLE_DEFAULT_ACP_CLI > config acp.defaultPreset > cursor
```

`acp.env` の正本は config（選択された user config → project の順に deep merge）。spawn env のマージ順: builtin preset 既定 → config `acp.env`。SessionResumeStore には env map の digest のみを保存します。新しい `resume-feasibility` sidecar ではこの digest を診断情報として保持しますが、resume の拒否判定には使いません。scheme 省略 / `full` の旧 sidecar は従来の全体 config digest を比較するため、config に含まれる env 変更で拒否されることがあります。環境変数の値は記録しません。詳細は [config.md § ACP spawn env](config.md#acp-spawn-envacpenv)。

worker の `modelTag` は `acp.tags` と `acp.models` を経由して解決します。`high` / `default` / `low` / `lite` は built-in team が推奨する tier 名で、空文字や空白のみを含む任意の文字列も使えます。`lite` は default 相当のモデルに短めの reasoning を指定するなど throughput を優先する慣習で、Cursor ACP fast mode（`cursorFast`）とは別概念です。未登録の明示 tag（空文字・空白のみを含む）は warning を出して `default` mapping を試し、それも無ければ model を注入せず preset の既定に委ねます。worker が `modelTag` を省略した場合は暗黙の `default` から preset の既定へ warning なしで進みます。`modelTag: default` を明示して mapping がない場合は warning を出して preset の既定を使います。catalog は文字列 shorthand と、`reasoning` や Cursor 専用の `cursorFast` を指定できる構造化形式を併用できます。明示 tag の warning 条件は [ADR 0063](adr/0063-explicit-default-model-tag-warning.md)、空文字を含む tag の扱いは [ADR 0064](adr/0064-worker-model-tags-allow-empty-strings.md) を参照してください。

```yaml
acp:
  defaultPreset: codex
  models:
    high: { model: YOUR_MODEL_ID, reasoning: high }
    standard: YOUR_MODEL_ID
  tags:
    high: high
    default: standard
```

`model` / `reasoning` の渡し方は preset ごとに異なります。Cursor の model-only 経路は、公式 CLI option `--model` に解決済み model ID をそのまま渡すことです。この pass-through を ensemble の契約とし、ACP response や内部 runtime model の attestation は求めません。別 field の `reasoning` / `cursorFast` を明示すると spawn 前に fail fast します。省略時は initialize capability や setter を送らず、Cursor CLI の model variant 既定に委ねます。model ID 内の reasoning suffix の扱いは別途確認が必要で、確認済みとは表示しません。`claude` は Claude settings metadata と ACP の `model` / `effort`、`codex` は `CODEX_CONFIG`、`pi` は ACP の `model` / `thought_level` option を使います。ACP option の `currentValue` は Agent の報告値であり runtime model の attestation ではありません。`custom` には汎用の model 注入経路がないため、tag が catalog に解決された場合は spawn 前にエラーになります。詳細は [config.md § ACP model tag と model catalog](config.md#acp-model-tag-と-model-catalog)、[ADR 0055](adr/0055-cursor-model-only-cli-contract.md) を参照してください。

### パターン D — 実行時入力（env / CLI）

config キーなし。CI・スクリプト・端末検出、または 1 回限りのオペレータ入力向け。

| 設定 | 環境変数 | config | CLI / API | コード default | 解決 |
|------|----------|--------|-----------|----------------|------|
| permission 停滞警告閾値 | — | — | `--permission-deadlock-stall-ms` / `RunConductorSessionOptions.permissionDeadlockStallMs` | `300_000ms`（300s） | 明示指定 > core default |
| dispatch hold reminder 間隔 | — | — | `--dispatch-hold-reminder-ms` / `RunConductorSessionOptions.dispatchHoldReminderMs` | `1_800_000ms`（30 分） | 明示指定 > core default |

`permissionDeadlockPollMs` は `5_000ms`（5s）のままで、この実行時設定の対象外です。
dispatch hold reminder の poll 間隔も `5_000ms`（5s）で、この実行時設定の対象外です。

### パターン E — 認証（config は可否のみ）

| 種別 | 解決順 |
|------|--------|
| GitHub API | `GITHUB_TOKEN` > `GH_TOKEN` > （`allowGhAuthTokenFallback: true` 時のみ）`gh auth token` |
| conductor (cursor) | `CURSOR_API_KEY` > `~/.cursor/sdk/auth.json`（`ensemble auth login`） |
| conductor (pi) | project `auth.json`（API key / `!command`。OAuth は拒否）> Pi `ModelRuntime`（非空・非 command の `settings.json.apiKeys[provider]` runtime override > user `auth.json` > 選ばれた settings `!command` > `models.json` provider key / command > Pi provider auth・環境 / ambient auth）> key が返らない場合などの Ensemble fallback（command でない settings 候補 > `models.json` provider key > provider 環境変数）。選ばれた settings command は runtime override / user credential より後、`models.json` provider 設定より前に解決されます。command の解決に失敗すると error で止まり、下位 fallback へ進みません。`ensemble auth` の保存先は user 層。詳細は [Pi conductor セットアップと認証](pi-conductor-setup.md) |
| worker ACP（preset 依存） | **既定は移譲**（harness は ACP `authenticate` を skip）。認証の正本は各 adapter の runtime 設定（Codex: `~/.codex` 等）— [ADR 0028](adr/0028-authentication-delegation-and-ensemble-auth.md) / [ADR 0019](adr/0019-worker-acp-cli-presets.md) |

この Pi の順序は複数の経路を組み合わせたものです。user → project に merge した `settings.json.apiKeys[provider]` の非空・非 command 値は runtime override として登録されるため、同じ provider の user `auth.json` credential より先に使われます。project の `settings.json` が同じ値を持つ場合は project 側が残ります。選ばれた settings `!command` は request 時に provider 設定へ登録されますが、Pi は runtime override と保存済み user credential を先に解決します。そのため、この command は両者より後、`models.json` provider 設定より前に使われます。

scalar `settings.json.apiKey` の通常 key は runtime override ではなく、`ModelRuntime` が key を返さなかった場合の fallback です。`!command` の場合は fallback として返さず、他の settings 候補より先に選んだ provider 設定として request 時に登録します。Ensemble は候補を選ぶ際に scalar `apiKey` を先に見て、なければ `apiKeys[provider]` を選びますが、これは fallback と command の候補を選ぶ規則です。非 command の `apiKeys[provider]` はすでに runtime override として解決されるため、scalar key が同時にあっても runtime override が先です。通常の `models.json` provider key / command と Pi の環境・ambient auth も `ModelRuntime` が先に解決し得るため、scalar `apiKey` より先に使われる場合があります。Pi が key を返さず、command の解決失敗もない場合に限り、Ensemble は command でない settings 候補、`models.json` provider key、provider 環境変数の順に確認します。選ばれた command の解決に失敗した場合は、この下位 fallback を試しません。

status は request の実効 source を常に示すわけではありません。現行の Pi status は、project `auth.json`、Pi `ModelRuntime` の status（runtime override > user `auth.json` > provider 設定 > provider の環境・ambient auth）、Ensemble の settings / models / provider-env fallback の順に確認します。`runtime` は headless conductor では通常 `settings.json.apiKeys[provider]` の非 command 値、`stored` は user `auth.json`、`project_stored` は project `auth.json`、`settings_json` は選ばれた settings 候補を示します。`fallback` / `models_json_command` は Pi runtime に登録した `models.json` provider の通常 key / command です。Pi status が provider 設定を報告しない場合の `models_json_key` は、Ensemble が直接検出した候補を示し、通常 key と `!command` を区別しません。`environment` は provider 環境変数のほか、Pi が認識した ambient auth を表すことがあります。特に request 時だけ登録される settings command は status から見えず、別の provider source が表示される場合があります。user / project settings の provenance も保持されません。

空の `settings.json.apiKeys[provider]` は現行 status と request で扱いが異なります。Ensemble は空文字も runtime override として登録するため、Pi status は `runtime` を返します。一方、Pi request resolver は空の override を使わず user `auth.json` の読取りへ進みます。保存 credential がなければ Pi provider 設定や環境・ambient auth を確認しますが、それらから key が得られず scalar `apiKey` もない場合、Ensemble fallback が空の `apiKeys` 値を返して `models.json` / provider-env fallback に進まないことがあります。そのため、この状態で `source=runtime` だけを根拠に実効 credential や login 先を判断せず、user / project の `settings.json` と下位 credential source を確認してください。空 entry を修正・削除するときは、対象 root と、その後に有効になる credential を確かめてください。詳しくは [Pi conductor セットアップと認証](pi-conductor-setup.md) を参照してください。

Pi の `!command` は conductor process の shell / OS 権限で実行され、worker ACP の permission 処理や追加 sandbox を通りません。project の Pi resource も実行可能な設定として扱い、信頼できる repository でのみ使ってください。

## 一覧 — Phase 1（config.yaml）

| 設定 | config キー | 環境変数 | CLI | コード default | 解決 |
|------|-------------|----------|-----|----------------|------|
| 既定 team profile | `profile.default` | `ENSEMBLE_DEFAULT_PROFILE` | `--profile` | 同梱 `implementer-and-reviewer-v2` | A |
| conductor モデル | `conductor.model` | `CONDUCTOR_MODEL_ID` | `ensemble issue --model` | `default` | A |
| conductor reasoning | `conductor.reasoning` | `CONDUCTOR_REASONING` | `ensemble issue --reasoning` | backend 既定（明示値なし） | A |
| conductor 詳細 telemetry | `conductor.verbose` | `CONDUCTOR_VERBOSE` | `--verbose` | `false` | A |
| conductor backend | `conductor.backend` | — | — | `cursor` | profile > config > default |
| Pi user resource root | `conductor.pi.agentDir` | `PI_CODING_AGENT_DIR` | — | `~/.ensemble/pi` | config > environment > default |
| Pi project resource root | `conductor.pi.projectDir` | — | — | `<repoRoot>/.ensemble/pi` | config |
| worker ACP preset（全 worker 共通） | `acp.defaultPreset` | `ENSEMBLE_DEFAULT_ACP_CLI` | `--default-acp-cli` 等 | `cursor` | C |
| worker ACP spawn env | `acp.env` | — | — | — | 選択された user config → project deep merge |
| worker model tier / model・reasoning・Cursor fast | `workers[].modelTag` / `acp.tags`・`acp.models` | — | — | `default` tag | 明示された未登録 tag は warning 後に fallback。省略時の暗黙 `default` は warning なし。Cursor fast mode は tier と別設定 |
| Issue worktree | `session.worktree` | — | `--worktree` | `isolated` | B |
| worker ACP lazy attach | `session.lazyWorkers` | — | — | `false` | B |
| 自律ターン上限（TTY） | `session.maxTurns.tty` | — | `--max-turns` / `--no-max-turns` | `0`（無制限） | B |
| 自律ターン上限（非 TTY） | `session.maxTurns.nonTty` | — | `--max-turns` / `--no-max-turns` | `5` | B |
| post-loop 待機（TTY） | `session.postLoop.wait` | — | `--no-wait` | `true` | B |
| `gh auth token` フォールバック | `github.auth.allowGhAuthTokenFallback` | — | — | `true` | B |
| GitHub 監視 | `github.monitor.enabled` | — | `--no-github-monitor` | `true` | B |
| 監視 debounce | `github.monitor.debounceMs` | — | `--github-monitor-debounce-ms` | `30000` | B |
| poll 間隔 | `github.monitor.pollIntervalMs` 他 | — | — | 各定数 | B |

テンプレート: [`config.example.yaml`](../config.example.yaml)。`ensemble issue` 起動時（GitHub monitor より前）に `loadEnsembleConfig(repoRoot)` で読み込む。選択された user 設定（標準 user config または `--config` の明示ファイル）の `config.loadProjectConfig: false` で project 層を無効にでき、project config の読み込み・スキップは同 loader を使う起動経路で stderr に表示する。詳細は [config.md](config.md#配置と解決順) を参照。

## 一覧 — TUI / オペレータ UI

| 設定 | 環境変数 | config | CLI | コード default | 解決 |
|------|----------|--------|-----|----------------|------|
| TTY レイアウト | `ENSEMBLE_TUI_LAYOUT` | `tui.layout` | — | `stream` | A |
| OSC 8 ハイパーリンク | `FORCE_HYPERLINK`（`1`/`0`） | `tui.forceHyperlink`（`auto`/`on`/`off`） | — | `auto` | A |
| オペレータ 1 回注入 | `ENSEMBLE_OPERATOR_MESSAGE` | — | `ensemble issue <ref> [message...]` | — | D |

TUI 設定は `loadEnsembleConfig` 結果を `createIssueSessionTuiHost` へ渡して解決する。Issue リンク表示の詳細は [operator-input.md](https://github.com/otolab/agents-ensemble/blob/main/docs/operator-input.md)。

### 初回オペレータメッセージの CLI / env 関係

`ensemble issue <ref> [message...]` の残り引数をスペース 1 つで結合し、前後を trim して初回メッセージにします。CLI メッセージと `ENSEMBLE_OPERATOR_MESSAGE` は同時に指定できません。両方が trim 後に空でない場合は、優先順位を設けず起動前にエラーにします。

新規セッションでは、指定した値を binding 直後に 1 回だけ `operator.message` として送ります。TTY / 非 TTY の両方に対応します。`--continue` / `--resume` に CLI メッセージを付けた場合は注入せず、stderr に 1 行の警告を出します。

## 一覧 — 自動化・非 TTY

| 設定 | 環境変数 | config | 備考 |
|------|----------|--------|------|
| 人間エスカレーション回答 | `ENSEMBLE_ESCALATION_RESPONSE` | — | 非 TTY で `ask_human` への env フォールバック |

## 一覧 — 認証（秘密情報）

| 設定 | 環境変数 | config で制御できること |
|------|----------|------------------------|
| GitHub API token | `GITHUB_TOKEN` / `GH_TOKEN` | `github.auth.allowGhAuthTokenFallback` のみ |
| conductor API key (cursor) | `CURSOR_API_KEY` | —（`ensemble auth login` は別経路） |
| conductor API key (pi) | provider ごとの環境変数（Pi の env mapping） | `ensemble auth login --provider <id>`、Pi `auth.json` / `settings.json` にも設定可能 |

## 一覧 — 別ファイル

| 設定 | ファイル | 解決順 |
|------|----------|--------|
| conductor MCP | `.agents/mcp.json` / `~/.ensemble/mcp.json` | project > user（サーバー名単位 merge） |
| user instructions | `~/.ensemble/AGENTS.md` | user 固定。conductor と worker 全員に適用。project 層なし |
| team profile | `.ensemble/profiles/…` / `--profile` パス | [ADR 0018](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0018-team-profile-four-layer-resolution.md) |

## 一覧 — ランタイム（利用者が「設定」しない）

| 変数 | 用途 |
|------|------|
| `TERM_PROGRAM` / `TERM` / `CI` / `WT_SESSION` 等 | OSC 8 対応端末判定（`supportsOsc8Hyperlinks`） |
| `CURSOR_RIPGREP_PATH` | SDK 起動時に ripgrep パスを設定（内部） |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | conductor の proxy。既存値を優先し、未設定時は Cursor settings から補完 |

## どこに書くべきか

| やりたいこと | 推奨 |
|--------------|------|
| 複数 repo で conductor と worker に共有する短い運用前提 | `~/.ensemble/AGENTS.md`（[modular-prompt の文書の役割](modular-prompt.md)を参照） |
| チーム / 個人の恒久既定（モデル、worktree、monitor） | `~/.ensemble/config.yaml` または project `.ensemble/config.yaml` |
| CI で 1 ジョブだけ上書き | 環境変数（`CONDUCTOR_MODEL_ID` 等） |
| 1 回限りの実行 | CLI フラグ（初回メッセージは `ensemble issue <ref> [message...]`） |
| token | Cursor: 環境変数 or `ensemble auth login`、Pi: `ensemble auth login --provider <id>` / Pi `auth.json` / provider 環境変数、GitHub: `gh auth login`（いずれも config に書かない） |
| tmux 内で Issue リンクを短縮表示 | `~/.ensemble/config.yaml` に `tui.forceHyperlink: on`（または env `FORCE_HYPERLINK=1`） |
| worker ごとの model tier / workspace cwd | `profile.yaml` |
| conductor の MCP | `mcp.json` |

## env-only の棚卸し

次の値は config 化済みの設定を重複して説明するものではなく、用途上 config キーを持たない、または秘密情報・実行環境に依存するため env-only としています。

| env-only | 理由 |
|----------|------|
| `ENSEMBLE_OPERATOR_MESSAGE` | CLI 引数を使えない自動化などで、1 回だけオペレータ入力を注入する env-only の値。永続設定にはしない |
| `ENSEMBLE_ESCALATION_RESPONSE` | 非 TTY で `ask_human` への回答を 1 回注入する自動化用値。永続設定にはしない |
| `CURSOR_API_KEY` | conductor の秘密情報。config に平文保存しない |
| `GITHUB_TOKEN` / `GH_TOKEN` | GitHub API の秘密情報。config では token 本体を管理しない |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | SDK 起動時のプロセス環境・既存環境を優先する proxy 設定 |
| `TERM` / `TERM_PROGRAM` / `CI` 等 | TTY / CI の実行環境を検出する値 |
| `CURSOR_RIPGREP_PATH` | SDK 起動時に利用する内部ツールの明示指定 |

`profile.default`、`conductor.model`、`conductor.reasoning`、`conductor.backend`、`acp.defaultPreset`、`session.*`、`github.monitor.*`、`tui.*` のように config キーがある設定は、上の env-only 表ではなく本書の設定一覧と [config.md](config.md) に記載しています。env は invocation 単位の上書きとして残る場合があります。

## 既知のギャップ

| 項目 | 状態 |
|------|------|
| `resolveDefaultAcpPresetSetting` と `resolveDefaultAcpSpawn` の二重実装 | 挙動は一致。将来 refactor 可 |
| Phase 2（`acp.defaultCommand` 等） | [ADR 0020 フォローアップ](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0020-ensemble-config-setting-resolution.md) |

## 関連

- [pi-conductor-setup.md](pi-conductor-setup.md) — Pi conductor の初回セットアップ・認証・復旧（利用者向け正本）
- [config.md](config.md) — `config.yaml` スキーマ・MCP・移行表
- [CLI README](https://github.com/otolab/agents-ensemble/blob/main/docs/cli/README.md) — CLI のインストール・最小クイックスタート
- [operator-input.md](https://github.com/otolab/agents-ensemble/blob/main/docs/operator-input.md) — TUI レイアウト・Issue リンク
- [ADR 0020](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0020-ensemble-config-setting-resolution.md) — Phase 1 解決順
