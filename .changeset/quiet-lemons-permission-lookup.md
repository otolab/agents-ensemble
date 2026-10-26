---
'@agents-ensemble/core': patch
---

`permission.pending` の判断では `request.raw` を第一ソースとして扱うよう conductor 向けの指示を明確にし、`get_tool_call` が snapshot 未登録時に参照先を返すようにしました。
