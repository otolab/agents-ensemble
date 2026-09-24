# TUI 端末互換性マトリクス

> **正本:** TUI の端末・layout ごとの確認状況と、実端末確認結果を更新する手順。
> TUI の現在の挙動と利用者向け制限は [operator-input.md](operator-input.md) を参照する。

この表は、`ensemble issue` の TTY TUI（`pane` / `stream`）について、確認できた端末環境と未確認の組み合わせを区別して記録する。未確認の組み合わせを、他の環境の結果から推測して確認済みにはしない。

## 状態と確認項目

| 記号 | 状態 |
|------|------|
| ✅ | 確認済み。記載した環境・手順の範囲で結果を確認済み |
| ⬜ | 未確認。実端末での確認結果がまだない |
| ⚠️ | 既知制限。確認結果ではなく、現在の仕様または既知の問題として開示している |

| 確認項目 | 判定対象 |
|----------|----------|
| resize | 端末サイズを変更したときの live frame、枠、入力欄、および resize 後の再レイアウト |
| IME | 実 IME composition 中の入力と物理カーソル位置。自動テストだけのカーソル計算検証は、実 IME の確認済みとは扱わない |
| scrollback | resize 後に broken frame や意図しない clear sequence が scrollback に残らないこと。keyboard detached 経路外の viewport 保持は既知制限として別表に記載する |

## 端末 × layout マトリクス

| 端末・状態 | layout | resize | IME | scrollback |
|------------|--------|--------|-----|------------|
| macOS + `script` 擬似 TTY（`TERM=tmux-256color`） | pane | ✅ `120×32 → 60×32 → 60×12 → 120×32`。broken frame なし | ⬜ 実 IME composition は未確認（自動テストのカーソル整合のみ） | ✅ broken frame、`ESC[2J`、`ESC[3J` なし |
| macOS + `script` 擬似 TTY（`TERM=tmux-256color`） | stream | ✅ 同じ resize 手順で確認 | ⬜ 実 IME composition は未確認（自動テストのカーソル整合のみ） | ✅ clear sequence なし。代表的な Static 行の重複出力なし |
| iTerm2 | pane | ⬜ #322 の実端末確認待ち | ⬜ 実 IME composition 未確認 | ⬜ native scrollback と resize の組み合わせ未確認 |
| iTerm2 | stream | ⬜ #322 の実端末確認待ち | ⬜ 実 IME composition 未確認 | ⬜ native scrollback と Static/live frame の組み合わせ未確認 |
| VS Code integrated terminal | pane | ⬜ #322 の実端末確認待ち | ⬜ 実 IME composition 未確認 | ⬜ integrated terminal の scrollback と resize 未確認 |
| VS Code integrated terminal | stream | ⬜ #322 の実端末確認待ち | ⬜ 実 IME composition 未確認 | ⬜ integrated terminal の scrollback と Static/live frame 未確認 |
| tmux copy mode 中 | pane | ⬜ copy mode 中の resize 未確認 | ⬜ 実 IME composition 未確認 | ⬜ copy mode 中の scrollback と live frame 更新未確認 |
| tmux copy mode 中 | stream | ⬜ copy mode 中の resize 未確認 | ⬜ 実 IME composition 未確認 | ⬜ copy mode 中の scrollback と Static/live frame 更新未確認 |

`TERM=tmux-256color` は #318 の `script` 擬似 TTY の設定値であり、tmux の copy mode を実端末で確認したことを意味しない。iTerm2、VS Code integrated terminal、tmux copy mode、実 IME composition は [Issue #322](https://github.com/otolab/agents-ensemble/issues/322) のスコープで、現時点では未確認である。

確認済みの根拠は、[PR #318](https://github.com/otolab/agents-ensemble/pull/318) の Test plan と [Issue #298 のフォロー整理コメント](https://github.com/otolab/agents-ensemble/issues/298#issuecomment-5806087165) に記録された macOS + `script` 擬似 TTY の確認である。これは実端末全般の互換性を保証するものではない。

## 既知制限

| 状態 | layout / 確認項目 | 内容 | 参照 |
|------|------------------|------|------|
| ⚠️ | stream / scrollback | 端末幅を変更しても、既に `<Static>` として追記された行は再折り返しされない | [#319](https://github.com/otolab/agents-ensemble/issues/319) |
| ⚠️ | stream / scrollback | 入力欄が空の `PgUp`、または入力中の `Ctrl+PgUp` で detached を宣言すると新着を保留し、`End` / `Ctrl+End` で追記して follow に戻る。mouse-only の native scrollback は terminal host から viewport state が通知されないため自動検出できない | [#320](https://github.com/otolab/agents-ensemble/issues/320) |
| ⚠️ | pane / scrollback | `PgUp` / `Ctrl+PgUp` でアプリ内 windowing を detached にすると、新着 display line 数を offset に反映して同じログ行を維持する。端末の mouse-only native scrollback はアプリ内 windowing の操作対象外 | [#320](https://github.com/otolab/agents-ensemble/issues/320) |
| ⚠️ | pane / stream / resize | 極端に短い端末では、枠・タイトル・入力行を維持してもログ、Worker 状態、open question 本文が clip されることがある。60×12 の no-question モードでは live frame の主要な枠と入力行を維持する | [#321](https://github.com/otolab/agents-ensemble/issues/321) |

これらは未確認端末を確認済みとする理由にはならない。実端末で同じ制限以外の問題が見つかった場合は、修正 Issue を起票し、該当セルを ⚠️ と修正 Issue へのリンクに更新する。

## #322 の確認結果を反映する手順

実端末の新規検証はこの Issue のスコープではなく、[Issue #322](https://github.com/otolab/agents-ensemble/issues/322) で行う。#322 の Test plan を実施したら、次の手順でこの表を更新する。

1. **環境を固定する。** iTerm2、VS Code integrated terminal、tmux copy mode、および実 IME composition を対象に、`pane` と `stream` の両方を確認する。端末名・OS・端末サイズ・`TERM`・tmux の有無を記録する。
2. **resize を同じ順序で実行する。** 初期サイズを `120×32` とし、少なくとも `60×32`、`60×12` を経由して `120×32` に戻す。幅だけ・高さだけ・両方の変更を分けて、live frame の枠、入力欄、IME カーソル位置を確認する。
3. **scrollback と IME を確認する。** resize 前後の scrollback に broken frame、`ESC[2J`、`ESC[3J`、Static 行の重複がないかを記録する。scrollback 閲覧中の新着ログ、tmux copy mode、実 IME composition 中の入力とカーソルも、実施したかどうかを明記する。
4. **該当セルだけを更新する。** 手順と結果が揃ったセルを ✅ にし、未実施のセルは ⬜ のまま残す。既知制限に該当した場合は ⚠️ とし、#319〜#321 または新しい修正 Issue へリンクする。確認日と環境差分が重要な場合はセルの注記か Issue / PR に残す。
5. **再実行のタイミングを記録する。** TUI の変更後、リリース前、または TUI の resize / IME / scrollback に関する regression が報告されたときに、同じ Test plan を再実行する。結果は Issue / PR に記録し、この表の状態と参照先を同時に更新する。

## 参照

- [Issue #298 フォロー整理](https://github.com/otolab/agents-ensemble/issues/298#issuecomment-5806087165) — B+C+D、未検証環境、既知制限
- [PR #318](https://github.com/otolab/agents-ensemble/pull/318) — resize の Test plan と確認済み環境
- [Issue #322](https://github.com/otolab/agents-ensemble/issues/322) — 実端末確認の作業単位
- [ADR 0015](adr/0015-cli-tui-library.md) — #298 の resize / scrollback 保全方針
- [tui-ink-upgrade.md](tui-ink-upgrade.md) — Ink / React 更新時の自動回帰ゲート
- [operator-input.md](operator-input.md) — TUI の現在の挙動と制限
