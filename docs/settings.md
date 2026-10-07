# 設定値リファレンス

> **正本:** `ensemble` の CLI / 環境変数 / config / profile / TUI 設定の対応表と解決順。本書の `config.yaml` スキーマ詳細は [config.md](config.md) を参照します。

## 設定の層

| 層 | 正本 | 用途 |
|----|------|------|
| **CLI フラグ** | `ensemble issue` 等 | invocation 単位の明示上書き |
| **環境変数** | シェル / CI | 一時上書き・秘密情報・自動化注入 |
| **project config** | `<repoRoot>/.ensemble/config.yaml` | リポジトリ単位の既定 |
| **user config** | `~/.ensemble/config.yaml` | マシン全体の既定 |
| **team profile** | `profile.yaml`（[elements.md](https://github.com/otolab/agents-ensemble/blob/main/docs/elements.md)） | worker 構成・per-worker ACP / workspace |
| **MCP** | `.agents/mcp.json` / `~/.ensemble/mcp.json` | conductor 向け MCP（[config.md § MCP](config.md#conductor-mcp-設定mcpjson)） |
| **コード default** | `packages/core/src/config/defaults.ts` 等 | config 未作成時のフォールバック |

project / user config は **deep merge**（project が user を上書き）。秘密情報（token 本体）は **config に平文で書かない**（[config.md](config.md)）。

## 解決パターン

すべての項目が同じ順序ではない。実装は `packages/core/src/config/resolve-settings.ts` の `resolve*Setting` か、各機能の専用解決関数に従う。

### パターン A — Phase 1 横断（env あり）

```
CLI > 環境変数 > project config > user config > コード default
```

`profile.default` / `conductor.model` / `acp.defaultPreset` など。設計判断は [ADR 0020](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0020-ensemble-config-setting-resolution.md)。

`conductor.backend` は、選択した profile の `conductor.backend` を project/user の deep merge 済み config より優先し、どちらも未指定なら `cursor` を使います。`profile.conductor.builtinTools` は profile だけで制御し、省略・未指定は有効、`false` のみ built-in coding tools を無効にします。`config.yaml` や `settings.json.defaultTools` ではこの制御を行いません。`cursor` は Cursor SDK 経路、`pi` は Pi 1.x `createAgentSession` 経路を選びます。Pi は compiled conductor instructions を native system prompt に載せ、`~/.ensemble/pi` と `<repoRoot>/.ensemble/pi` の `settings.json` / `auth.json` / `models.json` / `extensions/` / `skills/` / `prompts/` / `themes/` を解決します。skills は system prompt へ追加し、prompts は `/name args` で展開します。themes は headless conductor のため読み込み・project 同名解決のみ行い、TUI 表示には使いません。root は `conductor.pi.agentDir` / `conductor.pi.projectDir` で上書きできます。`.ensemble/pi/SYSTEM.md` / `APPEND_SYSTEM.md` は無視します。`ensemble auth login|logout|status` は backend に分岐し、Pi では provider 単位に `ModelRuntime` を使います。API key は TTY の secret prompt から user 層へ保存し、OAuth は Pi の OAuth flow を stderr 対話で実行します（SSH でも URL / device code を利用できます）。MCP HTTP OAuth は Pi 公式 MCP extension が別の credential store で扱います。resume では sidecar に保存した backend と起動時の解決結果が一致しない場合、次のエラーで conductor を起動せず失敗します。

```text
Session sidecar conductorBackend mismatch: pi !== cursor
```

旧 sidecar にこのフィールドがない場合は、従来どおり `cursor` として扱います。Pi の `conductorAgentId` は Pi の session id としても使われ、transcript は `<conductor-cwd>/.ensemble/pi/sessions/` の JSONL に保存されます。`--continue` / `--resume` ではその transcript を復元し、Issue context から compiled `systemPrompt` を毎回再コンパイルして native system prompt に再注入します。

### パターン B — Phase 1 横断（env なし）

```
CLI > project config > user config > コード default
```

`session.worktree` / `session.maxTurns.*` / `session.postLoop.wait` / `github.monitor.*` など。

### パターン C — profile / worker 優先

worker spawn 時の ACP 解決（[ADR 0019](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0019-worker-acp-cli-presets.md)）:

```
profile.workers[].acp > profile.acp > CLI --default-acp-* > ENSEMBLE_DEFAULT_ACP_CLI > config acp.defaultPreset > cursor
```

### パターン D — 実行時入力（env / CLI）

config キーなし。CI・スクリプト・端末検出、または 1 回限りのオペレータ入力向け。

### パターン E — 認証（config は可否のみ）

| 種別 | 解決順 |
|------|--------|
| GitHub API | `GITHUB_TOKEN` > `GH_TOKEN` > （`allowGhAuthTokenFallback: true` 時のみ）`gh auth token` |
| conductor (cursor) | `CURSOR_API_KEY` > `~/.cursor/sdk/auth.json`（`ensemble auth login`） |
| conductor (pi) | [Pi conductor セットアップと認証](pi-conductor-setup.md)のとおり、project `auth.json` の読取優先 > user `ModelRuntime`（`~/.ensemble/pi/auth.json`、`conductor.pi.agentDir` で上書き） > `settings.json` fallback / `models.json` provider key > provider 環境変数。`ensemble auth` は user 層へ provider 単位で保存し、project OAuth は refresh しない |
| worker ACP（preset 依存） | preset ごとに README / ADR 0019 参照 |

## 一覧 — Phase 1（config.yaml）

| 設定 | config キー | 環境変数 | CLI | コード default | 解決 |
|------|-------------|----------|-----|----------------|------|
| 既定 team profile | `profile.default` | `ENSEMBLE_DEFAULT_PROFILE` | `--profile` | 同梱 `implementer-and-reviewer` | A |
| conductor モデル | `conductor.model` | `CONDUCTOR_MODEL_ID` | `--model` | `default` | A |
| conductor 詳細 telemetry | `conductor.verbose` | `CONDUCTOR_VERBOSE` | `--verbose` | `false` | A |
| conductor backend | `conductor.backend` | — | — | `cursor` | profile > config > default |
| Pi user resource root | `conductor.pi.agentDir` | — | — | `~/.ensemble/pi` | config |
| Pi project resource root | `conductor.pi.projectDir` | — | — | `<repoRoot>/.ensemble/pi` | config |
| worker ACP preset（profile 未指定 worker） | `acp.defaultPreset` | `ENSEMBLE_DEFAULT_ACP_CLI` | `--default-acp-cli` 等 | `cursor` | C |
| Issue worktree | `session.worktree` | — | `--worktree` | `isolated` | B |
| 自律ターン上限（TTY） | `session.maxTurns.tty` | — | `--max-turns` / `--no-max-turns` | `0`（無制限） | B |
| 自律ターン上限（非 TTY） | `session.maxTurns.nonTty` | — | `--max-turns` / `--no-max-turns` | `5` | B |
| post-loop 待機（TTY） | `session.postLoop.wait` | — | `--no-wait` | `true` | B |
| `gh auth token` フォールバック | `github.auth.allowGhAuthTokenFallback` | — | — | `true` | B |
| GitHub 監視 | `github.monitor.enabled` | — | `--no-github-monitor` | `true` | B |
| 監視 debounce | `github.monitor.debounceMs` | — | `--github-monitor-debounce-ms` | `30000` | B |
| poll 間隔 | `github.monitor.pollIntervalMs` 他 | — | — | 各定数 | B |

テンプレート: [`config.example.yaml`](../config.example.yaml)。`ensemble issue` 起動時（GitHub monitor より前）に `loadEnsembleConfig(repoRoot)` で読み込む。

## 一覧 — TUI / オペレータ UI

| 設定 | 環境変数 | config | CLI | コード default | 解決 |
|------|----------|--------|-----|----------------|------|
| TTY レイアウト | `ENSEMBLE_TUI_LAYOUT` | `tui.layout` | — | `pane` | A |
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
| チーム / 個人の恒久既定（モデル、worktree、monitor） | `~/.ensemble/config.yaml` または project `.ensemble/config.yaml` |
| CI で 1 ジョブだけ上書き | 環境変数（`CONDUCTOR_MODEL_ID` 等） |
| 1 回限りの実行 | CLI フラグ（初回メッセージは `ensemble issue <ref> [message...]`） |
| token | Cursor: 環境変数 or `ensemble auth login`、Pi: `ensemble auth login --provider <id>` / Pi `auth.json` / provider 環境変数、GitHub: `gh auth login`（いずれも config に書かない） |
| tmux 内で Issue リンクを短縮表示 | `~/.ensemble/config.yaml` に `tui.forceHyperlink: on`（または env `FORCE_HYPERLINK=1`） |
| worker ごとの ACP / cwd | `profile.yaml` |
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

`profile.default`、`conductor.model`、`conductor.backend`、`acp.defaultPreset`、`session.*`、`github.monitor.*`、`tui.*` のように config キーがある設定は、上の env-only 表ではなく本書の設定一覧と [config.md](config.md) に記載しています。env は invocation 単位の上書きとして残る場合があります。

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
