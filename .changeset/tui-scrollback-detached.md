---
"@agents-ensemble/cli": patch
---

TTY TUI の `stream` で keyboard detached 中の新着 activity log を保留し、`End` で最新へ追従できるようにしました。`pane` では detached 中の新着追記後も同じログ行を維持します。
