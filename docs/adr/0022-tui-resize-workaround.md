# ADR 0022: TUI resize workaround と Ink 回帰監視

- Status: superseded by [0024](0024-tui-shrink-coalesce.md)
- Date: 2026-09-24

## Context

CLI の TUI は `alternateScreen: false` で Ink を使い、端末の native scrollback を維持する。Ink 7.1.1 は `stdout.resize` を監視し、frame の高さと viewport の関係に応じて clear を選択する。幅縮小では、端末上ですでに折り返された行数と Ink が保持する前回 frame の行数が一致しないことがあり、ghost line や古い frame の残存につながる。

[Ink #907](https://github.com/vadimdemedes/ink/issues/907) はこの幅縮小時の ghost line を報告しているが、2026-09-24 の調査時点では `Closed as not planned` で、修正 PR は紐づいていない。[Ink #994](https://github.com/vadimdemedes/ink/pull/994) は `clearTerminal` による scrollback 消去を viewport 限定の clear に変える変更として master に merge されているが、#907 の wrap 行数不一致の修正として release されたものではない。したがって、upstream の未リリース挙動や別の clear 修正だけを前提に現行 workaround を撤去できない。

Issue #298 の B+C+D 方針では、pane / stream の live frame だけを resize 境界で再配置し、Static activity history を replay しないこと、端末全体の clear を行わないことを採用した。Ink の resize 通知と TUI の terminal-size snapshot が別のタイミングで処理されると、この方針と競合するため、`createTuiResizeController` が必要になった。

## Decision

`createTuiResizeController` の settle + high-water mark stdout proxy を維持し、Ink の upstream version bump では [Ink / React アップグレード回帰手順](../tui-ink-upgrade.md)を必須の回帰ゲートとする。

- **settle:** `stdout.resize` の burst を `TUI_RESIZE_SETTLE_MS = 100` ms にまとめる。settled snapshot を TUI の layout / frame と Ink の resize listener で共有し、Ink が旧幅の frame を直列化しないようにする。
- **proxy:** TUI は settled snapshot の実際の `columns` / `rows` を使う。Ink に見せる `columns` は settled width、`rows` は resize 後も過去最大値を保つ high-water mark とし、縮小した瞬間に Ink の fullscreen-clear fallback が scrollback を消す判定へ入ることを避ける。
- **出力:** resize 時に端末全体を clear しない。stream の `<Static>` activity history は remount / replay / re-emit せず、下部の live frame だけを更新する。
- **監視:** `tui-terminal-size.test.ts`、`issue-session-tui.test.tsx`、`issue-session-tui-stream.test.tsx` を Ink / React / `ink-testing-library` 更新時の自動ゲートとする。clear sequence の不出力、controller 経由の frame 整合、pane 60×12、stream history 非重複を確認する。

## Consequences

### 良い点

- resize burst の途中で Ink と TUI が異なるサイズを使うことを避け、live frame の再配置を settled size に揃えられる。
- 端末全体の clear と Static history の replay を避け、native scrollback を保つ。
- upstream の仕様変更を、既存の clear / frame-integrity テストで早期に検知できる。

### 制約・リスク

- 100 ms の settle により、resize 中の表示更新は遅延する。
- Ink に渡す `rows` は縮小後も過去最大値のため、TUI の実サイズと Ink の viewport 値は意図的に異なる。proxy の `stdout` event / property 契約は Ink の実装変更に敏感である。
- stream の既追記 Static 行は端末幅変更時に再折り返しされない。極端に短い端末では本文が clip されることがある。

### 撤去条件

workaround の撤去はこの ADR の本文を変更して行わない。次をすべて満たす変更で新しい ADR を作成し、本 ADR を supersede する。

1. 幅縮小時の frame / clear 挙動を含む upstream 修正が release され、対象バージョンと変更内容を確認できる。
2. 対象バージョンで [Ink / React アップグレード回帰手順](../tui-ink-upgrade.md)の 3 系統のテストが成功する。
3. [TUI 端末互換性マトリクス](../tui-terminal-compatibility.md) の resize / scrollback 手順を実端末で実行し、ghost line、frame 重複、意図しない clear sequence がないことを確認する。
4. `tui-terminal-size.ts`、pane / stream の実装、テスト、利用者向け文書を同じ変更で更新する。
