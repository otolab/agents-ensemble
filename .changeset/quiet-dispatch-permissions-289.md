---
'@agents-ensemble/core': patch
---

dispatch hold 中の `permission.pending` を held buffer に積み、release 時に他の trigger とまとめて conductor へ dispatch するようにしました。
