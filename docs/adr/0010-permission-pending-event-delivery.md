# ADR 0010: permission pending の conductor 通知（ADR 0007 からの方針変更）

- Status: accepted
- Date: 2026-08-08
- Related: Issue #28, [ADR 0007](0007-permission-pipeline.md), [ADR 0009](0009-conductor-session-event-queue.md)
- Supersedes（部分的）: ADR 0007 の「conductor への pending 通知の載せ方」のみ

## Context

[ADR 0007](0007-permission-pipeline.md) は許可パイプラインの **3 段 + 逆順伝播** を定義した。Decision に次の運用が含まれていた:

- conductor prompt に pending permission 一覧を載せる
- `issue-session` ループは pending 解消まで継続する

[ADR 0009](0009-conductor-session-event-queue.md) で ConductorSession の **セッションイベント列** を導入した。conductor への入力は毎ターン full prompt 投影ではなく、**1 イベント = 1 `agent.send`** となった。

ADR は履歴として残す。0007 の段1〜3の責務分担（policy 即決 / `resolve_permission` / `ask_human`）は変わらない。**pending を conductor にどう届けるか** だけが変わる。

## Decision

### 方針変更（ADR 0007 Decision L23 から）

| 項目 | ADR 0007（当時） | 本 ADR（現在） |
|------|------------------|----------------|
| harness 名 | `issue-session` | **ConductorSession**（[ADR 0009](0009-conductor-session-event-queue.md)） |
| pending の conductor 通知 | 毎ターン prompt に pending 一覧を載せる | **初回 send**（system + Issue ブリーフィング）のみ。以降は **`permission.pending` イベント** をセッションイベント列に enqueue → `agent.send` |
| ループ継続 | pending 解消まで | 変更なし（pending ありは継続） |

policy で即決できなかった permission は、従来どおり `PermissionPipeline` で pending 登録する。conductor への通知は **prompt state への毎ターン投影ではなく**、`permission.pending` イベント 1 件として列に積む。

### 変わらないもの（ADR 0007 を維持）

- 段1: policy 自明 allow/deny → worker へ即応答
- 段2: 非自明は pending → conductor が `resolve_permission`
- 段3: 要確認は `ask_human`（[ADR 0008](0008-human-dialogue-open-questions.md)）
- セッション終了時: 未解決 pending は `deny` で伝播

## Consequences

- 良い: ADR 0007 のパイプライン段階と、ADR 0009 のイベント列モデルが矛盾しない
- 悪い: 0007 を読むだけでは通知経路が分かりにくい → **本 ADR を併読**
- フォロー: [architecture.md](../architecture.md) §5、[ADR 0009](0009-conductor-session-event-queue.md)

## 関連する方針変更（参考）

[ADR 0008](0008-human-dialogue-open-questions.md) L80 付近の「自律ターン worker 状態更新の詳細は実装 Issue で設計」は、[ADR 0009](0009-conductor-session-event-queue.md) で ConductorSession イベント列として確定した。0008 本文は履歴として残す。
