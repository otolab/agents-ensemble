---
"@agents-ensemble/core": patch
"@agents-ensemble/cli": patch
---

Open question の回答をコマンドより優先し、Issue セッションの終了・再接続は slash 付きコマンドに限定します。slash なしの close / exit / reconnect は通常メッセージとして送られます。
