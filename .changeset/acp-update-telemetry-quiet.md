---
"@agents-ensemble/core": patch
"@agents-ensemble/cli": patch
---

ACP `session/update` の `harness.worker.acp.update` と `conductor.send.progress` を活動ログ / stderr から除外し、Workers ペインにフェーズ変化時のみ活動ヒントを表示（#161）
