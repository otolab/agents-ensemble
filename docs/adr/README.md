# Architecture Decision Records (ADR)

個別の**設計判断**（なぜそうしたか、何を犠牲にしたか）を短く残す。  
現状の構成・API の正本は [architecture.md](../architecture.md)。ADR は判断の履歴。

## 形式

[Michael Nygard 形式](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) に近い。

```markdown
# ADR NNNN: タイトル

- Status: proposed | accepted | deprecated | superseded by ADR-XXXX
- Date: YYYY-MM-DD

## Context
## Decision
## Consequences
```

- **Context**: 問題・制約・検討した選択肢
- **Decision**: 採った方針（1 つに絞る）
- **Consequences**: 良い点・悪い点・フォローアップ

「最適」と書くときは、比較検証やメトリクスがある場合に限る。仮説は仮説と明記する。

## 不変性と方針変更

ADR は**合意された設計判断の履歴**を残すもの。一度 `accepted` になった ADR の本文（Context / Decision / Consequences）は、過去の思考を残すため **書き換えない**。

| やること | やらないこと |
|----------|--------------|
| 新しい判断が必要なら **新しい ADR** を書く | 古い ADR の Decision を直して「現状」に合わせる |
| 古い ADR の **Status だけ** を `superseded` に更新し、新 ADR へリンクする | 取り消し線や追記で Decision 本文を実質的に差し替える |
| 現行の構成・API は [architecture.md](../architecture.md) 等の**正本**を更新する | ADR を正本の代わりに使う |

### 方針を変えるときの手順

1. 次の番号で **新しい ADR** を作成する（なぜ変えるかを Context に書く）
2. 新 ADR を `accepted` にする
3. **置き換えられる旧 ADR** の Status を `superseded by [NNNN](NNNN-title.md)` に更新する（**この 1 行以外は旧 ADR を触らない**）
4. この README の一覧を更新する
5. [architecture.md](../architecture.md) 等の正本を、新方針に合わせて更新する

これにより、**いつ・なぜ** 設計方針が変わったかを ADR の鎖で追跡できる。

### Status の意味

| Status | 意味 |
|--------|------|
| `proposed` | 草案・議論中 |
| `accepted` | 合意済み（本文は不変） |
| `deprecated` | 採用しなかった、または無効化（代替 ADR がなくてもよい） |
| `superseded by [NNNN](...)` | 新 ADR に置き換え済み。本文は当時の判断として残す |

例（[0003](0003-conductor-plan-mode.md) → [0005](0005-conductor-is-not-plan-mode.md)）:

```markdown
- Status: superseded by [0005](0005-conductor-is-not-plan-mode.md)
```

### 正本との役割分担

- **ADR** — その時点での判断とトレードオフ（履歴、不変）
- **architecture.md** 等 — いまのシステムの説明（更新してよい）

実装が進んで細部が変わっても、**判断自体が同じ**なら ADR は触らず正本だけ直す。判断が変わったら新 ADR + supersede。

## 一覧

| ADR | タイトル | Status |
|-----|----------|--------|
| [0001](0001-record-architecture-decisions.md) | ADR を残す | accepted |
| [0002](0002-star-topology-sdk-conductor-acp-worker.md) | スター型: SDK conductor + ACP worker | accepted |
| [0003](0003-conductor-plan-mode.md) | conductor は `mode: plan` | superseded → [0005](0005-conductor-is-not-plan-mode.md) |
| [0004](0004-profile-agents-without-fixed-skills.md) | プロファイル: agent 定義と Skill 非固定 | accepted |
| [0005](0005-conductor-is-not-plan-mode.md) | conductor は plan mode ではない | accepted |
| [0006](0006-conductor-agent-mode.md) | conductor は `mode: agent` | accepted |
| [0007](0007-permission-pipeline.md) | 許可パイプライン（3段 + 逆順伝播） | accepted |
| [0008](0008-human-dialogue-open-questions.md) | 人間対話ログと open question 管理 | accepted |
| [0009](0009-conductor-session-event-queue.md) | ConductorSession とセッションイベント列 | accepted |
| [0010](0010-permission-pending-event-delivery.md) | permission pending の conductor 通知（0007 からの方針変更） | accepted |
| [0011](0011-session-sidecar-resume.md) | セッション sidecar と resume | accepted |
| [0012](0012-conductor-worker-prompt-roundtrip.md) | conductor – worker メッセージング（常駐 ACP / sendWorkerMessage） | accepted |
| [0013](0013-process-lifecycle-vs-autonomous-loop.md) | プロセスライフサイクルと自律ループ停止の分離 | accepted |
| [0014](0014-conductor-dispatch-batch-coalescing.md) | conductor イベント dispatch のバッチ化と優先度 | accepted |

## 追加するとき

1. 次の番号で `docs/adr/NNNN-short-title.md` を追加
2. この README の一覧を更新
3. [architecture.md](../architecture.md) 等の正本を新方針に合わせて更新する

**既存 ADR の方針を変えるとき**は [不変性と方針変更](#不変性と方針変更) に従い、旧 ADR は supersede する（本文の書き換えはしない）。
