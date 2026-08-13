# @agents-ensemble/core

## 0.2.0

### Minor Changes

- facc478: ACP `session/update` を harness テレメトリ（`harness.worker.acp.update`）と TUI Workers 欄に配線。`dispatchMode` 型骨格を追加（#148 フェーズ 1）
- c74fe5f: `agents.<kind>` の system prompt 拡張を modular-prompt YAML（`prompt` / `promptFile`）に統一。`systemPrompt` / `systemPromptFile`（markdown 含む）を削除。

### Patch Changes

- 6ffaf55: イベント型を `conductor/session/events/` に分割。`SessionLogEvent` / `SessionEvent` の正本モジュールを追加し、共有 payload 型・型グループ定数（`ALL_SESSION_LOG_EVENT_TYPES` 等）を公開 export。内部の `isConductorSendEvent` を削除（公開 API には含まれていなかった）。
- 42c9bc1: `index.ts` をドメイン別 barrel に分割。`WorkerSession.startWorkers()` を追加し `bootstrap()` を deprecated に。GitHub monitor の `bootstrapOnly` を `initialCursorPoll` に rename。`@agents-ensemble/core/testing` subpath を追加。`SessionSummary` とテスト API のルート export に deprecated 注記。
- be3891d: TUI Workers 欄を `list_workers` と整合させるため `harness.session.workers` / `harness.worker.state` を追加し reducer を強化（#147）
- badab66: `WorkerLifecycleState` / `WorkerDisplayStatus` と `mapHarnessToDisplayStatus` を公開 export。`WorkerHarnessState` は deprecated alias として維持。

## 0.1.1

### Patch Changes

- 9d2863c: `js-yaml` を core の runtime dependencies に移し、グローバル install 後の `ensemble` 起動を修正

## 0.1.0

### Minor Changes

- d5ce3ef: npm 公開と changeset ベースのリリースフロー（modular-prompt 踏襲）を整備

### Patch Changes

- 124bdba: publish 時に prepublishOnly が dist を再生成するよう tsc --build --force を使う
