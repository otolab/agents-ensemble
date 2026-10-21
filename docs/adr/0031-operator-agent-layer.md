# ADR 0031: operator 層と operator-agent（user – operator – conductor – workers）

- Status: accepted
- Date: 2026-10-20
- Related: [ADR 0008](0008-human-dialogue-open-questions.md), [ADR 0011](0011-session-sidecar-resume.md), [ADR 0002](0002-star-topology-sdk-conductor-acp-worker.md), [ADR 0037](0037-operator-agent-session-watch-and-dispatch.md)

## Context

`ensemble issue` は **1 Issue につき 1 conductor + profile の workers** を harness が束ねる（[ADR 0002](0002-star-topology-sdk-conductor-acp-worker.md)）。プロンプト上は **オペレータ（人間）が conductor を監督する** 3 層で説明している（[modular-prompt.md](../modular-prompt.md)、`base-module` の terms）。

次の要件が重なった。

1. **operator ロールを誰が実行するか** — 常に人間が TTY に張り付く必要はない。Claude `agents` に近いが、**conductor–workers の横断管理**まで operator 層に寄せたい。
2. **接続の密度** — user と対話する主体は **密**にしたい。一方、各 Issue セッション（conductor プロセス）とは **非同期**でよい（GitHub コメント、`.ensemble` セッションファイル、Open Question YAML 等は既に別チャネル）。
3. **パッケージ分割** — Issue harness（`@agents-ensemble/core`）と、operator ロール用ランタイムを分離し、後者を **サーバに近い独立コンポーネント**（`packages/operator-agent`）として足す。
4. **Open Question の外部連携** — Issue プロセス直結より、**operator 層の I/O** として扱う方が自然（セッションデータ YAML・短文状態・将来の公開 API）。

検討したが **採用しない** 方向:

| 案 | 理由 |
|----|------|
| operator-agent が各 `ensemble issue` に常時接続（TTL セッション） | プロセス管理が主目的になり、既存の GitHub / ファイル経路と重複 |
| operator ロールを conductor プロンプト内に吸収 | ADR 0008 の open question / 監督の分離が崩れる |
| 単一パッケージに operator-agent を同居 | リリース単位・依存（SDK/Pi）・寿命が Issue セッションと異なる |

## Decision

### 4 層モデル

```
user  →  operator（ロール）  →  conductor  →  workers
```

| 層 | 主体 | 備考 |
|----|------|------|
| **user** | 人間 | 最終責任・マージ判断 |
| **operator** | **ロール**（監督・エスカレーション・横断判断） | 実行者は **人間** または **operator-agent** |
| **conductor** | Issue セッション単位の LLM agent | 既存 harness（`ensemble issue`） |
| **workers** | ACP 作業 agent | 既存 |

**operator** はロール名。**operator-agent** はそのロールを LLM + harness ツールで実行する **実装**（`@agents-ensemble/operator-agent`）。

### 接続密度

| 関係 | 密度 | 手段（例） |
|------|------|------------|
| **user ↔ operator-agent** | **密** | Phase 1 は **CLI TTY**（`ensemble operator-agent`）。同期対話が主インタフェース |
| **operator-agent ↔ conductor** | **疎・非同期** | GitHub Issue/PR、`.ensemble/sessions/`（sidecar・[#480](https://github.com/otolab/agents-ensemble/issues/480) の OQ YAML・[#483](https://github.com/otolab/agents-ensemble/issues/483) の短文状態）、将来キュー/webhook。**子プロセスへの常時直結は必須としない** |

operator-agent が conductor に効かせるのは、上記チャネル経由で **後から拾われる** 更新として設計する。

### 実装フェーズ

| Phase | 内容 |
|-------|------|
| **1** | `packages/operator-agent`、user 対話（TTY）、`ensemble operator-agent` 実行パス。`.ensemble` 読み取り程度のツール（[#488](https://github.com/otolab/agents-ensemble/issues/488)） |
| **2** | OQ / 状態の書き戻し、GitHub 連携の集約、[#481](https://github.com/otolab/agents-ensemble/issues/481) を operator I/O として具体化 |

`ensemble issue` の起動・kill を operator-agent のコア責務にしない。

### Phase 1 の設定・接続（LLM / config）

operator-agent は **別プロセス・別 agent セッション**だが、Phase 1 では **conductor と同じ接続設定・config 解決を流用**する（専用 `operator.*` キーは置かない）。

| 項目 | Phase 1 |
|------|---------|
| **config** | `.ensemble/config.yaml`、profile、`repoRoot` 解決は `ensemble issue` と同様（[settings.md](../settings.md) / [config.md](../config.md)） |
| **LLM backend** | `conductor.backend` / `conductor.model`（および Pi の `conductor.pi.*` 等、backend に付随する conductor 用設定） |
| **認証** | [ADR 0028](0028-authentication-delegation-and-ensemble-auth.md) の **conductor 席**と同経路（`ensemble auth`、env、`!command` 移譲） |
| **GitHub** | harness の `github.*`（monitor 等） |

`operator.model` や operator 専用 auth などの **分離は、利用ケースが固まってから**検討する。実装は [#488](https://github.com/otolab/agents-ensemble/issues/488) で conductor 向け `resolve-settings` 相当の再利用を前提とする。

### Phase 1 の LLM ランタイム（ConductorAgent / SDK・Pi。ACP ではない）

operator-agent の LLM は **worker と同じ ACP 経路では立てない**。Issue セッションの conductor と同型の **埋め込み LLM agent** とする（[ADR 0002](0002-star-topology-sdk-conductor-acp-worker.md)、[ADR 0025](0025-conductor-agent-backend-sdk-and-pi.md)）。

| 層 | LLM ランタイム | 備考 |
|----|----------------|------|
| **workers** | **ACP**（`agent acp` 等） | 変更なし |
| **conductor**（`ensemble issue`） | **`ConductorAgent`** — `cursor` → `@cursor/sdk` `Agent`、 `pi` → Pi `createAgentSession` | harness `ConductorSession` 内 |
| **operator-agent** | **同上** — `createConductorAgentFactory(resolveConductorBackendSetting(...))` 等の **同一 factory 選択** | **別プロセス・別 `agentId`**。`ConductorSession` / Issue sidecar には載せない |

**採用**

- backend / model / 認証の **設定解決は conductor 流用**（上表の Phase 1 設定）。
- 実装の正本 interface は **`ConductorAgent` + `ConductorAgentFactory`**（`packages/core`）。operator-agent パッケージは **Issue harness 全体（`ConductorSession`）に依存せず**、factory・auth・model 解決・operator 用 `customTools` とプロンプトを組み立てる。
- **プロンプト**は operator ロール用（Issue の conductor system prompt のコピーではない）。**ツール**も operator 向け（セッション一覧・将来 OQ 等）。repository 直編集の builtin coding tools は Phase 1 では profile の `conductor.builtinTools` 解決に **合わせてよい**（後から operator 専用に切り離し可能）。

**非採用**

| 案 | 理由 |
|----|------|
| operator-agent を **ACP** で起動 | conductor を ACP に寄せる方向は [ADR 0025](0025-conductor-agent-backend-sdk-and-pi.md) で既に不採用。監督ロールは長寿命 SDK/Pi が適する |
| operator 専用 backend 選択（`operator.backend`） | Phase 1 では `conductor.backend` に統一 |
| `ensemble issue` 内の conductor インスタンスを **共有** | プロセス・寿命・プロンプトが異なる。operator ↔ conductor は非同期チャネルのみ |

MVP で **実装を Cursor SDK のみに限定**してもよいが、**設定は `conductor.backend` を読む**（Pi 対応は factory 追加で揃える）。

### 現行 `ensemble issue` との共存

- **出荷済み**: 人間が **SessionView**（`operator.message`、Operator input ペイン）で **operator ロール相当**を担う。プロンプト terms の「オペレータ」は当面この経路を指す。
- **追加**: 人間は **user** として **operator-agent** と話し、operator ロールを agent に委譲できる（選択肢）。
- harness イベント名 `operator.*` は **Issue セッション内の契約**として後方互換を維持。用語の **user / operator ロール / operator-agent** のプロンプト反映は operator-agent 導入時に段階的に行う（本 ADR は判断のみ。`base-module` の即時書き換えは必須としない）。

### セッションデータ

Open Question 等の harness 管理データは **agents-ensemble セッションデータ**（repo 配下 `.ensemble/`）の正本とし、operator-agent は **読み書きのクライアント**の一つとする（[ADR 0011](0011-session-sidecar-resume.md) の sidecar を補完するファイルは別 Issue）。

### operator-agent の会話ライフサイクル

operator-agent は operator 側 LLM 会話を既定で継続する。backend 固有の会話履歴は backend の保存機構に委ね、resume に使う `agentId` と backend / `repoRoot` の対応を `.ensemble/operator-agent/session.json` に保存する。初回起動は新規 session を作成し、通常の TTY EOF・SIGINT・SIGTERM では agent を閉じて履歴を flush し、保存した ID を次回の resume に使う。明示的な `--new` は保存 ID を破棄して新規 session を開始する。

`/exit` と既存 operator command catalog の alias `exit` は会話の連続性を切る。終了時に保存 ID を削除し、次回起動では新規 session を作る。これは `ensemble issue` の `/exit`（Issue 側 worktree cleanup）とは異なる役割であり、operator-agent に `/close` を持ち込まない。

保存済み conductor sidecar は harness 状態の読み取り用スナップショットである。そこから得られる情報の参照は harness 未接続でもできるが、Open Question の live list / answer は稼働中 harness の UDS control API が必要で、未接続・到達不能時に保存 YAML へ書き戻さない。

## Consequences

- **良い**: operator ロールの実行者を差し替え可能。Issue セッションを壊さず横断運用・エスカレーション連携の土台ができる。GitHub 等の既存非同期チャネルを活かせる。
- **悪い**: 用語が一時的に重なる（人間オペレータ / operator ロール / operator-agent / `operator.message`）。2 系統の CLI 入口（`issue` と `operator-agent`）の説明コスト。
- **フォロー**: [architecture.md](../architecture.md) に本モデルを追記。[#488](https://github.com/otolab/agents-ensemble/issues/488) でパッケージと TTY MVP。[#480](https://github.com/otolab/agents-ensemble/issues/480)、[#483](https://github.com/otolab/agents-ensemble/issues/483)、[#481](https://github.com/otolab/agents-ensemble/issues/481) は operator 層 I/O として位置づけを揃える。
