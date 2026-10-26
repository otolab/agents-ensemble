---
'@agents-ensemble/core': patch
---

`ENSEMBLE_USER_ROOT` で user 層の設定と session storage の保存先を指定できるようにしました。未指定時の既定値と、呼び出し側から明示された user root はこれまでどおりです。
