# TUI scrollback 閲覧検出と detached state

> **正本:** TUI が terminal native scrollback の閲覧状態を検出できるか、検出できない場合にどの境界で detached/follow を扱うかという設計・互換性上の制約。
> 利用者向けの現在の挙動は [operator-input.md](operator-input.md)、実端末ごとの確認状況は [tui-terminal-compatibility.md](tui-terminal-compatibility.md)、作業状態と受け入れ条件は [Issue #320](https://github.com/otolab/agents-ensemble/issues/320) を参照する。

## 問題定義

Issue #320 の対象は、`ENSEMBLE_TUI_LAYOUT=stream` で terminal scrollback を上へ閲覧している間に activity log が `<Static>` へ追記されると、端末の viewport が末尾へ戻ることがある問題である。`#318` で扱った resize 起因の broken frame / scrollback clear とは別の問題であり、`#319` の既追記行の再折り返しとも別である。

この文書で **C** を次のように固定する。

> CLI の TTY/PTY プロセスが「利用者は native scrollback を上へ閲覧中である」と検出し、自動的に detached 相当へ入ること。

「検出できる」とは、単に過去の文字列を取得できることではなく、少なくとも follow（末尾）と detached（末尾以外）の区別、できれば現在の viewport の位置を得られることを指す。実装経路は次の tier に分ける。

| tier | 定義 | 例 |
|------|------|-----|
| **(a) TTY native** | CLI が標準または端末固有の escape sequence を TTY へ送り、viewport state を応答で得る | VT/xterm の DSR、端末固有 query |
| **(b) subprocess poll** | CLI と同じ pane/session 内から multiplexer の CLI を subprocess として呼び、host state を定期取得する | tmux `display-message` |
| **(c) external sidecar** | terminal host の API/RPC/extension を別プロセスが監視し、CLI へ IPC する | iTerm2 Python API、terminal UI extension |

## 表示モデルの前提

### `pane`

`pane` は Orchestration の活動ログをアプリ内の bounded window として描画する。`activity-log.ts` の `linesFromBottom=0` が末尾追従で、PgUp/PgDn/Home/End がこの state を操作する。detached 中に新着があった場合は、新着 display line 数を `linesFromBottom` に加えて次の最大 offset で clamp するため、wrapped line・separator・bounded window の範囲で同じログ行を維持する。`End` は従来どおり 0 に戻して最新へ追従する。


### `stream`

`stream` は `activityLogWindowSize: null` で活動ログ全体を保持し、`issue-session-tui-stream.tsx` の `<Static>` で上へ append する。入力欄が空の `PgUp`、または入力中の `Ctrl+PgUp` は `stream-scrollback.ts` の detached event を reducer に渡す。detached 中は committed prefix だけを Static に渡し、新着 suffix は pending として保持する。live UI に pending 件数を表示し、`End` / `Ctrl+End` で suffix を順序どおり一度だけ追加して follow に戻る。下部には live UI を描画し、`alternateScreen: false` の Normal Screen Buffer と terminal native scrollback を過去ログの正本にする。既に Static へ渡した prefix は再送・remount・replay しない。

従って pane と stream の違いは次の通りである。

| | scroll の正本 | 新着時にアプリが知っている state | C の必要性 |
|---|---|---|---|
| `pane` | アプリ内 `linesFromBottom` | detached/follow と新着 display line 数を反映した表示 offset | C なしで state と marker を維持できる |
| `stream` | terminal native scrollback | keyboard detached、committed prefix、pending suffix、follow/flush | mouse/scrollbar 経路を自動保護するには C が必要だが、共通 TTY では取得できない。将来 adapter は同じ detached event 境界へ注入する |

## 選択肢と副作用

### 選択肢一覧

| 選択肢 | 概要 | 実現性 | 受け入れ条件への充足度 |
|--------|------|--------|------------------------|
| **A: follow/detached** | PgUp / Ctrl+PgUp をアプリが受け取ったら detached に入り、新着を保留。End で suffix を flush して follow に戻る | 中〜高。端末 viewport の検出に依存せず、Static の committed prefix と pending suffix を分ける必要がある | 高（keyboard 経路）。mouse-only native scroll は対象外 |
| **B: 新着インジケータ** | `N 件の新着 · End で最新へ` を live UI に表示 | 中。件数と復帰案内は実装しやすい | 単独では低〜中。tail jump を止めず、A と組み合わせると明示的復帰を満たす |
| **C: 任意端末の native viewport 検出** | terminal host の viewport を query して follow/detached を自動判定 | 低。共通 TTY query がなく、端末固有 API に分裂 | 対応端末だけなら高いが、全端末の主ユースケース保証にはならない |
| **C': tmux adapter** | tmux の `pane_in_mode` と `scroll_position` を poll し、検出時だけ A+B を自動開始 | 中。tmux 3.6a で数値取得を実証済み | tmux copy mode 経路では高い。tmux 外・mouse off の native scrollback は対象外 |
| **D: 明示的復帰のみ** | End 等を案内し、末尾へ戻る操作を利用者に委ねる | 高。最小変更 | 最低限。位置を保持せず tail jump も防がない |
| **E: stream を pane 型 / bounded window へ寄せる** | terminal scrollback を使わず、アプリ内 offset で履歴を描画 | 技術的には高いが #327 級 | 高いが、#257 の Static/native scrollback 正本と履歴 UX を変更する |
| **F: alternate screen opt-in** | live UI を alternate screen に分離する | 中。Ink option 以外に履歴・終了後表示の再設計が必要 | #257 の方針とは不整合。#326 の別判断に委ねる |

### 副作用・トレードオフ

| 選択肢 | UX 変化 | #257 stream 設計との整合 | `alternateScreen` | Static append-only | メモリ | 端末互換 | テスト容易性 | 残る制限 |
|--------|---------|---------------------------|------------------|--------------------|--------|----------|--------------|----------|
| **A** | 明示的に遡るとその場に留まり、End でまとめて最新へ戻る | 整合。committed prefix は native scrollback | `false` 維持 | 整合。既存 prefix を再送しない | pending の一時保持。二重保持を避ける index 設計が必要 | keyboard は比較的安定。mouse-only は不可 | reducer/component test がしやすい。実端末 smoke は必要 | live frame 更新、mouse-only、端末固有差分 |
| **B** | 新着数と復帰方法が分かる | 整合だが原因は残る | `false` 維持 | 整合 | 小 | viewport を検出しない端末では意味が弱い | 件数表示は容易 | 位置維持なし |
| **C** | 対応端末では自然な自動 detached | 端末拡張への依存が増す | `false` 維持可能 | query 応答待ちと append の race がある | 小 | 低。未対応端末は無検出 | 端末固有の実機組合せが必要 | query がない端末、権限、stale state |
| **C'** | tmux copy mode の mouse/keyboard を自動で detached 扱い | Static と両立。tmux に限定した補助層 | `false` 維持 | committed/pending を A+B に任せる | poll state は小。pending は A+B と同じ | tmux 内のみ。socket、nested、mouse off に穴 | fake detector + tmux smoke の二層にできる | subprocess latency、mode 解釈、tmux 外 |
| **D** | 利用者が End で復帰 | 整合 | `false` 維持 | 整合 | 追加なし | End は比較的広いが、端末 viewport の保証ではない | 容易 | tail jump を防がない |
| **E** | アプリ内スクロールへ変化。端末の検索/コピーとの UX が変わる | 不整合。#257 の正本を変更 | `false` でも可能 | Static とは別契約 | bounded 化可能 | 描画は高互換、terminal UX は変わる | offset の純粋関数は容易 | #327 の履歴・rewrap 設計が必要 |
| **F** | live UI 中は通常 scrollback を直接見ない | 不整合 | opt-in `true` | native scrollback 正本でなくなる | transcript の別保持が必要 | alternate screen の端末差 | mode 切替・終了統合が必要 | #326 の履歴 export/説明 |

`alternateScreen: false` と Static append-only を維持する限り、A+B と C' は同じ committed prefix を再描画せずに両立できる。C' が返すのは「tmux の mode/position が変わった」という detector event だけで、pending の保持・End flush は A+B の state machine に集約するのが安全である。

## 端末別 C 検出可否マトリクス

| 端末 / 経路 | tier | CLI 単体の判定 | 検出手段 | 根拠 | 制限 |
|--------------|------|----------------|----------|------|------|
| tmux 3.6a | (b) subprocess poll | **可能**（tmux pane 内） | `display-message` の `pane_in_mode`, `scroll_position`, `pane_mode` | [tmux(1) formats](https://man7.org/linux/man-pages/man1/tmux.1.html) と下記実証 | tmux copy mode の状態であり、外側 terminal の native scrollback ではない |
| iTerm2 | (a) 不可、(c) **可能** | TTY escape だけでは不可 | Python API `SessionLineInfo.first_visible_line_number` | [iTerm2 Python API Session](https://iterm2.com/python-api/session.html) | Python API の有効化、Unix socket、cookie/Automation permission、RPC sidecar が必要 |
| xterm / 標準 VT | (a) 不可 | 不可 | DSR/CPR は cursor row/column のみ | [xterm control sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html) | proprietary protocol を端末別に追加しても共通契約にならない |
| VS Code integrated terminal | CLI は不可、host 側 (c) は理論上可能 | 不可 | 内部 xterm.js の `buffer.active.viewportY` / `onScroll` | [xterm.js IBuffer](https://xtermjs.org/docs/api/terminal/interfaces/ibuffer/)、[Terminal API](https://code.visualstudio.com/api/references/vscode-api#Terminal) | VS Code の通常 extension API は既存 terminal の xterm instance/viewport を公開しない。host extension は別 scope |
| Windows Terminal / ConPTY | CLI は不可 | 不可 | ConPTY の UTF-8 stream と VT sequence。host UI が viewport を所有 | [Pseudoconsoles](https://learn.microsoft.com/en-us/windows/console/pseudoconsoles)、[VT sequences](https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences) | classic console の screen-buffer window API と Windows Terminal の terminal-owned scrollback は別物。既存 UI の公開 callback は未確認 |
| kitty | CLI は不可、sidecar (c) は不完全 | 直接の位置取得は不可 | remote control `get-text` の `screen`/`all`、`scroll-window` | [kitty remote-control protocol](https://sw.kovidgoyal.net/kitty/rc_protocol/) | viewport offset field がなく、内容比較による推定は不安定。remote control の許可/認証が必要 |
| WezTerm | CLI は不可、sidecar (c) は不完全 | 直接の位置取得は不可 | `wezterm cli get-text` の画面/scrollback 範囲 | [wezterm cli get-text](https://wezterm.org/cli/cli/get-text.html) | current viewport offset の API ではなく、内容比較・mux server・poll latency が残る |

ここでの「不可」は scrollback を表示できないという意味ではない。CLI と terminal host の標準 TTY/PTY channel に、利用者の viewport state が返らないという意味である。

## tmux 実証

### 環境と手順

2026-09-24、macOS 15.7.9 / Darwin 24.6.0 / arm64、`tmux 3.6a` で、default server と分離した socket label `issue320-research` の session `issue320-c`（80×20）を使用した。pane には `history-000..119` と追加出力を流した。

基本 query は次の通り。

```sh
tmux display-message -p -t issue320-c:0.0 \
  '#{pane_in_mode} #{scroll_position} #{pane_mode}'
```

観測値は以下である。

| 操作 | 観測値 |
|------|--------|
| copy mode 外 | `0  `（position/mode は空欄） |
| `tmux copy-mode` 直後 | `1 0 copy-mode` |
| `send-keys -X scroll-up` を 6 回 | `1 6 copy-mode` |
| copy mode 中に追加出力。追加前後で query | `1 1 copy-mode` → `1 1 copy-mode` |
| mouse on、copy mode 外で SGR wheel-up を 3 event | `0  ` → `1 10 copy-mode` |
| copy mode 中で SGR wheel-up を 3 event | `1 10 copy-mode` → `1 15 copy-mode` |

mouse は `expect` で attach した実 PTY client へ SGR wheel event（wheel-up button 64）を送り、tmux client に処理させた。`tmux send-keys -M` の直接呼び出しは `no mouse target` となった。`-M` は現在の mouse binding event の pass-through であり、任意の mouse event を CLI から生成するものではない。

pane 内 shell から同じ `display-message` を実行すると通常時に `0` が返った。pane 内 background process を poll させながら copy mode に遷移すると、poll log は `1 0 copy-mode` の後 `1 1 copy-mode` を返した。つまり subprocess poll は pane 内から成立する。ただし copy mode 中に shell の foreground input は copy mode に消費されるため、observer の出力先は pane 画面ではなく log/IPC とする必要がある。

copy mode 中に `live-170..189` を追加する操作では、追加前後の `scroll_position` が `1` のまま変わらなかった。tmux の copy mode state と新着出力の扱いは、端末 native scrollback を直接監視する stream より観測可能な境界を持つ。

### poll コストと失敗時

macOS 上で同じ `display-message` subprocess を出力破棄して計測した一例は次の通りである。

```text
100 polls:  real 2.17s  (約 21.7ms/poll)
1000 polls: real 7.22s  (約 7.2ms/poll)
```

これは host/server 状態を含む観測値で保証値ではないが、イベントごと・数十 Hz の subprocess 起動は無視できない。C' を採用する場合は 100–500ms 程度の poll interval、最大検出遅延、subprocess 数、CPU/電池を明示的にトレードオフにする。tmux server/socket がない、pane が消えた、format が空（copy mode 外）、nested/remote session で target を解決できない場合は fail-open して A+B の明示操作へ戻す。

`pane_in_mode=1` だけでは copy mode の bottom (`scroll_position=0`) や choose mode 等を含み得る。少なくとも `pane_in_mode=1`、`pane_mode`、`scroll_position` を組み合わせ、selection/choose mode を detached とみなすかは実装時に固定する必要がある。

## iTerm2 の sidecar 境界

iTerm2 の proprietary escape-code 一覧には device/version、color、title、user variable 等はあるが、scrollback viewport の current offset query はない。[iTerm2 proprietary escape codes](https://iterm2.com/documentation-escape-codes.html) も、非標準 code は tmux/screen で正しく動かない可能性があると注意している。よって **iTerm2 の CLI 単体 C は不可**である。

Python API には `Session.async_get_line_info()` と `SessionLineInfo.first_visible_line_number` があり、「現在 onscreen に表示される最初の行」「ユーザーの scroll で変化」と定義されている。これは C の必要情報を提供するが、TTY response ではなく、iTerm2 の API socket を読む sidecar tier (c) である。

最小 sidecar は「対象 session の discovery → `first_visible_line_number` の定期 RPC poll → CLI への IPC」となる。Python API は既定で無効で、設定で有効化した Unix domain socket、cookie、macOS Automation permission が必要である。[Python API Security](https://stage.iterm2.com/python-api-auth.html) によれば、外部 program が cookie を得る経路にも Automation permission が関係する。したがって iTerm2 対応を C' に含めるなら、session ID discovery、複数 split pane、RPC reconnect、権限 UI、iTerm2 内 tmux の二重 viewport を別途スコープ化する必要がある。

## 推奨方針と境界

現時点の共通基線は **A+B** とする。PgUp/Ctrl+PgUp は CLI が確実に受け取れるため、端末 query に依存せず detached 宣言、新着 pending、件数表示、End flush を実装できる。`alternateScreen: false`、#257 の Static append-only、native scrollback を維持できる。

C' は、A+B の state machine に detector event を注入する **将来の tmux-only adapter** としては実現性がある。ただし #320 の受け入れ条件を C' 対応端末だけで満たす扱いにしない。C' を追加する場合の境界は次の通りである。

1. `TMUX`/`TMUX_PANE` で対象を解決し、`pane_in_mode=1 && scroll_position>0` を detached 候補とする。
2. mode exit / bottom 復帰の扱いは明示的に定義し、`pane_mode` の文字列を `copy-mode` 固定と仮定しない。
3. poll 失敗、tmux 外、mouse off の外側 native scrollback は A+B の keyboard path へ fail-open する。
4. detector は pending/flush を直接所有せず、A+B の reducer/state machine に event を渡す。
5. fake detector の unit test と、tmux 3.6a 以上・mouse on/off・copy mode・新着出力中の PTY smoke を分ける。

iTerm2 sidecar は API の値だけなら有望だが、C' の初回 adapter に同梱しない。配布・権限・IPC・session lifecycle まで含むため、別 Issue の設計判断とする。kitty/WezTerm の text capture は viewport offset を返さず、内容比較の heuristic に留まるため、現時点の C' 候補から除外する。

## 残る制限

- terminal native scrollback の mouse/scrollbar 操作は、tmux の mouse on/copy mode 以外では CLI に通知されない。
- Static suffix の append と detector poll の間には race があり、query 応答の時点と実際の表示時点は一致しない。
- live frame の state 更新は Static を止めても発生し得る。端末ごとの smoke test が必要である。
- terminal 幅変更後に既追記 Static 行を再折り返ししない制限は #319 のまま残る。
- bounded history / stream の全面再設計は #327、alternate screen の方針変更は #326 のスコープである。
- 実端末の確認済み/未確認マトリクスは [tui-terminal-compatibility.md](tui-terminal-compatibility.md) を更新し、調査記録は Issue/PR に残す。

## 関連文書・Issue

- 利用者向け TUI 挙動: [operator-input.md](operator-input.md)
- 端末 × layout × resize / IME / scrollback の確認状況: [tui-terminal-compatibility.md](tui-terminal-compatibility.md)
- stream の設計判断: [ADR 0015](adr/0015-cli-tui-library.md)
- [Issue #320](https://github.com/otolab/agents-ensemble/issues/320) — scrollback 閲覧中の末尾復帰
- [Issue #257](https://github.com/otolab/agents-ensemble/issues/257) — stream layout / Static / native scrollback
- [Issue #318](https://github.com/otolab/agents-ensemble/issues/318) — resize 起因の broken frame
- [Issue #319](https://github.com/otolab/agents-ensemble/issues/319) — Static 行の再折り返し
- [Issue #326](https://github.com/otolab/agents-ensemble/issues/326) — alternate screen
- [Issue #327](https://github.com/otolab/agents-ensemble/issues/327) — stream 履歴戦略
