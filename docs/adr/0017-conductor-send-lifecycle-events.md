# ADR 0017: conductor send ライフサイクルイベントと Driver 非同期化

- Status: accepted
- Date: 2026-08-12
- Related: Issue [#129](https://github.com/otolab/agents-ensemble/issues/129), [#86](https://github.com/otolab/agents-ensemble/issues/86), [#128](https://github.com/otolab/agents-ensemble/issues/128), [ADR 0016](0016-bootstrap-permission-conductor-wait.md)

## Context

`SessionDriver` は `runEventConductorSend` を `await` しており、in-flight 中は次の dispatch 束を開始できなかった（[ADR 0016](0016-bootstrap-permission-conductor-wait.md)）。`conductor.send.started` は #128 で追加済みだが、`ConductorAgent.send` の SDK `onDelta` は未配線で、ターン途中の進捗（ツール開始）が harness テレメトリに載らなかった。

検討した論点:

| 論点 | 決定 |
|------|------|
| `sendCount` 増分 | **完了時のまま**（`SessionLogger.snapshot` 互換）。`started` / `progress` は「これから / 進行中の番号」 |
| progress 粒度 | **ツール開始のみ**（`conductor.send.progress`）。text delta はスコープ外 |
| 複数 in-flight | **1 本のみ**。dispatch 再入は [#86](https://github.com/otolab/agents-ensemble/issues/86) |
| resume | in-flight 状態は復元しない（`--continue` は完了済み send から再開） |

## Decision

### 1. SessionLogEvent ライフサイクル

| type | タイミング | snapshot |
|------|------------|----------|
| `conductor.send.started` | `agent.send` 開始直前（既存） | 影響なし |
| `conductor.send.progress` | SDK `tool-call-started`（新規） | 影響なし |
| `conductor.send` | `agent.send` 完了後（既存） | `sendCount` / `lastRunStatus` / `lastResult` / `lastError` を更新 |

**後方互換**: 既存 sink は `conductor.send`（完了）のみ購読していれば動作は変わらない。progress は追加イベント。

### 2. Driver 非同期化

- `runEventConductorSend` は Promise を返し、Driver は **単一 in-flight** を保持する
- in-flight 中は次の dispatch 束を開始しない（#86 まで）
- in-flight 完了待ちの間も harness 側（worker / permission 等）の `SessionLogger.emit` は従来どおり独立
- `onDelta` → `onSendProgress` → `conductor.send.progress` を配線

### 3. resume

sidecar / `--continue` 再開時に in-flight runId やツール状態は復元しない。未完了 send は存在しない前提（プロセス再起動で run は失われる）。

## Consequences

### 良い点

- started → progress → completed の時系列が stderr / TUI で観測可能
- ADR 0016 のイベント駆動モデルと実装の方向が一致
- 完了イベント契約を維持し、exit JSON / 既存 sink を壊さない

### 悪い点・リスク

- in-flight 中の permission dispatch 再入は未実装（#86 依存）
- progress はツール開始のみで、本文ストリーミング UI は別 Issue
- resume 後に in-flight があった場合の扱いは未サポート（doc で明示）

### フォロー

- [#86](https://github.com/otolab/agents-ensemble/issues/86) — in-flight cancel / dispatch 再入

## 参照

- [harness-events.md](../harness-events.md) — イベント一覧・ライフサイクル図
- `packages/core/src/conductor/conductor-session-driver.ts`
- `packages/core/src/conductor/conductor-agent.ts`
