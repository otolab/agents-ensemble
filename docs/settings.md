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

### パターン D — 環境変数のみ

config キーなし。CI・スクリプト・端末検出向け。

### パターン E — 認証（config は可否のみ）

| 種別 | 解決順 |
|------|--------|
| GitHub API | `GITHUB_TOKEN` > `GH_TOKEN` > （`allowGhAuthTokenFallback: true` 時のみ）`gh auth token` |
| conductor | `CURSOR_API_KEY` > `~/.cursor/sdk/auth.json`（`ensemble auth login`） |
| worker ACP（preset 依存） | preset ごとに README / ADR 0019 参照 |

## 一覧 — Phase 1（config.yaml）

| 設定 | config キー | 環境変数 | CLI | コード default | 解決 |
|------|-------------|----------|-----|----------------|------|
| 既定 team profile | `profile.default` | `ENSEMBLE_DEFAULT_PROFILE` | `--profile` | 同梱 `implementer-and-reviewer` | A |
| conductor モデル | `conductor.model` | `CONDUCTOR_MODEL_ID` | `--model` | `default` | A |
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
| オペレータ 1 回注入 | `ENSEMBLE_OPERATOR_MESSAGE` | — | — | — | D |

TUI 設定は `loadEnsembleConfig` 結果を `createIssueSessionTuiHost` へ渡して解決する。Issue リンク表示の詳細は [operator-input.md](https://github.com/otolab/agents-ensemble/blob/main/docs/operator-input.md)。

## 一覧 — 自動化・非 TTY

| 設定 | 環境変数 | config | 備考 |
|------|----------|--------|------|
| 人間エスカレーション回答 | `ENSEMBLE_ESCALATION_RESPONSE` | — | 非 TTY で `ask_human` への env フォールバック |

## 一覧 — 認証（秘密情報）

| 設定 | 環境変数 | config で制御できること |
|------|----------|------------------------|
| GitHub API token | `GITHUB_TOKEN` / `GH_TOKEN` | `github.auth.allowGhAuthTokenFallback` のみ |
| conductor API key | `CURSOR_API_KEY` | —（`ensemble auth login` は別経路） |

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
| 1 回限りの実行 | CLI フラグ |
| token | 環境変数 or `gh auth login` / `ensemble auth login`（config に書かない） |
| tmux 内で Issue リンクを短縮表示 | `~/.ensemble/config.yaml` に `tui.forceHyperlink: on`（または env `FORCE_HYPERLINK=1`） |
| worker ごとの ACP / cwd | `profile.yaml` |
| conductor の MCP | `mcp.json` |

## env-only の棚卸し

次の値は config 化済みの設定を重複して説明するものではなく、用途上 config キーを持たない、または秘密情報・実行環境に依存するため env-only としています。

| env-only | 理由 |
|----------|------|
| `ENSEMBLE_OPERATOR_MESSAGE` | 非 TTY で 1 回だけオペレータ入力を注入する自動化用値。永続設定にはしない |
| `ENSEMBLE_ESCALATION_RESPONSE` | 非 TTY で `ask_human` への回答を 1 回注入する自動化用値。永続設定にはしない |
| `CURSOR_API_KEY` | conductor の秘密情報。config に平文保存しない |
| `GITHUB_TOKEN` / `GH_TOKEN` | GitHub API の秘密情報。config では token 本体を管理しない |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | SDK 起動時のプロセス環境・既存環境を優先する proxy 設定 |
| `TERM` / `TERM_PROGRAM` / `CI` 等 | TTY / CI の実行環境を検出する値 |
| `CURSOR_RIPGREP_PATH` | SDK 起動時に利用する内部ツールの明示指定 |

`profile.default`、`conductor.model`、`acp.defaultPreset`、`session.*`、`github.monitor.*`、`tui.*` のように config キーがある設定は、上の env-only 表ではなく本書の設定一覧と [config.md](config.md) に記載しています。env は invocation 単位の上書きとして残る場合があります。

## 既知のギャップ

| 項目 | 状態 |
|------|------|
| `resolveDefaultAcpPresetSetting` と `resolveDefaultAcpSpawn` の二重実装 | 挙動は一致。将来 refactor 可 |
| Phase 2（`acp.defaultCommand` 等） | [ADR 0020 フォローアップ](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0020-ensemble-config-setting-resolution.md) |

## 関連

- [config.md](config.md) — `config.yaml` スキーマ・MCP・移行表
- [CLI README](https://github.com/otolab/agents-ensemble/blob/main/docs/cli/README.md) — CLI のインストール・最小クイックスタート
- [operator-input.md](https://github.com/otolab/agents-ensemble/blob/main/docs/operator-input.md) — TUI レイアウト・Issue リンク
- [ADR 0020](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0020-ensemble-config-setting-resolution.md) — Phase 1 解決順
