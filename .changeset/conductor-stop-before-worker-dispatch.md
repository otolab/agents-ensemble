---
'@agents-ensemble/core': patch
---

conductor が `prompt_worker` で worker を dispatch した直後に自律ループが停止し teardown が始まる問題を修正しました。outbound dispatch 件数の追跡と `runningCount` の同期更新により、worker 完了を待ってから停止判定します。
