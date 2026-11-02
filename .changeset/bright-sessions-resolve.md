---
"@agents-ensemble/core": patch
"@agents-ensemble/operator-agent": patch
---

移行後に path-hash 側の古い SessionResumeStore が残っていても canonical slug 側を選び、選択先と socket 記録の有無を operator に知らせます。
