---
"@agents-ensemble/core": patch
"@agents-ensemble/cli": patch
---

conductor の Connection stalled 時に in-process transport 再接続を試行し、オペレータの `/reconnect` コマンドを追加する。
