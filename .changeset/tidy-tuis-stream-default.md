---
'@agents-ensemble/core': minor
'@agents-ensemble/cli': minor
---

TTY TUI の既定レイアウトを `pane` から `stream` に変更します。従来のペイン分割を使う場合は `tui.layout: pane` または `ENSEMBLE_TUI_LAYOUT=pane` を指定してください。stream では scrollback 閲覧中に新着ログで末尾へ戻る場合があり、通常の幅変更では既追記行は再折り返しされません（[operator-input.md](https://github.com/otolab/agents-ensemble/blob/main/docs/operator-input.md)、[ADR 0015](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0015-cli-tui-library.md)）。
