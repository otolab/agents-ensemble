---
"@agents-ensemble/core": patch
---

イベント型を `conductor/session/events/` に分割。`SessionLogEvent` / `SessionEvent` の正本モジュールを追加し、共有 payload 型・型グループ定数（`ALL_SESSION_LOG_EVENT_TYPES` 等）を公開 export。内部の `isConductorSendEvent` を削除（公開 API には含まれていなかった）。
