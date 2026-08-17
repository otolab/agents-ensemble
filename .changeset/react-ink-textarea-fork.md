---
"@agents-ensemble/cli": patch
---

`react-ink-textarea` を otolab フォーク（commit pin）へ切り替え、IME 物理カーソルをフォーク `TextArea` の `cursorStart` に委譲した（#196）。GitHub 依存は `dist` 未同梱のため `postinstall` でビルドする。
