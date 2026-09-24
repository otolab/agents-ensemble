# ADR 0024: TUI columns 縮小時の live frame coalesce

- Status: accepted
- Date: 2026-09-24

## Context

[ADR 0022](0022-tui-resize-workaround.md) は、`stdout.resize` の settle と Ink の rows high-water mark によって、TUI の settled snapshot と Ink の resize 通知を揃え、端末全体の clear と Static history の replay を避ける判断を記録した。その後、iTerm2 + tmux でウィンドウ幅を段階的に縮小すると、SIGWINCH の quiet interval が 100ms を超えるステップごとに columns の中間値が settled snapshot になり、pane / stream の live frame が幅ごとに再配置される問題が残った。250ms の shrink coalesce だけを入れた候補は、オペレータの実端末確認で stream の幅拡大が止まり、縮小時の崩れと scrollback への流れも解消しなかった。

TTY の resize API にはドラッグ終了イベントがなく、縮小操作中の最後のイベントを事前に知ることはできない。したがって、端末全体の clear や Static history の replay を再導入せず、columns の減少だけを quiet-period でまとめる必要がある。

## Decision

`createTuiTerminalSizeStore` は resize の方向に応じて settle policy を分ける。

- columns の増加、rows の変更、または縮小中の方向転換は、既存の `TUI_RESIZE_SETTLE_MS = 100` ms の通常経路で処理する。
- columns の連続した減少は `TUI_RESIZE_SHRINK_COALESCE_MS = 250` ms の quiet-period に保留する。縮小イベントを受けるたびにタイマーをリセットし、**最後の縮小イベントから 250ms** resize が届かなかったときに、読み取った最終幅を 1 回だけ snapshot として公開する。これは最初の縮小イベントから数えた絶対上限ではない。
- coalesce 中の中間幅は TUI の subscriber と Ink の resize listener に通知しない。TUI の `terminalSizeStore` は settled した実際の `columns` / `rows` を公開する一方、`createTuiResizeController` の stdout proxy が Ink に公開する `columns` は shrink 中の high-water mark とする。settle 時に幅が増えた場合は high-water mark を更新し、幅が減った場合は下げない。`rows` の high-water mark も維持するため、TUI の layout / frame は実幅、Ink の viewport は clear 判定を避けるための high-water mark という役割分担になる。
- resize 時の `ESC[2J` / `ESC[3J`、端末全体の clear、stream Static history の remount / replay / re-emit は行わない。
- `tui-terminal-size.test.ts`、`issue-session-tui.test.tsx`、`issue-session-tui-stream.test.tsx` で、方向別 policy、同一 rows の段階縮小、最終 live frame、clear sequence 非出力、Static history 非重複を回帰ゲートとする。

## Consequences

### 良い点

- iTerm2 + tmux の連続した縮小で中間幅ごとの live frame 再配置を抑え、TUI は settled した最終実幅で pane / stream を再配置できる。
- Ink の幅縮小処理に渡す viewport は shrink 前の high-water mark を保つため、折り返し行数の不一致による clear 判定を避けられる。幅拡大・高さ変更は既存の通常経路を維持し、幅拡大時は proxy の high-water mark も更新する。

### 制約・リスク

- 縮小の表示更新は最後の縮小イベントから 250ms の quiet-period が終わるまで遅延する。250ms より長い停止後に再び縮小した場合は、新しい縮小窓として扱うため、操作全体の経過時間に絶対上限はない。
- TTY からドラッグ終了を取得できないため、250ms より長い間隔の縮小ステップは別窓になり、中間 frame が更新される可能性がある。
- `stdout.columns` は縮小後も Ink には high-water mark を返すため、Ink の viewport と TUI の settled snapshot の `columns` は意図的に一致しないことがある。これは端末の物理幅を変更するものではなく、Ink の resize / clear 判定だけに適用する workaround である。
- 2026-09-24 時点で、オペレータの iTerm2 + tmux 実端末確認は stream の幅拡大回帰と、縮小時の崩れ・scrollback への流れが残る fail だった。この候補実装（columns high-water mark + shrink coalesce）の pane / stream 実端末再確認は未完了であり、pass と扱わない。

### 撤去条件

ADR 0022 の撤去条件に加え、実端末での段階縮小確認を行い、shrink coalesce が不要になった根拠を新しい ADR に記録するまで、この policy を撤去しない。
