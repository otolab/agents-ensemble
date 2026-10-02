---
"@agents-ensemble/core": patch
"@agents-ensemble/cli": patch
---

worker failure や teardown 後に残った stale な `permission.pending` の dispatch を防ぎ、cleanup の発生順と対象 requestId を観測できるようにする。
