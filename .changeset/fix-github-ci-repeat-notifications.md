---
"@agents-ensemble/core": patch
---

GitHub monitor の CI 完了通知で、CheckRun の弱い runKey（URL / 名前フォールバック）が poll ごとに揺れて同じ完了を毎回 `github.update` として再送する問題を修正。
