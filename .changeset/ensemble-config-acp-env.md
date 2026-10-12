---
'@agents-ensemble/core': patch
---

ensemble config の `acp.env` を追加し、codex-acp 等 spawn 時に env をマージ。team profile の `acp` / `workers[].acp` は非推奨警告。resume フィンガープリントに `env` を含める。
