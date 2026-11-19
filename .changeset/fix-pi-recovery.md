---
"@agents-ensemble/core": patch
"@agents-ensemble/cli": patch
"@agents-ensemble/operator-agent": patch
---

Pi を 1.5.2 に更新し、出力上限からの回復時に tool result が孤立して会話を続けられなくなる問題を修正します。Pi の要件に合わせ、Node.js の最低バージョンを 22.19.0 に引き上げます。従来の公開要件は core が 22.0 以上、CLI / operator-agent が 22.13 以上でした。22.19 未満を使用している場合は Node.js を更新してください。
