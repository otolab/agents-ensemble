# Ink / React アップグレード回帰手順

> **正本:** Ink を含む TUI 依存を更新するときの resize / clear / frame-integrity 回帰ゲート。
> TUI の現行挙動と端末ごとの確認状況は [operator-input.md](operator-input.md) と [tui-terminal-compatibility.md](tui-terminal-compatibility.md) を参照する。

## いつ実行するか

次のいずれかに該当する変更を入れるとき、依存更新後の最初の確認として実行する。

- `packages/cli/package.json` または lockfile の `ink`、`react`、`ink-testing-library` のバージョンを更新するとき（patch / minor / major を問わない）
- `createTuiResizeController`、`tui-terminal-size.ts`、`create-issue-session-tui-host.tsx`、pane / stream の resize・layout・stdout 配線を変更するとき
- Ink の renderer、`clearTerminal`、`stdout.resize`、terminal size の扱いに影響する変更を取り込むとき
- resize、scrollback、frame の崩れが報告され、回帰を切り分けるとき

現行の基準バージョンは次のとおりである。依存を更新した場合は、この表を更新してからゲートを実行する。

| 依存 | 現行基準 |
|------|----------|
| `ink` | `7.1.1` |
| `react` | `19.2.0` |
| `ink-testing-library` | `4.0.0` |
| resize settle | `100ms` (`TUI_RESIZE_SETTLE_MS`); columns shrink coalesce `250ms` after the last shrink event (`TUI_RESIZE_SHRINK_COALESCE_MS`). TUI uses the settled physical columns; Ink's stdout proxy keeps a shrink-time columns high-water mark and raises it on grow. |

## 実行コマンド

まず resize 監視に関係するテストだけを実行する。

```bash
pnpm --filter @agents-ensemble/cli exec vitest run \
  src/tui/tui-terminal-size.test.ts \
  src/tui/issue-session-tui.test.tsx \
  src/tui/issue-session-tui-stream.test.tsx
```

依存更新や型・ビルド経路にも変更がある場合は、CLI の全 unit test も実行する。

```bash
pnpm --filter @agents-ensemble/cli test:run
```

対象テストまたは全 CLI test が失敗した場合、依存更新を合格扱いにせず、失敗したケースと出力差分を記録する。テストが通っても実端末の互換性を確認済みとは扱わない。実端末の手順は [TUI 端末互換性マトリクス](tui-terminal-compatibility.md) を参照する。

## 回帰ゲートと既存テストの対応

| テスト | 確認する契約 | 合格条件 |
|--------|--------------|----------|
| [`tui-terminal-size.test.ts`](../packages/cli/src/tui/tui-terminal-size.test.ts) | 通常の resize は 100ms の settle、columns の連続縮小は最後の縮小イベントから 250ms の quiet-period にまとめる。`createTuiResizeController` 経由で TUI は settled 実幅を使い、Ink は columns / rows の high-water mark proxy を使う | 通常の変更は 100ms 後に 1 回、縮小中の中間幅は通知されず、最後の縮小イベントから 250ms 後に最終実幅で 1 回だけ通知される。縮小時の Ink proxy columns は high-water mark を下回らず、拡大時は更新される。実 Ink frame の resize 後出力に pane の主要な枠・入力行があり、`ESC[2J` / `ESC[3J` が出力されない |
| [`issue-session-tui.test.tsx`](../packages/cli/src/tui/issue-session-tui.test.tsx) | pane layout の短い端末への resize。60×12 では Ink に渡す live frame を 11 行として、各 pane の frame を保つ | 60×12 resize 後に 11 行、各行の幅が 60 以下、Workers / Orchestration / Operator input の上下枠と title が揃い、`operator>` が表示される |
| [`issue-session-tui-stream.test.tsx`](../packages/cli/src/tui/issue-session-tui-stream.test.tsx) | stream の既存 `<Static>` activity history と resize 後の live frame の分離 | resize 後も resize 前の Static 行が 1 回だけ残り、再 replay / duplicate されず、live frame の行幅が変更後の端末幅以下になる |

この 3 系統が、Ink の clear 判定、stdout proxy、pane / stream の frame integrity を監視する自動ゲートである。特に `tui-terminal-size.test.ts` の実 Ink テストは、clear sequence の再導入と controller 経由の frame 不整合を同時に検出する。

## upstream 追跡と workaround の撤去条件

[Ink #907](https://github.com/vadimdemedes/ink/issues/907) は幅縮小時の ghost line を扱うが、現時点では `Closed as not planned` である。[Ink #994](https://github.com/vadimdemedes/ink/pull/994) のように clear / scrollback を変更する upstream 更新も、#907 の wrap 行数不一致を直接解決したとは限らない。master の未リリース挙動だけを根拠に workaround を外してはならない。

`createTuiResizeController` の settle + high-water mark proxy を撤去するには、次をすべて満たす必要がある。

1. 幅縮小時の frame / clear 挙動を含む upstream 修正が release され、対象バージョンと変更内容を確認できる。
2. その候補バージョンでこの文書の 3 系統のテストを実行し、全件成功する。
3. [TUI 端末互換性マトリクス](tui-terminal-compatibility.md) の resize / scrollback 手順を実端末で実行し、ghost line、frame 重複、意図しない clear sequence がないことを確認する。
4. [ADR 0024](adr/0024-tui-shrink-coalesce.md) の shrink coalesce 撤去条件を満たし、実装・テスト・利用者向け文書を同じ変更で更新する。

upstream の状況、候補バージョン、未検証の端末や手順は Issue / PR に記録する。#322 の実端末確認そのものはこの Issue のスコープではない。
