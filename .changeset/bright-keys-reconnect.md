---
'@agents-ensemble/operator-agent': patch
'@agents-ensemble/core': patch
---

operator-agent が Pi の認証エラー後に同じ入力を一度再試行し、TTY の `/reconnect` を専用の再接続操作として扱うようになりました。
