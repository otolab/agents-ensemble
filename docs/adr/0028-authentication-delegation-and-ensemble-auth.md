# ADR 0028: 認証の管理方針（worker 移譲・conductor と ensemble auth）

- Status: accepted
- Date: 2026-10-12
- Related: [ADR 0019](0019-worker-acp-cli-presets.md), [ADR 0025](0025-conductor-agent-backend-sdk-and-pi.md), [settings.md](../settings.md) パターン E

## Context

ensemble には **役割ごとに別の認証席**がある（GitHub API、conductor LLM、worker ACP）。利用者は Pi conductor で **`ensemble auth`** と **`models.json` の `!command`**（例: `!gcloud auth print-access-token`）を併用し、期限付きトークンは **子 runtime が config から実行時に取得**する「移譲」モデルに慣れている。

一方 worker（ACP）では [ADR 0019](0019-worker-acp-cli-presets.md) の表どおり、`pi` / `claude` は harness が `authenticate` を **skip** するが、**`codex` は常に `chat-gpt`**（ChatGPT / Codex 製品ログイン）を attach 時に要求する。Codex の **`[model_providers.*.auth] command`**（LiteLLM プロキシ向けトークン）や Pi worker と同型の設定は **ACP `authenticate` とは別レイヤー**であり、harness が `chat-gpt` を強制すると次の問題が起きる。

- プロキシ用 `auth.command` を設定していても、**ブラウザログインが並列 attach で走る**（implementer 成功・reviewer `Invalid params` 等）
- **「ensemble auth で conductor を揃える」**ストーリーと worker の **`codex login` 別線**が分断される
- **移譲がデフォルト**という製品方針と実装（`resolve-acp-auth`）が一致しない

conductor 側は backend により複数パターンがある。

| パターン | 例 | harness / ensemble の関与 |
|----------|-----|---------------------------|
| 保存型 credential | `ensemble auth login`（Cursor / Pi provider） | **標準導線**（user runtime に保存） |
| コマンド型トークン | Pi `models.json` の `apiKey: "!…"` | **移譲**（Pi が実行。ensemble は解釈しない） |
| 環境変数 | `CURSOR_API_KEY`、provider `env_key` | 起動時 env 継承 |

worker 向けに **`ensemble auth login`（worker 専用）**を今すぐ用意する案は、移譲デフォルトでは **必須ではない**。将来オプションとして残す余地はあるが、**第一優先は ACP 起動時のデフォルトを移譲に揃える**ことである。

## Decision

### 1. worker（ACP）— デフォルトは移譲

- harness は worker attach 時の ACP **`authenticate` を既定で呼ばない**（**skip**）。認証・トークン取得の正本は **各 ACP adapter が読む runtime 設定**（Codex: `~/.codex/config.toml` の `model_provider` / `[model_providers.*.auth]`、Pi: `pi` 設定、`claude`: Claude Code CLI 等）。
- [ADR 0019](0019-worker-acp-cli-presets.md) の **「ACP authenticate」表の `codex` → `chat-gpt` 既定**は本 ADR により **廃止**する。0019 の preset 解決・spawn 検証・`INITIAL_AGENT_MODE` 等は引き続き 0019 を参照する。
- **管理モード**（harness が `authenticate` する）は **明示 opt-in** とする。profile / worker の `acp` で `authenticate`（method id、例: `chat-gpt`）を指定した場合のみ [ADR 0019](0019-worker-acp-cli-presets.md) 当時の Codex 挙動に近い経路を取れる。

| preset | 既定 `authenticate` | 正本（移譲時） |
|--------|---------------------|----------------|
| `cursor` | `cursor_login` | 変更なし（Cursor agent 前提） |
| `claude` | skip | Claude Code CLI |
| `codex` | **skip** | `~/.codex`（provider + `auth.command` 等） |
| `pi` | skip | `pi` / profile 設定 |
| `custom` | `agent acp` なら `cursor_login`、それ以外 skip | adapter 次第 |

実装の正本は `resolveAcpAuthenticateStrategy`（`packages/core/src/acp/resolve-acp-auth.ts`）。**コード default が本 ADR と一致するまで、方針と実装のギャップは既知の不整合**とする（実装は follow-up Issue）。

### 2. conductor — `ensemble auth` を標準、`!command` は必須サポート

- **保存型**の conductor 認証は **`ensemble auth login` / `status` / `logout` を標準導線**とする（Cursor SDK、Pi `ModelRuntime` の user 層）。詳細は [pi-conductor-setup.md](../pi-conductor-setup.md) と [settings.md](../settings.md)。
- **`!command` 型**（Pi `models.json` の `apiKey: "!…"` 等）は **移譲のまま維持**する。ensemble auth はコマンドを **代替しない**。conductor process の権限で子設定どおり実行され、refresh も子 runtime が担う。
- Codex を将来 conductor backend にしない限り、conductor 席での Codex `auth.command` は本 ADR のスコープ外。worker Codex は §1 の移譲で `~/.codex` を正本とする。

### 3. worker 向け `ensemble auth` — 保留（必須ではない）

- **現時点では worker 専用の `ensemble auth login` を実装しない**（保留）。
- 将来、保存型 credential を harness 経由で統一したい場合に **オプション**として追加可能。デフォルトは引き続き **移譲 + 各 CLI の config**。
- `ensemble auth status` で worker 席を「移譲・正本パス」として表示する改善は UX フォローとし、本 ADR の必須範囲外とする。

### 4. ドキュメント正本

- 認証の **役割別マトリクス**は [settings.md](../settings.md) パターン E を更新し、本 ADR を参照する。
- worker spawn 時の env（`acp.env` の `CODEX_CONFIG` / `MODEL_PROVIDER` 等）は [ADR 0019](0019-worker-acp-cli-presets.md) の spawn マージに従う。プロファイル選択（`codex --profile`）と app-server の差は利用者ドキュメントで扱う（例: #419）。

## Consequences

### 良い点

- Pi worker / Pi conductor の **`!command` トークン**と Codex worker の **`auth.command`** が同じ **移譲**モデルで説明できる。
- 並列 worker attach 時の **不要な `chat-gpt` 二重起動**を減らせる（根本は実装で skip 既定化後）。
- オペレータは conductor を **`ensemble auth`**、worker を **各 runtime config** と覚えられる。

### トレードオフ

- ChatGPT サブスクのみで Codex を使う利用者は、移譲デフォルトでも **`~/.codex` でログイン状態・provider が正しいこと**が前提。管理モード（`chat-gpt` opt-in）または事前 `codex login` が必要な場合は profile で明示する。
- ADR 0019 の authenticate 表と **歴史的実装（codex → chat-gpt）**が残る。新規読者は **本 ADR を authenticate の正本**とする。

### フォローアップ

- `resolve-acp-auth` の **codex 既定を skip**、profile `acp.authenticate` の opt-in、前提チェック・docs 更新（実装 Issue）。
- worker 並列 bootstrap・failed 再 attach は本 ADR のスコープ外（別 Issue 可）。
