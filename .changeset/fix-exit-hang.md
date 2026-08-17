---
"@agents-ensemble/core": patch
---

`/exit` 後にプロセスが固まる問題を修正。post-loop 開始直後の `/exit` レース、自律ループ中の in-flight conductor send 待ち、明示終了時の `getUsage` 待ちを解消。
