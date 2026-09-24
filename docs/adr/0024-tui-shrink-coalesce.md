# ADR 0024: TUI columns 縮小時の live frame coalesce

- Status: accepted
- Date: 2026-09-24

## Context

[ADR 0022](0022-tui-resize-workaround.md) は、`stdout.resize` の settle と Ink の rows high-water mark によって、TUI の settled snapshot と Ink の resize 通知を揃え、端末全体の clear と Static history の replay を避ける判断を記録した。その後、iTerm2 + tmux でウィンドウ幅を段階的に縮小すると、SIGWINCH の quiet interval が 100ms を超えるステップごとに columns の中間値が settled snapshot になり、pane / stream の live frame が幅ごとに再配置される問題が残った。

TTY の resize API にはドラッグ終了イベントがなく、縮小操作中の最後のイベントを事前に知ることはできない。したがって、端末全体の clear や Static history の replay を再導入せず、columns の減少だけを quiet-period でまとめる必要がある。

## Decision

`createTuiTerminalSizeStore` は resize の方向に応じて settle policy を分ける。

- columns の増加、rows の変更、または縮小中の方向転換は、既存の `TUI_RESIZE_SETTLE_MS = 100` ms の通常経路で処理する。
- columns の連続した減少は `TUI_RESIZE_SHRINK_COALESCE_MS = 250` ms の quiet-period に保留する。縮小イベントを受けるたびにタイマーをリセットし、**最後の縮小イベントから 250ms** resize が届かなかったときに、読み取った最終幅を 1 回だけ snapshot として公開する。これは最初の縮小イベントから数えた絶対上限ではない。
- coalesce 中の中間幅は TUI の subscriber と Ink の resize listener に通知しない。settled snapshot は従来どおり両者で共有し、`createTuiResizeController` の rows high-water mark proxy を維持する。
- resize 時の `ESC[2J` / `ESC[3J`、端末全体の clear、stream Static history の remount / replay / re-emit は行わない。
- `tui-terminal-size.test.ts`、`issue-session-tui.test.tsx`、`issue-session-tui-stream.test.tsx` で、方向別 policy、同一 rows の段階縮小、最終 live frame、clear sequence 非出力、Static history 非重複を回帰ゲートとする。

## Consequences

### 良い点

- iTerm2 + tmux の連続した縮小で中間幅ごとの live frame 再配置を抑え、最終幅だけで pane / stream を再配置できる。
- 幅拡大・高さ変更の既存経路を維持し、端末全体の clear と Static history の replay を避けられる。

### 制約・リスク

- 縮小の表示更新は最後の縮小イベントから 250ms の quiet-period が終わるまで遅延する。250ms より長い停止後に再び縮小した場合は、新しい縮小窓として扱うため、操作全体の経過時間に絶対上限はない。
- TTY からドラッグ終了を取得できないため、250ms より長い間隔の縮小ステップは別窓になり、中間 frame が更新される可能性がある。
- iTerm2 + tmux の実端末での pane / stream resize と native scrollback は、この ADR 作成時点では未確認である。確認手順は [TUI 端末互換性マトリクス](../tui-terminal-compatibility.md) に追加し、確認済みになるまで該当セルを未確認のままにする。

### 撤去条件

ADR 0022 の撤去条件に加え、実端末での段階縮小確認を行い、shrink coalesce が不要になった根拠を新しい ADR に記録するまで、この policy を撤去しない。
