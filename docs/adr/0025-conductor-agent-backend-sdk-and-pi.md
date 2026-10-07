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
| Cursor サブスク / local agent 以外のプロバイダで conductor を動かしたい | Pi backend と provider 単位の `ensemble auth login` を使う |
| [earendil-works/pi](https://github.com/earendil-works/pi) の Pi 1.x SDK を harness に埋め込む | worker の `pi` CLI 経路とは別物 |

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
- **Pi 実装**は Pi 1.x の `createAgentSession` と `DefaultResourceLoader` を使い、compiled prompt を native system prompt に載せる。初回 `send` は kickoff 等の短い user ターンのみ（compiled 全文の二重送信はしない）。低レベル `pi-agent-core` の Agent ループは conductor では使わない。

### 2. バックエンド選択と resume

- profile または ensemble 設定で `conductor.backend` を **`cursor`（既定） | `pi`** とする。
- **セッション途中で backend を切り替えない**。sidecar に `conductorBackend` を保存し、resume 時に起動時解決と不一致なら **fail fast**。
- Pi と SDK の **セッションログ形式の横断互換**は要求しない（[#348](https://github.com/otolab/agents-ensemble/issues/348) 合意）。
- [ADR 0011](0011-session-sidecar-resume.md) の harness 状態（open question、worker `acpSessionId` 等）は維持。conductor 側の永続 ID はバックエンドごとにマッピングする（Pi session id 等は実装 Issue で定義）。
- Pi では sidecar の `conductorAgentId` をそのまま Pi session id として再利用し、`<conductor-cwd>/.ensemble/pi/sessions/` の JSONL transcript を Pi 1.x `SessionManager` で保存・復元する。追加の sidecar ID フィールドは持たず、旧 sidecar の `conductorBackend` 欠落は従来どおり `cursor` として扱う。
- Pi の resume は Issue context から compiled `systemPrompt` を毎回再コンパイルし、復元した transcript とは別に native system prompt へ再注入する。
- sidecar には harness が解決した MCP map の canonical SHA-256 digest を保存する。resume 時に現在の digest と比較し、変更があれば fail fast する。digest は map の秘密値そのものを保存しない。MCP なしの旧 sidecar は後方互換のため許容するが、MCP が設定された旧 sidecar は安全性のため拒否する。

### 3. MCP

- [ADR 0021](0021-conductor-mcp-config-resolution.md) の **2 層 `mcp.json` 解決**は両 backend 共通の正本とする。
- SDK 経路は現行の inline `mcpServers` を維持する。
- Pi 経路は方針 B として、Pi 1.0.x の公式 `createMcpExtension({ loadConfig })` を `DefaultResourceLoader` の `extensionFactories` に登録し、`createAgentSession` の起動時に harness が ADR 0021 で解決した `McpServerConfigMap` を `LoadedMcpConfig` として注入する。`.pi/mcp.json` への同期・コピー・symlink は行わない。
- Pi へ注入する MCP map は sidecar の canonical digest と対応付け、resume 時の変更を fail fast で拒否する。MCP の resume は map が同一の場合だけ許可する。
- Pi 側の MCP client、transport、OAuth、tool/resource adapter は core で再実装せず、公式 extension に委ねる。公式 extension の server tool 名は `mcp__<server>__<tool>`（必要時は hash suffix）で、resource tools は `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` である。stdio と Streamable HTTP (`http`) を対象とし、SSE は Pi 1.x 非対応として Pi conductor の起動時にエラーにする。HTTP OAuth の対話・credential 保存は公式 extension の管理下に置く。

### 4. ツール・worker・認証

- harness の conductor ツール（`prompt_worker`、escalation、permission 等）は **`ConductorTool` 型**に切り出し、SDK / Pi は adapter で各自のツール表現に変換する。
- **worker ACP は変更しない**（既存 preset・attach 経路のまま。conductor `pi` と worker `pi` は独立）。
- **認証は backend ごとのファサードで統合する**。Cursor は従来どおり Cursor SDK の `~/.cursor/sdk/auth.json` を扱い、Pi は Pi 1.x の `ModelRuntime` と `ModelRegistry` を使う。Pi の user credential は runtime の `auth.json`（既定 `~/.ensemble/pi/auth.json`、`conductor.pi.agentDir` で上書き）へ保存し、project `auth.json` は既存の project-over-user 読取優先を維持するが login の書込み先にはしない。`ensemble auth login/logout/status`、`ensemble models list`、auth recovery hint は選択 backend に分岐する。API-key provider は secret prompt から user 層へ保存し、OAuth provider は TTY / stderr の `ModelRuntime.login` とする。PiConductorAgent は各 request で runtime の credential 解決を行い、Pi provider の OAuth refresh を利用する。MCP HTTP OAuth はこの provider 認証とは別に、公式 MCP extension の credential store と対話フローを使う。

### 5. Pi conductor のカスタマイズ（`.ensemble/pi`）

Pi backend では [`pi-coding-agent` の Configuration](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/configuration.md) を **可能な限りそのまま**使う。配置は ensemble の他設定（`config.yaml` / `mcp.json`）と揃え、**`.ensemble/` 配下**に集約する。

| 層 | パス（既定） | Pi 標準との対応 |
|----|----------------|-----------------|
| ユーザ | `~/.ensemble/pi/` | `~/.pi/agent/`（`PI_CODING_AGENT_DIR` / SDK `agentDir` で指す） |
| プロジェクト | `<repoRoot>/.ensemble/pi/` | 作業ツリー上の `.pi/`（`settings.json`、`extensions/`、`skills/` 等） |

ディレクトリ内のファイル名・resource path の意味は Pi 正本に従う（例: `settings.json`、`extensions/`、`models.json`、`auth.json`）。ただし conductor は `createAgentSession` の headless 経路であり、Pi TUI・package manager の全設定を組み込まない。したがって [settings.md](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/settings.md) のキーを無条件に受け付ける契約にはしない。

**harness が常に入れるもの（現行）**

- ensemble **ConductorTool** 一式（dispatch / escalation / permission 等）。built-in coding tools の有効・無効は下記の profile 設定で制御する。
- **Pi 公式 MCP extension**（[ADR 0021](0021-conductor-mcp-config-resolution.md) で解決した `mcp.json` を `createMcpExtension({ loadConfig })` へ渡す）。core は MCP client / transport / OAuth / resource tool を実装しない。

`profile.conductor.builtinTools` が conductor の built-in coding tools を制御する唯一の設定である。省略・未指定は `true` とし、Pi は `noTools: 'builtin'` を設定せず、Cursor は `disallowedTools` を設定しない。`false` を明示した場合だけ、Pi は `noTools: 'builtin'` を設定し、Cursor は `shell` / `read` / `edit` / `grep` / `glob` / `ls` / `delete` / `readLints` / `applyAgentDiff` / `task` を `disallowedTools` で除外する。harness の custom tools と MCP は維持する。`settings.json.defaultTools` は headless conductor では読まず、`config.yaml` に同名の制御キーは設けない。

**利用者が足せるもの（オプション）**

- 上記パスへの追加 **extensions / skills / prompts / themes / models.json**。extensions は harness custom tools として追加し、skills は compiled system prompt へ、prompts は `/name args` の user prompt 展開へ接続する。MCP tools は公式 extension が管理する。`models.json` の custom provider/model と built-in override は Pi model 解決へ反映する。
- `themes/` は Pi 標準 JSON として読み込み・project 同名解決を行う。ただし conductor は headless `AgentSession` であり、Pi TUI の renderer を持たないため色・表示設定をモデル入出力へ適用しない。
- Pi 標準の `settings.json` のうち、headless conductor が実際に使うキーは次の範囲に限定する。
  - `defaultProvider` / `defaultModel`（`model` / `modelId` は conductor 互換 alias）: モデル選択。
  - `apiKey` / `apiKeys`: `auth.json` の provider credential がない場合の認証 fallback。
  - `extensions` / `skills` / `prompts` / `themes`: 各 resource root 基準の追加 path。
- `compaction.*` は Pi `AgentSession` の manual / automatic compaction へ、`branchSummary.*` は branch summary へ、`.ensemble/pi` の user → project deep merge 結果を `SettingsManager` 経由で適用する。
- `defaultThinkingLevel`、`modelThinkingLevels`、`thinkingBudgets`、`enabledModels`、`defaultTools`、`codemode.*`、`packages`、`enableSkillCommands`、`sessionDir`、`theme` / `tuiMode` / `terminal.*` / `images.*` / `markdown.*`、network / retry / shell / update / telemetry 系の Pi settings key は headless conductor では **無視**する。built-in coding tools の制御は `profile.conductor.builtinTools` のみで行う。未掲載の未対応キーも同じく、警告・拒否なしで無視する。`sessionDir` に関係なく transcript は harness の `<repoRoot>/.ensemble/pi/sessions/` が正本である。`enableSkillCommands` は `/skill:<name>` の展開可否を変更せず、`packages` は install・package resource 解決を行わない。
- 対応範囲の一覧と、無視されるキーの挙動は [config.md の headless 対応範囲](../config.md#settingsjson-の-headless-対応範囲) を利用者向け正本とする。
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
- Pi MCP は公式 extension に依存するため、Cursor SDK と対応 transport / 認証の差が残る。特に Pi は SSE を扱わない。
- Pi は project resource の auth と user `ModelRuntime` の二層を持つため、project が読み取り優先、CLI login は user 層固定という境界を理解する必要がある。MCP HTTP OAuth は別の公式 extension credential store を使う。

### フォロー（実装 Issue）

| Issue | 内容 |
|-------|------|
| [#349](https://github.com/otolab/agents-ensemble/issues/349) | `ConductorTool` + SDK アダプタ |
| [#350](https://github.com/otolab/agents-ensemble/issues/350) | interface 抽出 + `CursorSdkConductorAgent` |
| [#351](https://github.com/otolab/agents-ensemble/issues/351) | backend 設定・sidecar |
| [#352](https://github.com/otolab/agents-ensemble/issues/352) | `PiConductorAgent` 最小 |
| [#353](https://github.com/otolab/agents-ensemble/issues/353) | Pi resume |
| [#354](https://github.com/otolab/agents-ensemble/issues/354) | 旧 MCP ブリッジ実装（#392 で Pi 公式 extension 経路へ置換） |
| [#355](https://github.com/otolab/agents-ensemble/issues/355) | ドキュメント正本の更新 |
| [#356](https://github.com/otolab/agents-ensemble/issues/356) | Pi AuthStorage / ModelRegistry と `ensemble auth` / `models list` の backend 統合 |
| [#358](https://github.com/otolab/agents-ensemble/issues/358) | Pi `.ensemble/pi` 設定・ResourceLoader 配線 |

## 更新履歴（proposed 期間）

| 日付 | 変更 |
|------|------|
| 2026-09-25 | 初版（#348 調査・オペレータ合意を反映） |
| 2026-09-25 | §5 Pi カスタマイズ（`.ensemble/pi`、標準 config、既定 MCP + harness ツール） |
| 2026-09-29 | `ensemble auth` は Cursor SDK 向け、Pi は `settings.json` / `auth.json` を使う認証境界を明記 |
| 2026-09-29 | #354 の Pi MCP bridge を Pi ExtensionAPI extension ではなく core 内 in-process thin bridge として具体化 |
| 2026-10-01 | #358 の実装で user/project resource root と extension discovery を追加。`SYSTEM.md` / `APPEND_SYSTEM.md` は conductor では無視する既定案を確定 |
| 2026-10-01 | #358 reviewer 差し戻し対応: `models.json` の model 解決、skills/prompts の headless 適用、themes の JSON 解決（TUI 非適用）、および provider 単位の project-over-user auth を明記 |
| 2026-10-01 | #358 2 回目の reviewer 差し戻し対応: Pi `settings.json` は headless conductor の対応キー（モデル選択、認証 fallback、resource path）に限定し、thinking / packages / TUI 等の未対応キーを無視する契約へ修正 |
| 2026-10-01 | #356: Pi AuthStorage / ModelRegistry、provider 単位の `ensemble auth`、実行時 OAuth key 解決、認証済み model 一覧を追加 |
| 2026-10-05 | #392: Pi 1.0.x の `createAgentSession` / `DefaultResourceLoader` と公式 MCP extension を採用。旧 bridge、旧低レベル Agent ループ、SSE 対応を削除 |
| 2026-10-05 | #392 reviewer 対応: Cursor placeholder 解決、Pi MCP 接続エラー観測、sidecar の MCP digest による resume 変更検出を追加 |
| 2026-10-07 | #398: `.ensemble/pi` の user → project `compaction.*` / `branchSummary.*` を Pi `SettingsManager` 経由で headless conductor に適用。`sessionDir` は harness の transcript 保存先を維持 |
| 2026-10-07 | #403: profile の `conductor.builtinTools` を built-in coding tools の唯一の制御にし、省略・未指定を有効、`false` のみ無効とする |
