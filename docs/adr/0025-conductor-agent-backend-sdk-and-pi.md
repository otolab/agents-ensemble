# ADR 0025: conductor LLM backend（Cursor SDK と Pi）の併存

- Status: proposed
- Date: 2026-09-25

> **草案の更新:** `proposed` の間は本 ADR を実装に合わせて更新する。Epic [#348](https://github.com/otolab/agents-ensemble/issues/348) 完了時に `accepted` へ移し、以降は [不変性ルール](README.md#不変性と方針変更)に従う（方針変更は新 ADR + supersede）。

## Context

[ADR 0002](0002-star-topology-sdk-conductor-acp-worker.md) では conductor を `@cursor/sdk`、worker を ACP と定めた。worker 側は [ADR 0019](0019-worker-acp-cli-presets.md) で preset `pi`（`pi-acp`）も利用できるが、**conductor の LLM ループは SDK 専用**のままである。

調査（[#348](https://github.com/otolab/agents-ensemble/issues/348)）の背景:

| 要望 | 現状（SDK） |
|------|-------------|
| modular-prompt で組んだ conductor Instructions を **LLM の system ロール**に載せたい | SDK に system prompt API がない。初回 `agent.send` に compile 全文を載せるベストエフォート（[architecture.md](../architecture.md) §3） |
| Cursor サブスク / local agent 以外のプロバイダで conductor を動かしたい | `CURSOR_API_KEY` / `ensemble auth login` 前提 |
| [earendil-works/pi](https://github.com/earendil-works/pi) の `pi-agent-core` を harness に埋め込む | worker の `pi` CLI 経路とは別物 |

検討した方向:

| 案 | 概要 |
|----|------|
| SDK のみ継続 | 変更最小。system ロール要件は満たせない |
| conductor を ACP に寄せる | スター型・長寿命・[ADR 0009](0009-conductor-session-event-queue.md) の前提を大きく変える |
| **SDK / Pi を起動時選択（採用）** | [ADR 0002](0002-star-topology-sdk-conductor-acp-worker.md) の worker 軸は維持。conductor だけ `ConductorAgent` interface で差し替え |

## Decision

### 1. `ConductorAgent` interface と system prompt 受け口

- harness は **`ConductorAgent` interface + `ConductorAgentFactory`** に依存する（実装はバックエンド別）。
- `ConductorAgentCreateOptions.systemPrompt` に、`compileConductorSystemPrompt` の結果（Issue context 込み）を渡す。**user ターンの `send` と混ぜない**（Pi 向けの正本経路）。
- **Cursor SDK 実装**は API 上 system を持たないため、**従来どおり**初回ターンで `send(compiledPrompt)` する。`systemPrompt` 引数は渡すが SDK には載せない（同一文字列の二重管理は session 層で 1 回 compile に集約）。
- **Pi 実装**は `pi-agent-core` の system に載せ、初回 `send` は kickoff 等の短い user ターンのみ（compiled 全文の二重送信はしない）。

### 2. バックエンド選択と resume

- profile または ensemble 設定で `conductor.backend` を **`cursor`（既定） | `pi`** とする。
- **セッション途中で backend を切り替えない**。sidecar に `conductorBackend` を保存し、resume 時に起動時解決と不一致なら **fail fast**。
- Pi と SDK の **セッションログ形式の横断互換**は要求しない（[#348](https://github.com/otolab/agents-ensemble/issues/348) 合意）。
- [ADR 0011](0011-session-sidecar-resume.md) の harness 状態（open question、worker `acpSessionId` 等）は維持。conductor 側の永続 ID はバックエンドごとにマッピングする（Pi session id 等は実装 Issue で定義）。

### 3. MCP

- [ADR 0021](0021-conductor-mcp-config-resolution.md) の **2 層 `mcp.json` 解決**は両 backend 共通の正本とする。
- SDK 経路は現行の inline `mcpServers` を維持。
- Pi 経路は Pi コアが MCP を載せないため、**MCP ブリッジ用プラグイン（extension）**を harness から配線し、**同じ解決結果**が使えることを目標にする。

### 4. ツール・worker・認証

- harness の conductor ツール（`prompt_worker`、escalation、permission 等）は **`ConductorTool` 型**に切り出し、SDK / Pi は adapter で各自のツール表現に変換する。
- **worker ACP は変更しない**（既存 preset・attach 経路のまま。conductor `pi` と worker `pi` は独立）。
- **認証統合は後回し**。Pi backend 初版は **ファイル上の設定**（profile、pi settings 等）を読むのみ。`ensemble auth` と Pi プロバイダの統合は [#356](https://github.com/otolab/agents-ensemble/issues/356)。

### 5. Pi conductor のカスタマイズ（`.ensemble/pi`）

Pi backend では [`pi-coding-agent` の Configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md) を **可能な限りそのまま**使う。配置は ensemble の他設定（`config.yaml` / `mcp.json`）と揃え、**`.ensemble/` 配下**に集約する。

| 層 | パス（既定） | Pi 標準との対応 |
|----|----------------|-----------------|
| ユーザ | `~/.ensemble/pi/` | `~/.pi/agent/`（`PI_CODING_AGENT_DIR` / SDK `agentDir` で指す） |
| プロジェクト | `<repoRoot>/.ensemble/pi/` | 作業ツリー上の `.pi/`（`settings.json`、`extensions/`、`skills/` 等） |

ディレクトリ内のファイル名・意味は Pi 正本に従う（例: `settings.json`、`extensions/`、`models.json`、`auth.json`）。[settings.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md) のキーをそのまま受け付ける。

**harness が常に入れるもの（利用者が外せない）**

- ensemble **ConductorTool** 一式（dispatch / escalation / permission 等）。Pi のビルトイン coding ツールは conductor では載せない（[ADR 0006](0006-conductor-agent-mode.md) と同趣旨）。
- **MCP ブリッジ** extension（[ADR 0021](0021-conductor-mcp-config-resolution.md) で解決した `mcp.json` を Pi 側へ渡す）。#354 の実装でパス固定または同梱。

**利用者が足せるもの（オプション）**

- 上記パスへの追加 **extensions / skills / prompts / themes**、および Pi 標準の `settings.json` による挙動調整（モデル既定、thinking、パッケージ宣言等）。
- `config.yaml` の `conductor.pi.*` は **パス上書きや discovery のヒント**に限定し、Pi 本体の設定スキーマを二重定義しない。

**system prompt の優先**

- conductor の正本は **modular-prompt → `compileConductorSystemPrompt` → `ConductorAgentCreateOptions.systemPrompt`**（§1）。`.ensemble/pi/SYSTEM.md` / `APPEND_SYSTEM.md` は Pi 標準では system を置き換え得るが、conductor harness では **`systemPrompt` 受け口が優先**し、override ファイルは無視または **append のみ**許可するかは実装 Issue で固定（既定案: **無視**。追加指示は profile materials で渡す）。

**解決順**

- プロジェクト `.ensemble/pi/` はユーザ `~/.ensemble/pi/` を上書き（Pi の project-over-user と同じ思想）。`config.yaml` の明示パスはそれより優先（[config.md](../config.md) Phase 1 と同型）。

## Consequences

### 良い点

- modular-prompt の conductor Instructions を Pi 経路で **system ロール**に載せられる（採用の主目的）。
- SDK 既定のまま既存利用者を壊さず、opt-in で Pi backend を試せる。
- [ADR 0002](0002-star-topology-sdk-conductor-acp-worker.md) のスター型・worker 分離を維持できる。

### トレードオフ・accepted risk

- conductor に **二系統**（SDK + Pi）のテスト・ドキュメント・障害切り分けが増える。
- SDK と Pi で **初回ターン・system の扱いが異なる**（利用者向けに README / ADR で明示）。
- MCP は Pi 側がブリッジ依存となり、未配線時は機能差が出る。
- 認証がファイル分散のままでは、backend ごとに設定場所を理解する必要がある（#356 まで）。

### フォロー（実装 Issue）

| Issue | 内容 |
|-------|------|
| [#349](https://github.com/otolab/agents-ensemble/issues/349) | `ConductorTool` + SDK アダプタ |
| [#350](https://github.com/otolab/agents-ensemble/issues/350) | interface 抽出 + `CursorSdkConductorAgent` |
| [#351](https://github.com/otolab/agents-ensemble/issues/351) | backend 設定・sidecar |
| [#352](https://github.com/otolab/agents-ensemble/issues/352) | `PiConductorAgent` 最小 |
| [#353](https://github.com/otolab/agents-ensemble/issues/353) | Pi resume |
| [#354](https://github.com/otolab/agents-ensemble/issues/354) | MCP ブリッジ |
| [#355](https://github.com/otolab/agents-ensemble/issues/355) | ドキュメント正本の更新 |
| [#356](https://github.com/otolab/agents-ensemble/issues/356) | 認証統合（任意・後回し） |
| [#358](https://github.com/otolab/agents-ensemble/issues/358) | Pi `.ensemble/pi` 設定・ResourceLoader 配線 |

## 更新履歴（proposed 期間）

| 日付 | 変更 |
|------|------|
| 2026-09-25 | 初版（#348 調査・オペレータ合意を反映） |
| 2026-09-25 | §5 Pi カスタマイズ（`.ensemble/pi`、標準 config、既定 MCP + harness ツール） |
