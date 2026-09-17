---
'@agents-ensemble/core': patch
---

`--continue` 再開時に initial conductor send が `permission.pending` を塞ぎ calling/thinking で固まる問題を修正しました。resume 時は `skipInitialSend` を配線し、worker イベントを即時 dispatch します。
