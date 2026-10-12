---
'@agents-ensemble/core': minor
---

ensemble config の `acp.env` を追加し、codex-acp 等 spawn 時に env をマージ（builtin preset → config `acp.env`）。team profile の `acp` / `workers[].acp` は削除（YAML に残すと load 時エラー）。resume フィンガープリントに `env` を含め、legacy sidecar（env なし）は env 比較をスキップ。
