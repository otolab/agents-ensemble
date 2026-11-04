---
"@agents-ensemble/cli": patch
---

モデルカタログの操作を `models remote`、`diff`、`add` に分け、従来の `sync` を非推奨の互換入口として維持します。モデル追加先は省略時に user 層になります。
