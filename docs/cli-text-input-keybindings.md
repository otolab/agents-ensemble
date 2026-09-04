# CLI / TUI における標準ショートカットキー（Emacs 風）の実装

オペレータ入力欄や AI CLI プロンプトで期待される **Emacs 風ショートカット**（`Ctrl+a` 行頭、`Ctrl+e` 行末、`Ctrl+k` キル、`Ctrl+y` ヤンク等）が、**どの層で誰が実装するか**、および **リッチ TUI でどう組み込むか** をまとめる。

参考（外部調査メモ）:

- `Emacsキーバインドのサポート階層調査.md`
- `Implementation of Emacs Shortcuts in AI CLI Tools.md`

関連: [operator-input.md](operator-input.md)、[ADR 0015](adr/0015-cli-tui-library.md)、Issue #186（IME）

---

## 1. 結論（実装者向け）

Emacs 風ショートカットは **OS の共通機能ではない**。利用者が「どこでも効く」と感じるのは、各層が **同じデファクト標準を再実装** しているためである。

| 環境 | 誰が Emacs 風を実装するか |
|------|---------------------------|
| シェル 1 行プロンプト | GNU Readline / libedit / Zsh ZLE |
| macOS GUI（Safari textarea 等） | Cocoa Text System（`StandardKeyBinding.dict`） |
| リッチ TUI / AI CLI | **アプリ自身**（Raw モード + 内部テキストバッファ + キーマップ） |

**agents-ensemble** の TTY 経路（Ink + `react-ink-textarea` フォーク）は後者。シェルの Readline 設定（`~/.inputrc`）は **効かない**。

---

## 2. サポート階層（下から上）

```
[キーボード]
    ↓ バイト列 / エスケープシーケンス
[ターミナルエミュレータ]  … 意味解釈はしない。Ctrl+a → 0x01 を PTY へ
    ↓
[OS ターミナルドライバ (termios / Line Discipline)]
    … カノニカルモード: ^H 削除、^U 行頭まで削除、^C SIGINT など **削除系のみ**
    … Ctrl+a / Ctrl+e / 履歴 / キルリング は **提供しない**
    ↓
[ユーザー空間]
    … Readline / libedit / ZLE / prompt_toolkit / Ink / crossterm+textarea
    ↓
[アプリケーション UI]
```

### 2.1 カノニカルモード vs Raw モード

| モード | 入力の渡し方 | Emacs 風カーソル移動 |
|--------|--------------|----------------------|
| **カノニカル（Cooked）** | 改行まで行単位 | OS は不可。Readline 等が Raw に切り替えて自前実装 |
| **非カノニカル（Raw）** | 1 キーずつ即時 | アプリが `termios` で ICANON/ECHO を off にし、全キーを解釈 |

リッチ TUI（4 ペイン + 非同期 harness 更新 + マルチライン入力）は **Raw モードが前提**。Ink も `react-ink-textarea` も内部で stdin を Raw 扱いする。

### 2.2 ターミナルエミュレータの役割

- **やること**: 物理キー → ASCII 制御文字 or エスケープシーケンス（例: `Alt+f` → `ESC` + `f`）
- **やらないこと**: 「行頭へ移動」等の意味付け
- **macOS + iTerm2**: Option を Meta として使うには Profile → Keys で **Left/Right option key acts as: +Esc** が必要（デフォルトは特殊文字入力になり `Alt+b` / `Alt+f` が効かない）

---

## 3. デファクト標準の Emacs 風バインディング

Readline Emacs モードを事実上の共通仕様とみなす。

| キー | 意味 | Readline コマンド名（参考） |
|------|------|---------------------------|
| `Ctrl+a` | 行頭 | `beginning-of-line` |
| `Ctrl+e` | 行末 | `end-of-line` |
| `Ctrl+f` / `Ctrl+b` | 1 文字進む / 戻る | `forward-char` / `backward-char` |
| `Ctrl+d` | カーソル位置の 1 文字を削除 | `delete-char` |
| `Alt+f` / `Alt+b` | 1 単語進む / 戻る | `forward-word` / `backward-word` |
| `Ctrl+k` | カーソル〜行末をキル | `kill-line` |
| `Ctrl+u` | カーソル〜行頭をキル | `unix-line-discard` |
| `Ctrl+w` | 前の単語をキル | `unix-word-rubout` |
| `Ctrl+y` | ヤンク（直近キルを貼る） | `yank` |
| `Alt+y` | キルリングを循環 | `yank-pop` |
| `Ctrl+p` / `Ctrl+n` | 履歴 前 / 次 | `previous-history` / `next-history` |
| `Ctrl+r` | 履歴逆検索 | `reverse-search-history` |

**キルリング**: 削除した文字列をクリップボードとは別スタックに保持し `Ctrl+y` で復元。連続 `Ctrl+k` はエントリ結合（Emacs / macOS Cocoa Text System と同型）。

---

## 4. 各層での実装方式

### 4.1 シェル・1 行 REPL（Readline / libedit / ZLE）

| 実装 | 設定ファイル | 備考 |
|------|--------------|------|
| GNU Readline | `~/.inputrc` | デフォルト Emacs モード。`set editing-mode vi` で Vi 切替 |
| libedit | `~/.editrc` | `bind -e` / `bind -v` |
| Zsh ZLE | `~/.zshrc` の `bindkey` | Readline 非使用。Emacs モードは `bindkey -e` |

**agents-ensemble 非 TTY 経路**（`bindAsyncOperatorInput`）は Node `readline`。Emacs 風は **Node/OS 依存** で、TUI 入力欄とは別系統。

### 4.2 Python TUI（prompt_toolkit）

- Raw モード + 自前イベントループ
- デフォルト Emacs バインド内蔵
- `KeyBindings` で `@bindings.add('c-a')` 等を追加
- `vi_mode=True` で Vi 切替

### 4.3 Rust TUI（crossterm + tui-textarea 等）

1. `enable_raw_mode()` — termios で ICANON/ECHO off
2. `event::read()` — キーイベント取得
3. `KeyEvent { code, modifiers }` に正規化
4. ウィジェット API へディスパッチ（例: `move_cursor(Head)`, `delete_line_by_end()`）

Codex CLI は Node/Ink から Rust ネイティブ TUI へ移行した例（Raw モード・CI 耐性・描画制御）。

### 4.4 Node.js + React Ink（Claude Code 等）

1. `stdin.setRawMode(true)` または Ink 経由の Raw 化
2. `useInput` / `TextArea` がキーイベントをフック
3. React state（`value`, `cursorOffset`）更新
4. Ink reconciler が ANSI エスケープ（`\x1b[50D`, `\x1b[K` 等）で差分描画

**IME との衝突**: Raw + 1 バイト前提の入力処理は CJK コンポジションと相性が悪い（Claude Code / Ink TextInput で報告多数）。**物理カーソル同期**（Ink `useCursor`）が別途必要 — 本リポジトリは #186 / `react-ink-textarea` フォークで対応。

### 4.5 IDE 統合ターミナル（Cursor CLI 等）

- ホスト IDE（xterm.js）が **フォーカス時に一部キーを先取り**（`terminalFocus` コンテキスト）
- IDE ショートカットと Emacs 風が競合しうる（例: `Ctrl+k` vs AI プロンプト）
- 未登録キーのみ PTY → CLI プロセスへ透過

---

## 5. 実装パイプライン（TUI 共通）

Emacs 風を **自前実装** する場合の最小ループ:

```text
1. Raw モード化（termios / Ink / crossterm）
2. stdin からバイト列受信
3. キーパース
   - 0x01 → Ctrl+a
   - ESC + 文字 → Meta（Alt）— ESC 単体か Meta プレフィックスかは短タイムアウトで判定
4. 内部テキストバッファ + カーソル offset 更新
   - kill → キルリングへ push
   - yank → キルリングから pop
5. 画面更新（ANSI またはフルペイン再描画）
6. （CJK）IME 変換窓用に物理カーソル位置を OS へ通知 — Ink useCursor 等
```

### 5.1 実装方式の選択

| 方式 | 向くケース | agents-ensemble |
|------|------------|-----------------|
| **ライブラリに委譲** | マルチライン入力が主 | ◎ `react-ink-textarea`（フォーク）が Emacs 風を内蔵 |
| **薄いラッパー** | ライブラリ + IME 同期だけ自前 | 現状 `OperatorTextArea` + `cursorStart` |
| **フル自前** | 特殊レイアウト・キーマップ | 非推奨（二重実装・IME リスク） |
| **Readline 直呼び** | 1 行・同期 REPL のみ | 非 TTY 経路のみ |

### 5.2 テスト観点

- 単体: キー列 → バッファ / offset 変換の純関数
- Ink: `ink-testing-library` + `stdin.write`（[ink-test-keys.ts](../packages/cli/src/tui/ink-test-keys.ts)）
- IME: 自動テスト限界。**TTY + 日本語 IME 実機** をマージ前ゲートに（ADR 0015）

---

## 6. agents-ensemble の現状

| 経路 | 入力実装 | Emacs 風 |
|------|----------|----------|
| TTY + Ink TUI | `OperatorTextArea` → フォーク `react-ink-textarea`（`pnpm` patch でキルリング / Readline 整合） | **ライブラリ内蔵**。`Ctrl+a/e/f/b/d`（`Ctrl+d` はカーソル位置の 1 文字削除）、`Ctrl+k/u/w/y`、`Alt+b/f/y` をサポート。`Ctrl+p/n/r`（履歴）は **非対応**（プロンプト用途では不要） |
| TTY スクロール | `issue-session-tui.tsx` の `useInput` | `PgUp/PgDn` / `Home`/`End`（入力空時 or Ctrl 修飾）— **編集ショートカットとは別レイヤ**（競合なし） |
| 非 TTY | `readline` / `ENSEMBLE_OPERATOR_MESSAGE` | OS・Node readline 依存 |

**`useInput` と TextArea の関係**: 活動ログスクロール用 `useInput` は `Home`/`End`/`PgUp`/`PgDn` のみ。行編集系（`Ctrl+a` 等）は TextArea 内 `useKeyboardInput` が処理。入力欄に文字があるときはスクロール系は `Ctrl` 修飾時のみ有効。

**テスト**: `packages/cli/src/tui/operator-text-area-emacs-keys.test.tsx` でフォークキーマップ監査と `useKillRing` 挙動に加え、`operator-text-area-keyboard-harness.tsx` を介した実キー列（`Ctrl+a/e/f/b/d`、`Ctrl+k` + `Ctrl+y`、`Alt+b/f`）を CI で担保する。`ink-testing-library` では実 `TextArea` の measureElement 連鎖が stdin の縦切りを不安定にするため、TextArea 内部の `useKeyboardInput` 配線を再現した React ハーネスで検証する。TTY + 日本語 IME はマージ前の実機ゲート（#186 / #196）。

**やるべきでないこと**

- `~/.inputrc` を TUI 入力欄に効かせようとすること（プロセスが Raw で Readline を使っていない）
- Ink ペイン全体の `useInput` に行編集ショートカットを足すこと（TextArea と二重バインドになる）

**IDE 内ターミナル（Cursor 等）**: macOS では **Option を Meta（+Esc）** に設定しないと `Alt+b` / `Alt+f` が効かない（特殊文字入力になる）。IDE が `Ctrl+k` 等を先取りする場合は、フォーカスがターミナルにあること・IDE キーバインド設定を確認する。詳細は [README.md](../README.md#tty-と-ide-内ターミナル) を参照。

**今後 Emacs 風を拡張する場合**

1. まず **フォーク `react-ink-textarea` のキーマップ** を確認・拡張（単一ソース）。上流還流は #195
2. Vi モードが必要ならライブラリ / ADR で明示（デフォルトは Emacs 維持が業界標準）
3. CJK ではキー処理より **IME 物理カーソル** を優先（表示カーソルと OS IME 窓の一致）

---

## 7. 参考: 設定ファイル一覧

| 層 | ファイル | 用途 |
|----|----------|------|
| Readline | `~/.inputrc` | シェル・Readline リンクアプリ |
| libedit | `~/.editrc` | BSD/macOS 系 CLI |
| Zsh | `~/.zshrc` (`bindkey`) | ZLE |
| macOS GUI | `~/Library/KeyBindings/DefaultKeyBinding.dict` | Cocoa テキスト全般 |
| iTerm2 | Profiles → Keys | Option を Meta (+Esc) に |
| GTK3（レガシー） | `gtk-key-theme 'Emacs'` | GTK4 以降は削除済み |

---

## 8. 関連リンク（外部）

- [GNU Readline — Key Bindings](https://tiswww.case.edu/php/chet/readline/readline.html)
- [prompt_toolkit — Key bindings](https://python-prompt-toolkit.readthedocs.io/en/stable/pages/advanced_topics/key_bindings.html)
- [rhysd/tui-textarea](https://github.com/rhysd/tui-textarea) — Rust 向け Emacs 内蔵 textarea
- [Ink useCursor](https://github.com/vadimdemedes/ink/pull/866) — TUI での IME 物理カーソル
