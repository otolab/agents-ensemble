---
"@agents-ensemble/operator-agent": patch
"@agents-ensemble/cli": patch
---

Batch related watch reports without losing event order, recover pending reports in active peers, retry completed-report acknowledgements without replaying the conductor turn, and preserve unresolved watch state for safe recovery.
