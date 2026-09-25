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
| macOS + `script` 擬似 TTY（`TERM=tmux-256color`） | stream | ⬜ #346 の settled shrink recovery 再確認待ち | ⬜ 実 IME composition は未確認（自動テストのカーソル整合のみ） | ⬜ recovery 後の Static 保持・fragment 非累積は未確認 |
| iTerm2 + tmux | pane | ⬜ #346 実装後の再確認待ち | ⬜ 実 IME composition 未確認 | ⬜ native scrollback と resize の再確認待ち |
| iTerm2 + tmux | stream | ⚠️ #340 オペレータ確認で幅拡大回帰・縮小時の崩れを検出。#346 recovery 実装後の再確認待ち | ⬜ 実 IME composition 未確認 | ⚠️ #340 オペレータ確認で縮小時に崩れて上に流れる症状。#346 recovery 実装後の再確認待ち |
| VS Code integrated terminal | pane | ⬜ #322 の実端末確認待ち | ⬜ 実 IME composition 未確認 | ⬜ integrated terminal の scrollback と resize 未確認 |
| VS Code integrated terminal | stream | ⬜ #322 の実端末確認待ち | ⬜ 実 IME composition 未確認 | ⬜ integrated terminal の scrollback と Static/live frame 未確認 |
| tmux copy mode 中 | pane | ⬜ copy mode 中の resize 未確認 | ⬜ 実 IME composition 未確認 | ⬜ copy mode 中の scrollback と live frame 更新未確認 |
| tmux copy mode 中 | stream | ⬜ copy mode 中の resize 未確認 | ⬜ 実 IME composition 未確認 | ⬜ copy mode 中の scrollback と Static/live frame 更新未確認 |

`TERM=tmux-256color` は #318 の `script` 擬似 TTY の設定値であり、tmux の copy mode を実端末で確認したことを意味しない。iTerm2 + tmux については [Issue #340](https://github.com/otolab/agents-ensemble/issues/340) のオペレータ確認で stream の fail が記録されており、#346 の recovery 実装後も再確認待ちである。stream の settled shrink では CSI 3J / CSI 2J が意図的に一度出力されるため、clear sequence 非出力という旧手順の判定はそのまま適用しない。VS Code integrated terminal、tmux copy mode、実 IME composition は [Issue #322](https://github.com/otolab/agents-ensemble/issues/322) のスコープで、現時点では未確認である。

確認済みの根拠は、[PR #318](https://github.com/otolab/agents-ensemble/pull/318) の Test plan と [Issue #298 のフォロー整理コメント](https://github.com/otolab/agents-ensemble/issues/298#issuecomment-5806087165) に記録された macOS + `script` 擬似 TTY の確認である。これは実端末全般の互換性を保証するものではない。

## 既知制限

| 状態 | layout / 確認項目 | 内容 | 参照 |
|------|------------------|------|------|
| ⚠️ | stream / scrollback | 通常の幅変更では既に `<Static>` として追記された行は再折り返しされない。#346 の settled columns shrink recovery では scrollback を reset して activity history を再出力する | [#319](https://github.com/otolab/agents-ensemble/issues/319)、[#346](https://github.com/otolab/agents-ensemble/issues/346) |
| ⚠️ | stream / scrollback | 入力欄が空の `PgUp`、または入力中の `Ctrl+PgUp` で detached を宣言すると新着を保留し、`End` / `Ctrl+End` で追記して follow に戻る。mouse-only の native scrollback は terminal host から viewport state が通知されないため自動検出できない | [#320](https://github.com/otolab/agents-ensemble/issues/320) |
| ⚠️ | pane / scrollback | `PgUp` / `Ctrl+PgUp` でアプリ内 windowing を detached にすると、新着 display line 数を offset に反映して同じログ行を維持する。端末の mouse-only native scrollback はアプリ内 windowing の操作対象外 | [#320](https://github.com/otolab/agents-ensemble/issues/320) |
| ⚠️ | pane / stream / resize | 極端に短い端末では、枠・タイトル・入力行を維持してもログ、Worker 状態、open question 本文が clip されることがある。60×12 の no-question モードでは live frame の主要な枠と入力行を維持する | [#321](https://github.com/otolab/agents-ensemble/issues/321) |

これらは未確認端末を確認済みとする理由にはならない。実端末で同じ制限以外の問題が見つかった場合は、修正 Issue を起票し、該当セルを ⚠️ と修正 Issue へのリンクに更新する。

## #322 の確認結果を反映する手順

実端末の新規検証はこの Issue のスコープではなく、[Issue #322](https://github.com/otolab/agents-ensemble/issues/322) で行う。#322 の Test plan を実施したら、次の手順でこの表を更新する。

1. **環境を固定する。** iTerm2、VS Code integrated terminal、tmux copy mode、および実 IME composition を対象に、`pane` と `stream` の両方を確認する。端末名・OS・端末サイズ・`TERM`・tmux の有無を記録する。
2. **resize を同じ順序で実行する。** 初期サイズを `120×32` とし、少なくとも `60×32`、`60×12` を経由して `120×32` に戻す。幅だけ・高さだけ・両方の変更を分けて、live frame の枠、入力欄、IME カーソル位置を確認する。
3. **scrollback と IME を確認する。** resize 前後の scrollback に broken frame、意図しない clear sequence、Static 行の重複がないかを記録する（stream の settled shrink recovery が出す CSI 3J / CSI 2J は意図した一回の reset として別に記録する）。scrollback 閲覧中の新着ログ、tmux copy mode、実 IME composition 中の入力とカーソルも、実施したかどうかを明記する。
4. **該当セルだけを更新する。** 手順と結果が揃ったセルを ✅ にし、未実施のセルは ⬜ のまま残す。既知制限に該当した場合は ⚠️ とし、#319〜#321 または新しい修正 Issue へリンクする。確認日と環境差分が重要な場合はセルの注記か Issue / PR に残す。
5. **再実行のタイミングを記録する。** TUI の変更後、リリース前、または TUI の resize / IME / scrollback に関する regression が報告されたときに、同じ Test plan を再実行する。結果は Issue / PR に記録し、この表の状態と参照先を同時に更新する。

## #340 iTerm2 + tmux の段階的縮小確認手順

この手順は #340 の shrink coalesce（columns 縮小時の中間 live frame 更新抑制）と columns high-water mark、および #346 の stream shrink recovery を実端末で再確認するためのものです。方針の正本は [ADR 0024](adr/0024-tui-shrink-coalesce.md) と [ADR 0025](adr/0025-tui-stream-shrink-recovery.md) です。stream は settled shrink ごとに意図した reset と activity replay を行うため、reset 前の native scrollback の連続性ではなく、Static marker の保持と旧 live frame fragment の非累積を判定します。結果が記録されるまで該当セルを pass には更新しません。

1. **環境を記録する。** macOS の iTerm2 で tmux セッションを開始し、iTerm2 / tmux / CLI のバージョン、`TERM`、対象 layout（`pane` または `stream`）を記録する。pane と stream は別々に実行する。
2. **resize 前の scrollback を作る。** TUI の live frame より前に識別できる活動ログを複数出し、scrollback に残った代表行を 1 回だけ確認できる状態にする。alternate screen を使わず、native scrollback が有効であることを確認する。
3. **幅を段階的に縮小する。** おおむね `120×32 → 110×32 → 100×32 → 90×32 → 80×32 → 70×32 → 60×32` の順で iTerm2 のウィンドウ幅を縮小する。連続ステップの間隔は 250ms 未満を目安にし、各ステップで pane / stream の live frame が中間幅ごとに上方向へ流れないことを観察する。最終幅に到達した後は、**最後の縮小イベントから** 250ms 以上待つ。
4. **高さ変更と拡大を分けて確認する。** `60×32 → 60×12` の高さ変更、`60×12 → 120×32` の幅拡大を個別に行い、live frame の枠・タイトル・入力欄が再配置されることを確認する。
5. **scrollback を確認する。** pane は resize 前の代表行が重複せず、broken frame / ghost line がなく、`ESC[2J` / `ESC[3J` が出ないことを確認する。stream は settled な columns shrink ごとに recovery の CSI 3J / CSI 2J を一度だけ確認し、activity marker が残り、旧 Operator input / Workers の枠行・破断片が縮小回数に比例して累積しないことを確認する。確認結果（成功・失敗・未確認項目）を Issue / PR に記録する。

TTY からはドラッグ終了イベントを取得できないため、250ms より長い停止を挟んだ後の縮小は別の coalesce 窓として扱われます。停止を含む操作でも問題が出た場合は、停止時間と幅の系列を記録し、新しい修正 Issue が必要か conductor に返します。

## #346 Phase 2b の手動判定

第一目標は、既出 fragment の同一 session 完全回収ではなく、以後の resize による枠ゴミ・破断片の線形増加を止めることです。stream は Static activity history を保持したまま settled shrink で scrollback を再生成します。次を stream / pane それぞれ clean session で確認し、実施環境（macOS、iTerm2、tmux、TERM、CLI version）と幅系列を Issue または PR に記録します。

- stream: `120×32 → 110×32 → 100×32 → 90×32 → 80×32 → 70×32 → 60×32` を段階縮小し、最後の縮小から 250ms 以上待つ。Static の `[observation]` marker が残り、各 recovery で reset が一回だけ出て、旧 `Operator input` / `Workers` の世代や断片が累積しないこと。
- stream: `60×32 → 60×12 → 120×32` の height shrink / grow と幅 grow を個別に実施し、live frame の枠・入力欄・Workers を確認する。
- pane: 同じ幅・高さ系列で full redraw sequence が出ず、既存の high-water / coalesce 回帰（枠・入力行・幅）を確認する。
- capture: 可能なら tmux pipe-pane 等で出力を保存する。自動 capture は sequence 回数・activity replay・既存 history の非重複を検証するが、terminal/tmux の物理 reflow 自体は証明しない。

## 参照

- [Issue #298 フォロー整理](https://github.com/otolab/agents-ensemble/issues/298#issuecomment-5806087165) — B+C+D、未検証環境、既知制限
- [PR #318](https://github.com/otolab/agents-ensemble/pull/318) — resize の Test plan と確認済み環境
- [Issue #322](https://github.com/otolab/agents-ensemble/issues/322) — 実端末確認の作業単位
- [ADR 0015](adr/0015-cli-tui-library.md) — #298 の resize / scrollback 保全方針
- [tui-ink-upgrade.md](tui-ink-upgrade.md) — Ink / React 更新時の自動回帰ゲート
- [operator-input.md](operator-input.md) — TUI の現在の挙動と制限
