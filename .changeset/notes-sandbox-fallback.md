---
"@agents-ensemble/core": patch
---

`ensemble run` の worker プロンプトで、`ensemble notes` が権限エラーになったときの手順を示すようにした。サンドボックス外で再試行し、それでも書き込めなければ conductor に記録を依頼する。conductor プロンプトにも、依頼を受けたら `push_memo` で代わりに記録することを追加した。
