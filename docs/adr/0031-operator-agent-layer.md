# ADR 0031: operator 層と operator-agent（user – operator – conductor – workers）

- Status: accepted
- Date: 2026-10-20
- Related: [ADR 0008](0008-human-dialogue-open-questions.md), [ADR 0011](0011-session-sidecar-resume.md), [ADR 0002](0002-star-topology-sdk-conductor-acp-worker.md)

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

### 現行 `ensemble issue` との共存

- **出荷済み**: 人間が **SessionView**（`operator.message`、Operator input ペイン）で **operator ロール相当**を担う。プロンプト terms の「オペレータ」は当面この経路を指す。
- **追加**: 人間は **user** として **operator-agent** と話し、operator ロールを agent に委譲できる（選択肢）。
- harness イベント名 `operator.*` は **Issue セッション内の契約**として後方互換を維持。用語の **user / operator ロール / operator-agent** のプロンプト反映は operator-agent 導入時に段階的に行う（本 ADR は判断のみ。`base-module` の即時書き換えは必須としない）。

### セッションデータ

Open Question 等の harness 管理データは **agents-ensemble セッションデータ**（repo 配下 `.ensemble/`）の正本とし、operator-agent は **読み書きのクライアント**の一つとする（[ADR 0011](0011-session-sidecar-resume.md) の sidecar を補完するファイルは別 Issue）。

## Consequences

- **良い**: operator ロールの実行者を差し替え可能。Issue セッションを壊さず横断運用・エスカレーション連携の土台ができる。GitHub 等の既存非同期チャネルを活かせる。
- **悪い**: 用語が一時的に重なる（人間オペレータ / operator ロール / operator-agent / `operator.message`）。2 系統の CLI 入口（`issue` と `operator-agent`）の説明コスト。
- **フォロー**: [architecture.md](../architecture.md) に本モデルを追記。[#488](https://github.com/otolab/agents-ensemble/issues/488) でパッケージと TTY MVP。[#480](https://github.com/otolab/agents-ensemble/issues/480)、[#483](https://github.com/otolab/agents-ensemble/issues/483)、[#481](https://github.com/otolab/agents-ensemble/issues/481) は operator 層 I/O として位置づけを揃える。
