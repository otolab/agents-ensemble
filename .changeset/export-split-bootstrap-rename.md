---
"@agents-ensemble/core": patch
---

`index.ts` をドメイン別 barrel に分割。`WorkerSession.startWorkers()` を追加し `bootstrap()` を deprecated に。GitHub monitor の `bootstrapOnly` を `initialCursorPoll` に rename。`@agents-ensemble/core/testing` subpath を追加。`SessionSummary` とテスト API のルート export に deprecated 注記。
