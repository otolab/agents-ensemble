# Architecture Decision Records (ADR)

> **参照:** 設計判断の履歴と不変性ルール。現行の構成・API の正本は [architecture.md](../architecture.md) 等にあります。

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
| [0015](0015-cli-tui-library.md) | CLI TUI ライブラリ選定（Ink） | accepted |
| [0016](0016-bootstrap-permission-conductor-wait.md) | bootstrap 中 permission と conductor 自律待機のデッドロック | accepted |
| [0017](0017-conductor-send-lifecycle-events.md) | conductor send ライフサイクルイベントと Driver 非同期化 | accepted |
| [0018](0018-team-profile-four-layer-resolution.md) | team-profile の 4 層配置と名前解決 | accepted |
| [0019](0019-worker-acp-cli-presets.md) | Worker ACP CLI preset とデフォルト解決 | accepted |
| [0020](0020-ensemble-config-setting-resolution.md) | ensemble config.yaml の設定解決順（Phase 1） | accepted |
| [0021](0021-conductor-mcp-config-resolution.md) | conductor MCP 設定の 2 層解決と inline 配線 | accepted |
| [0022](0022-tui-resize-workaround.md) | TUI resize workaround と Ink 回帰監視 | superseded → [0024](0024-tui-shrink-coalesce.md) |
| [0023](0023-tty-initial-message-post-loop.md) | TTY 初回メッセージの post-loop ライフサイクル | accepted |
| [0024](0024-tui-shrink-coalesce.md) | TUI columns 縮小時の live frame coalesce | accepted |
| [0025](0025-conductor-agent-backend-sdk-and-pi.md) | conductor LLM backend（Cursor SDK と Pi）の併存 | proposed |
| [0026](0026-tui-stream-shrink-recovery.md) | stream 縮小時 scrollback 再同期 | accepted |
| [0027](0027-permission-stall-notification.md) | permission 停滞通知の低優先度 dispatch | superseded in part → [0056](0056-permission-stall-dispatch-hold.md)（dispatch hold） / [0057](0057-permission-stall-idle-detection.md)（activity gate） |
| [0028](0028-authentication-delegation-and-ensemble-auth.md) | 認証の管理方針（worker 移譲・conductor と ensemble auth） | accepted |
| [0029](0029-lazy-worker-attach.md) | worker ACP lazy attach | accepted |
| [0030](0030-tty-close-lifecycle.md) | TTY `/close` の再開可能な終了契約 | accepted |
| [0031](0031-operator-agent-layer.md) | operator 層と operator-agent（user – operator – conductor – workers） | accepted |
| [0032](0032-tool-call-snapshot-history.md) | tool-call snapshot 履歴の永続化 | accepted |
| [0033](0033-live-open-question-control-uds.md) | 稼働中 Open Question の UDS control API | superseded → [0036](0036-live-open-question-answer-contract.md)（回答の保存・応答条件のみ） |
| [0034](0034-bounded-open-question-dispatch-drain.md) | 稼働中 Open Question の bounded dispatch drain | superseded → [0035](0035-open-question-shutdown-commit-order.md) |
| [0035](0035-open-question-shutdown-commit-order.md) | Open Question の shutdown retry 抑止と永続化 commit 順序 | accepted |
| [0036](0036-live-open-question-answer-contract.md) | 稼働中 Open Question の回答応答条件 | accepted |
| [0037](0037-operator-agent-session-watch-and-dispatch.md) | operator-agent の session watch と report dispatch | accepted |
| [0038](0038-operator-agent-conversation-report-hold.md) | operator-agent の会話中に watch report を保留する | accepted |
| [0039](0039-session-resume-state-and-operator-projection.md) | SessionResumeStore・harness phase・operator 投影（到達性・coherence） | accepted |
| [0040](0040-explicit-ensemble-config-file.md) | 起動時に指定する ensemble config ファイル | superseded → [0042](0042-explicit-config-replaces-user-layer.md) |
| [0041](0041-ensemble-config-resume-digest.md) | resolved ensemble config の resume 整合性 | superseded → [0042](0042-explicit-config-replaces-user-layer.md) |
| [0042](0042-explicit-config-replaces-user-layer.md) | `--config` による user config 層の差し替え | superseded → [0048](0048-session-resume-feasibility-config-digest.md)（resume digest 方針のみ） |
| [0043](0043-explicit-user-config-and-project-toggle.md) | 明示 user config と project load toggle の併用 | accepted |
| [0044](0044-user-scoped-runtime-storage.md) | repo 単位のランタイム状態を user 層へ配置 | superseded → [0046](0046-migrated-session-canonical-slug-mirrors.md) |
| [0045](0045-worker-acp-model-tags.md) | worker ACP model tag と環境別 model catalog | superseded → [0047](0047-worker-acp-model-reasoning.md)（model catalog の値と reasoning 指定のみ） |
| [0046](0046-migrated-session-canonical-slug-mirrors.md) | 移行済みセッションの canonical slug mirror | accepted |
| [0047](0047-worker-acp-model-reasoning.md) | worker ACP model catalog の reasoning | superseded → [0048](0048-session-resume-feasibility-config-digest.md)（resume digest） / [0052](0052-acp-model-injection-by-preset.md)（worker routing） |
| [0048](0048-session-resume-feasibility-config-digest.md) | Session resume feasibility と config digest | superseded → [0051](0051-conductor-reasoning-resume-digest.md)（`conductor.reasoning` の分類のみ） |
| [0049](0049-conductor-reasoning-backends.md) | conductor reasoning を backend ごとに適用する | superseded → [0051](0051-conductor-reasoning-resume-digest.md)（resume digest 方針のみ） |
| [0050](0050-operator-agent-conductor-reasoning.md) | operator-agent に conductor reasoning を適用する | superseded → [0051](0051-conductor-reasoning-resume-digest.md)（resume digest 方針のみ） |
| [0051](0051-conductor-reasoning-resume-digest.md) | conductor reasoning と resume-feasibility digest | accepted |
| [0052](0052-acp-model-injection-by-preset.md) | worker ACP model / reasoning の preset 別注入 | superseded → [0054](0054-cursor-acp-runtime-verification.md)（Cursor の runtime 制約のみ。その他 preset は継続） |
| [0053](0053-worker-acp-cursor-fast-option.md) | worker ACP の Cursor fast mode 明示設定 | superseded → [0054](0054-cursor-acp-runtime-verification.md)（Cursor の明示 option は fail fast、model-only は CLI への要求） |
| [0054](0054-cursor-acp-runtime-verification.md) | Cursor ACP の未検証 runtime と resume metadata の扱い | superseded → [0055](0055-cursor-model-only-cli-contract.md)（Cursor model-only の受け入れ境界のみ） |
| [0055](0055-cursor-model-only-cli-contract.md) | Cursor worker の model-only 指定を公式 CLI 契約で受け入れる | accepted |
| [0056](0056-permission-stall-dispatch-hold.md) | dispatch hold 中の permission stall 回復通知 | accepted |
| [0057](0057-permission-stall-idle-detection.md) | idle worker 中も pending permission の停滞を検知 | accepted |
| [0058](0058-pi-send-recovery-replay-boundary.md) | Pi send recovery の再送境界 | superseded → [0059](0059-pi-recovery-report-after-manual-reconnect.md) |
| [0059](0059-pi-recovery-report-after-manual-reconnect.md) | Pi 手動再接続後の recovery report | superseded → [0060](0060-pi-recovery-operator-inbox.md) |
| [0060](0060-pi-recovery-operator-inbox.md) | Pi 失敗 dispatch の operator 専用 inbox | accepted |
| [0061](0061-github-slug-session-persistence.md) | Issue session の slug 正本と operator-agent の user profile | proposed |
| [0062](0062-conductor-auth-mode-status-contract.md) | Conductor 認証モードと status / 復旧案内の契約 | proposed |

## 追加するとき

1. 次の番号で `docs/adr/NNNN-short-title.md` を追加
2. この README の一覧を更新
3. [architecture.md](../architecture.md) 等の正本を新方針に合わせて更新する

**既存 ADR の方針を変えるとき**は [不変性と方針変更](#不変性と方針変更) に従い、旧 ADR は supersede する（本文の書き換えはしない）。
