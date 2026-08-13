---
"@agents-ensemble/core": minor
---

profile の `workers[]` に optional な `workspace` を追加し、worker ごとの ACP 起動 cwd（`agent acp` の `session/new` / `session/load`）を指定可能にした。未指定時は従来どおりセッション共通の Issue worktree を使用する。
