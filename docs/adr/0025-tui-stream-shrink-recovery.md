# ADR 0025: stream の縮小時 scrollback 再同期

- Status: accepted
- Date: 2026-09-25

## Context

ADR 0024 の shrink coalesce と Ink の columns high-water mark は、中間幅の live frame 再描画と Ink の幅縮小 clear を抑える。しかし、normal screen buffer 上で動く stream は、端末や tmux が既存の live frame を物理的に再折り返した後に Ink の論理行数で消去するため、過去世代の枠行・破断片が scrollback に残り、縮小のたびに増えることがある。

stream の activity history は Ink Static と native scrollback を正本としてきた。Static は通常 append-only で、既出 prefix の replay は行わない。一方、端末の scrollback に既に入った物理行を一般 TTY から範囲指定で回収する API はない。限定的な cursor / erase だけでは、既出 fragment の線形増加を安全に止められない。

Issue #346 の第一受入目標は、同一セッションの既出 fragment を必ず回収することではなく、以後の columns shrink で fragment が線形増加しないことである。オペレータは、native scrollback と stream を維持したまま、全体 clear と保持済み activity の書き直しを候補として許可した。

## Decision

通常の TTY 出力は ADR 0015 / 0024 の native scrollback、alternateScreen: false、Static append-only、shrink coalesce、Ink columns high-water mark を維持する。

stream layout では、settled な columns shrink を一つの resize transaction として扱い、Ink が新しい幅で live frame を描く前に次の順序で再同期する。

1. Ink の論理フレームを clear して内部の行数状態をリセットする。
2. CSI 3 J、CSI 2 J、CSI H を一度出力し、primary screen と scrollback を消去してカーソルを先頭へ戻す。
3. view model が保持する activity history の replay generation を進め、Static を remount する。stream の activityLogWindowSize は null なので、保持済み activity を新しい幅で一度だけ書き直す。
4. settled size の live frame を一度描く。250ms の shrink coalesce、grow、height change の通常経路は維持する。

この reset は columns が減少した settled event にだけ適用する。pane layout は bounded activity window を使い、古い履歴を全件 replay できないため、この ADR の全体 clear recovery を適用しない。pane は ADR 0024 の high-water / coalesce 経路を継続する。

この判断は、端末の物理行を推測して Static 履歴を誤消去するより、scrollback を一度再生成して activity の意味上の履歴を保持する方が Issue #346 の第一目標に安全だと判断したものである。native scrollback の物理的な連続性は shrink recovery のたびに失われるが、通常時のログ閲覧 UX と alternate screen を維持する。

### 検討した案

| 案 | 判断 | 理由 |
|---|---|---|
| pane 先頭 anchor からの限定 cleanup | 不採用 | 一般 TTY では物理行数と anchor の妥当性を保証できず、Static history を誤って消すリスクがある。 |
| Ink の log.clear() だけを追加 | 不採用 | 論理行数しか消せず、端末/tmux の reflow 後に scrollback へ入った余分な物理行を回収できない。 |
| 全体 clear + activity replay | 採用 | stream は全 activity を view model に保持しており、fragment の線形増加をリセットできる。scrollback の連続性を失う UX を明示的に受け入れる。 |
| alternate screen / bounded renderer への移行 | 保留 | #326 / #327 級の構造変更であり、第一目標に必要な範囲を超える。 |
| Ink upstream への依存 | 保留 | Ink #907 の解決を現行バージョンの受入根拠にはできない。 |

### 既存 ADR との関係

ADR 0015 の Static append-only と ADR 0022 / 0024 の resize 時 clear 禁止には、stream の settled shrink recovery に限った明示的な例外を設ける。通常の activity append、grow、height change、pane layout では replay / 全体 clear を行わない。alternateScreen: false と native scrollback を使う基本モデルは変更しない。

## Consequences

### 良い点

- settled shrink ごとに terminal と Ink の論理フレームを同じ世代へ戻し、過去 live frame fragment の線形増加を止める経路を持てる。
- Static activity の内容は view model から再出力されるため、stream の意味上の活動履歴は維持される。
- 中間 shrink は従来どおり coalesce され、grow / height change と pane の既存 UX を変更しない。
- clear sequence と replay generation が自動テストで観測できる。

### 悪い点・リスク

- shrink recovery は terminal scrollback を消去するため、利用者が保持していた native scrollback の位置・連続性・端末側のコピー対象を失う。ログ内容は再出力されるが、過去世代の物理表示は保存しない。
- CSI 3 J の扱いは terminal / tmux に依存する。対象環境で clear が効かない、または意図しない表示になる場合は手動検証を fail として記録する。
- stream は full activity history をメモリに保持する。大量ログでは replay 時間・出力量が増える。
- recovery は既に壊れた同一 session を復元する機構ではなく、settled shrink 時に新しい表示世代を作る機構である。
- auto test は terminal/tmux の physical reflow を証明しない。iTerm2 + tmux の手動確認をマージ前の今回だけ行い、以後は必要な変更時だけ提案する。

## Verification and follow-up

- 自動: tui resize recovery、Static replay generation、stream の fake TTY capture、既存の coalesce / high-water / pane / grow / height 回帰を実行する。
- 手動: docs/tui-terminal-compatibility.md の #346 手順で iTerm2 + tmux の stream / pane を別々に確認する。stream は各 settled shrink で意図した reset 一回、Static marker の保持、旧 Operator input / Workers fragment の非累積を確認し、pane は reset sequence を出さないことを確認する。
- 手動 fail、CSI 非対応、または activity replay が失敗した場合は Issue #346 に環境・出力・再現条件を記録し、A 相当の制限または #326 / #327 の構造変更を conductor / オペレータへ返す。
