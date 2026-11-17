---
"@agents-ensemble/operator-agent": patch
---

Fix session report batching so reports already in the local queue while the state lock is contested join the batch before its durable freeze.
