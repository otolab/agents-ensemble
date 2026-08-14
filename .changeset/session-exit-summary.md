---
"@agents-ensemble/core": patch
"@agents-ensemble/cli": patch
---

セッション終了サマリを統計中心に変更。TTY はテキスト（stderr）、非 TTY は JSON（stdout）。`sessionUsage`・`responsePreview`・`--summary-format` / `--include-full-response-text` を追加。conductor `getUsage().cost` は取得時のみ `sessionUsage` にマージ。
