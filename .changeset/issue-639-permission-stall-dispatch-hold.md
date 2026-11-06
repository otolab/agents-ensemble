---
"@agents-ensemble/core": patch
---

dispatch hold 中や worker が idle になった後も、長時間停滞した permission の回復通知を conductor へ届けます。
