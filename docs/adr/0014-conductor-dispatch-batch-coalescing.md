# ADR 0014: conductor イベント dispatch のバッチ化と優先度

- Status: accepted
- Date: 2026-08-12

## Context

[ADR 0009](0009-conductor-session-event-queue.md) では、セッションイベント列から **1 イベント = 1 `agent.send`** で conductor に届ける方針を採用した。フォローとして「優先度・割り込み」を残していた（#67）。

dogfooding では次の不満が出た。

- 短時間に複数 worker が完了すると、conductor 往復が増え文脈が断片化する
- オペレータが連続入力しても 1 行ずつ `agent.send` される
- 直前に扱っていた worker の続報が、他 worker より遅れることがある

一方、`@cursor/sdk` の `agent.send` は **`string | SDKUserMessage` 1 件**のみ受け付ける（複数 user ターンの配列 API はない）。バッチは **1 本の user テキストへの合成**で実現する。

### 合意した優先ルール（#67 コメント）

1. **オペレータ割り込みで進行中ターンを cancel** — 本 ADR の非スコープ（別 Issue）
2. **オペレータメッセージは最優先**
3. **直前 dispatch のメンバー**からの再メッセージは **次の 1 回だけ** 優先（継続優先はしない）
4. **読み取り時点で届いている同一メンバー**のメッセージは 1 束にまとめる
5. まとめ方は「独立したが連続した」ことが自然に分かること（番号付きセクション）
6. まとめアルゴリズムは **unittest で TDD**

### メンバー（source key）

| イベント | source key |
|----------|------------|
| `operator.message` | `operator` |
| `permission.pending` | `permission` |
| `worker.completed` / `worker.failed` | `worker:${name}`（`roundKind` は key に含めない） |

## Decision

### 1 束 = 1 `agent.send`

ADR 0009 の「1 イベント = 1 send」を拡張し、**1 dispatch 束 = 1 send** とする。束は 1 件のこともある（後方互換）。

```
SessionEventQueue
  → selectDispatchBatch(queue, state, policy)   // 純関数 + Driver 状態
  → formatSessionEventsForConductor(events[])
  → agent.send(composedText)
```

### 束の選び方（`selectDispatchBatch`）

dispatch 可能なイベント（`canDispatchConductorSend` を満たすもの）だけを対象に、次の順で **source key を 1 つ**選ぶ。

1. `operator` が 1 件でもあれば `operator`
2. そうでなく、`permission` が 1 件でもあれば `permission`（**continuation より上**）
3. そうでなく、直前 dispatch が `worker:*` であり、`lastDispatchedSourceKey` の dispatch 可能イベントがあれば **その worker を 1 回だけ**優先（`continuationConsumed` で消費）
4. そうでなく、静的優先度で選ぶ: `worker.failed` > `worker.completed`。同順位はキュー内の **最初の出現**が早い key

**「優先」の意味**: 上記は **次に dispatch する束の選択順** である。進行中 conductor ターンの割り込み cancel は [#86](https://github.com/otolab/agents-ensemble/issues/86) のスコープ。

選んだ key に属する **dispatch 可能なイベントをキュー内の到着順のまますべて** 1 束にする（他 key のイベントはキューに残す）。これが Issue #67 ルール 4 の「まとめ方」であり、continuation とは別概念。

dispatch 完了後、Driver は `lastDispatchedSourceKey` を束の key にセットし `continuationConsumed = false` にする。continuation は **`worker:*` dispatch の直後のみ** arm され、次の 1 回の select で worker key が選ばれたとき `continuationConsumed = true` になる。permission / operator dispatch 後は worker continuation は適用しない。

### フォーマット

- 1 件: 現行 `formatSessionEventForConductor` と同一
- 複数件: 種別ごとの見出しに件数を付け、本文は `### 1/N` … で区切る

### Policy

| 項目 | ルール |
|------|--------|
| `autonomousTurns` | **1 send = +1**。束に `operator.message` が含まれる場合は **0 にリセット** |
| `maxTurns` | 束内の各イベントが個別に `canDispatchConductorSend` を満たすこと |
| `dispatchesThisTurn`（`onSendComplete.workerDispatches` / `workerFailures`） | 束内の `worker.completed` / `worker.failed` 件数を合算 |
| ループ停止の `dispatchesThisTurn` | conductor が **この send で新規 dispatch した** worker 件数（従来どおり配列差分） |

### タイミング

**ターン完了後のスナップショット**（キューに溜まった到着済みイベントをまとめる）。短い coalesce ウィンドウ（N ms）は本 ADR の非スコープ。

### `SessionEventQueue` API

| API | 用途 |
|-----|------|
| `snapshot` / `replaceQueue` | Driver が `selectDispatchBatch` の結果でキューを更新 |
| `waitForEvent` + `prependSilent` | 待機中に届いたイベントを到着順どおりキューへ戻す（waiter 直受けの取りこぼし防止） |
| `waitForSendEvent` | **legacy**（単体テストのみ）。本番 Driver は未使用。将来削除候補 |

## Consequences

### 良い点

- conductor 往復が減り、同一メンバーからの連続通知をまとめて読める
- オペレータ優先・直前メンバー 1 回優先が明示的
- `selectDispatchBatch` を純関数化でき、TDD しやすい

### 悪い点・リスク

- `continuationSourceKey` の one-shot 状態が Driver に載り、複雑度が増える
- 1 束に複数 YAML ブロックが載り、トークン量が増える可能性
- SDK は単一 user テキストのみ — 構造は markdown 頼み

### フォロー

- オペレータ割り込み + 進行中 `run.cancel()` — [#86](https://github.com/otolab/agents-ensemble/issues/86)
- `--coalesce-ms` 等の時間窓バッチ — 任意（別 PR）
- [architecture.md](../architecture.md) / [operator-input.md](../operator-input.md) の dispatch 記述 — 本 ADR に合わせて更新済み

## 参照

- #67
- [ADR 0009](0009-conductor-session-event-queue.md)
- [Cursor SDK TypeScript](https://cursor.com/docs/sdk/typescript) — `agent.send(message: string | SDKUserMessage)`
