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
| [0012](0012-conductor-worker-prompt-roundtrip.md) | conductor – worker メッセージング（常駐 ACP / sendWorkerMessage） | proposed |

## 追加するとき

1. 次の番号で `docs/adr/NNNN-short-title.md` を追加
2. この README の一覧を更新
3. [architecture.md](../architecture.md) 等の正本に矛盾があれば、正本か ADR のどちらを更新するか決める（通常は正本を直し、ADR は superseded にしない限り履歴として残す）
