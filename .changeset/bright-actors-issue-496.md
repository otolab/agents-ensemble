---
'@agents-ensemble/cli': patch
---

TTY の Ink TUI（pane / stream）の Operator input 欄に限り、行頭を `> ` に統一します。Ink を使わない TTY 継続入力（`bindAsyncOperatorInput`）の `operator> ` と、非 TUI の stdout 対話ログに付く `operator>` / `conductor>` の話者ラベルは従来どおりです。
