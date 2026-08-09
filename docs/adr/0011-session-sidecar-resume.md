# ADR 0011: セッション sidecar と resume

- Status: accepted
- Date: 2026-08-09
- Related: [ADR 0008](0008-human-dialogue-open-questions.md), [ADR 0009](0009-conductor-session-event-queue.md)

## Context

`ensemble issue` を止めたあと再起動し、同じ Issue の作業を続けたい（#27）。

永続化が必要なもの:

| 対象 | 手段 |
|------|------|
| conductor 会話 | SDK `Agent.resume(conductorAgentId)` |
| open question | harness sidecar |
| worker ACP 会話 | `session/load` + 保存した `acpSessionId` |
| profile | セッション開始時のスナップショット（sidecar） |
| worktree | **sidecar には載せない** — `issueUrl` + `repoRoot` から導出 |

### `agent acp` の session 復元（実測 2026-08-09）

| 操作 | プロセス再起動後 |
|------|------------------|
| `session/prompt` のみ（旧 sessionId） | **失敗** — `Session … not found` |
| `session/resume` | **未実装** — `Method not found` |
| **`session/load`**（sessionId + cwd） | **成功** — 続けて `session/prompt` 可能 |

セッション状態は `~/.cursor/acp-sessions/{sessionId}/` に SQLite で残る。新しい `agent acp` プロセスからは **`session/load` が必須**。

フォールバック: `session/load` 失敗時は `session/new` + 初回 bootstrap prompt。

## Decision

### sidecar の場所とスキーマ

`{repoRoot}/.ensemble/sessions/{conductorAgentId}.json`

```json
{
  "version": 1,
  "conductorAgentId": "...",
  "issueUrl": "...",
  "repoRoot": "...",
  "profile": { },
  "profilePath": "optional",
  "openQuestions": [ ],
  "sequence": 3,
  "workers": {
    "implementer": { "acpSessionId": "..." }
  },
  "updatedAt": 1735689600000
}
```

- flush: `runConductorSession` の `finally`（正常終了・エラー・未処理例外を問わず best-effort）。状態変化時（send 完了・worker 完了・open question 変更）にも増分 flush する
- SIGINT / SIGTERM: 内部 `AbortController` でイベント待ちを中断し、`stopReason: interrupted` で graceful shutdown + flush
- load: `resumeAgentId` 指定時。sidecar が無い場合は `SessionSidecarNotFoundError` で起動失敗。`issueUrl` / `repoRoot` が一致しない場合もエラー
- `--continue`（#31）: `findLatestSessionSidecarForIssue` で同一 Issue の最新 `updatedAt` を選ぶ

### worker resume

- bootstrap / dispatch 時に `acpSessionId` を結果として記録し sidecar に反映
- resume 時は profile の worker `name` をキーに `session/load`（cwd は worktree 絶対パス）
- `session/resume` は使わない（Cursor `agent acp` 未対応）

### 廃止・非永続

- `SessionDialogueLog` — 削除済み（SDK 会話が正本）
- `turns` 配列 — 削除済み（`sendCount` のみ）
- `worktreePath` — sidecar に載せない
- `PermissionPipeline.pending` — **v1 では sidecar に載せない**（accepted risk、下記）

### Accepted risk: pending permission 非永続

v1 の sidecar には permission 待ち状態を保存しない。

| シナリオ | 挙動 |
|----------|------|
| 正常終了（`finally`） | 未解決の pending permission は **deny** して worker に返す（既存の `rejectAllPendingPermissions`） |
| 異常終了 + resume | sidecar に pending が無いため、中断直前の permission 待ちは **復元されない**。worker は deny またはタイムアウト相当になりうる。オペレータは再判断が必要 |
| resume 後の新規 permission | 通常どおり `permission.pending` イベントで conductor に届く |

permission 待ちの永続化は別 Issue で検討する。

## Consequences

- 良い: conductor + registry + worker 会話を一貫して resume できる経路ができる
- 悪い: sidecar と SDK store の二重管理。`session/load` 失敗時は worker 文脈がリセットされる
- フォロー: sidecar の gitignore 方針、複数マシン間 resume
