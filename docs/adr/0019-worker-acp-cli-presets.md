# ADR 0019: Worker ACP CLI preset とデフォルト解決

- Status: accepted
- Date: 2026-08-18
- Related: [ADR 0002](0002-star-topology-sdk-conductor-acp-worker.md), [ADR 0011](0011-session-sidecar-resume.md)

## Context

worker の ACP 接続は `spawnAcpProcess` のデフォルト **`agent acp`（Cursor CLI）固定**だった。profile / CLI / 環境変数から利用者が選べず、Claude Code・Codex 等の ACP 対応 CLI へ切り替えられない（#202）。

各 CLI の ACP 実装差（protocol version、認証、`session/load` 挙動など）は Phase 1 では未調査。preset ごとの adapter は後続で足せるよう、最初は **command + args + env** の薄い定義に留める。

## Decision

### 解決優先度

**profile 内（worker ごと）**

| 優先度 | ソース |
|--------|--------|
| 1 | `workers[].acp` |
| 2 | profile 全体の `acp` |

profile に `acp` が 1 箇所でもあれば、そこから解決する。**CLI / 環境変数は profile 指定を上書きしない。**

worker の `acp` は profile `acp` とシャローマージ（`args` は連結、`env` はマージ）。

**デフォルト（profile / worker に ACP 未指定）**

| 優先度 | ソース |
|--------|--------|
| 1 | CLI `--default-acp-command` / `--default-acp-arg`（custom） |
| 2 | CLI `--default-acp-cli` |
| 3 | 環境変数 `ENSEMBLE_DEFAULT_ACP_CLI` |
| 4 | システムデフォルト `cursor`（= `agent acp`） |

### Built-in preset（Phase 1）

| preset | command | args |
|--------|---------|------|
| `cursor` | `agent` | `acp` |
| `claude` | `claude-agent-acp` | （なし） |
| `codex` | `codex-acp` | （なし） |
| `pi` | `pi-acp` | （なし） |

`claude` / `codex` / `pi` は **`npx` を使わない**（#229）。spawn 前に bin を次の順で解決する。

1. `@agents-ensemble/core` の `optionalDependencies` 同梱 bin（ensemble install ルートから `createRequire` + `accessSync`）
2. PATH 上の同名 bin（利用者が global install した場合）
3. 明示エラー + install 手順（spawn 前 fail fast。**npx フォールバックなし**）

| preset | optional パッケージ | bin |
|--------|-------------------|-----|
| `claude` | `@agentclientprotocol/claude-agent-acp` | `claude-agent-acp` |
| `codex` | `@agentclientprotocol/codex-acp` | `codex-acp` |
| `pi` | `pi-acp` | `pi-acp` |

`pnpm install --no-optional` や optional install 失敗時は bundled bin が欠落する。PATH に同名 bin が無ければ spawn 前に install 手順付きで失敗する（README 参照）。

spawn **前**に外部 CLI の存在も検証する（`ensemble issue` 起動経路、worker attach 前）。

| preset | 外部 CLI（PATH） | 欠落時 |
|--------|-----------------|--------|
| `cursor` | `agent` | Cursor Agent CLI install / `agent login` を促す |
| `claude` | （adapter 内で Claude Code 前提） | optional 再 install 手順 |
| `codex` | （adapter 内で Codex 認証） | optional 再 install 手順 |
| `pi` | **`pi`**（`@earendil-works/pi-coding-agent`） | `pi` install を別メッセージで促す |

`custom`: profile または CLI で `command` 明示。`args` / `env` 任意。spawn 前に `command` が PATH にあるかのみチェック。

### `pi` preset の accepted limitation（#203）

コミュニティ adapter [`pi-acp`](https://www.npmjs.com/package/pi-acp)（`pi --mode rpc` へのブリッジ）を利用する。

| 項目 | 内容 |
|------|------|
| 前提 | `pi` CLI（`@earendil-works/pi-coding-agent` v0.80.4+）が PATH にあること。モデル/API key は `pi` 側で別途設定 |
| 認証 | Cursor `agent login` / `CURSOR_API_KEY` とは無関係。Terminal Auth（`pi-acp --terminal-login`）または `pi` 直接設定 |
| ACP adapter | `pi-acp` は core の optionalDependencies 同梱 bin → PATH の順で解決（`npx` 不使用） |
| spawn 前検証 | `pi-acp` があっても `pi` 不在なら別メッセージで fail fast |
| ACP 非対応 | filesystem delegation（`fs/*`）、terminal delegation（`terminal/*`）は未実装（pi がローカル実行） |
| MCP | ACP params の MCP は adapter 内で pi へ未配線（[pi-acp Limitations](https://github.com/svkozak/pi-acp#limitations)） |
| resume | `session/load` は pi-acp の session-map 経由で pi セッションに再アタッチ。sidecar `acpSpawn` 不一致時は他 preset と同様に attach 失敗 |

### resume 時の spawn 不一致

sidecar worker エントリに `acpSpawn`（preset + command + args）を保存する。resume 時に profile / CLI から再解決した spawn と比較し、不一致なら **attach 失敗**（cwd 不一致と同様の明示エラー）。

**Accepted limitation**: v1 以前の sidecar（`acpSpawn` なし）は spawn 不一致を検証しない。古いセッションを resume したあと preset を変えると `session/load` が失敗する可能性がある（既存の cwd 不一致と同趣旨）。

### スコープ外（Phase 1）

- conductor（SDK）側の CLI 切り替え
- preset ごとの capability / adapter フラグ（拡張点は型コメントで余地を残す）

## Consequences

- 良い: profile / CLI / env で worker ACP を切り替え可能。後方互換（未指定 = `agent acp`）。`pi` preset 追加（#203）。`npx` 廃止で worktree `.npmrc` 由来の npm 警告を回避（#229）
- 悪い: optional install 失敗時は bundled bin が欠落する（`--no-optional` 時も同様）。各 CLI の ACP 互換は未検証。`pi` はコミュニティ adapter 依存
- フォロー: 実 CLI integration test、capability フラグ、optional の選択的 install UI
