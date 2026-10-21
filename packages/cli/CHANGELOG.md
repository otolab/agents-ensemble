# @agents-ensemble/cli

## 0.14.0

### Minor Changes

- a35de08: セッション終了サマリに開始時刻と経過時間を追加し、TTY 表示にも経過時間を表示します。
- c3d6c83: 稼働中の Issue harness にセッション単位 UDS control API を追加し、operator-agent から Open Question の一覧取得と回答を行えるようにしました。終了時の dispatch drain は最大 5 秒とし、回答が保存済み・dispatch 未確認の場合は outcome unknown を返し、停止後の再送で二重回答が起きないようにします。
- 7b32d52: TTY の Open Question（choice / yes_no）で回答候補を表示し、最初の Enter で補完、次の Enter で送信できるようにします。

### Patch Changes

- 6cfb401: TTY の Ink TUI（pane / stream）の Operator input 欄に限り、行頭を `> ` に統一します。Ink を使わない TTY 継続入力（`bindAsyncOperatorInput`）の `operator> ` と、非 TUI の stdout 対話ログに付く `operator>` / `conductor>` の話者ラベルは従来どおりです。
- 56ec2b5: 利用者向けドキュメントに LLM usage の source 別の意味と、集計・課金上の注意を追加します。
- 853372e: TTY 終了サマリに記録範囲の短い脚注を追加します。
- 838c964: TTY 終了サマリで agent ごとの token usage と cache 指標を同じ行にまとめます。
- 10199e1: Workers ペインで worker 名と kind が同じ場合に重複表示を省きます。
- Updated dependencies [a35de08]
- Updated dependencies [c3d6c83]
- Updated dependencies [c4906d7]
  - @agents-ensemble/core@0.14.0
  - @agents-ensemble/operator-agent@0.2.0

## 0.13.0

### Minor Changes

- 05168a8: `ensemble operator-agent` と独立した operator-agent package を追加しました。TTY 対話では conductor と同じ backend・model・profile・認証設定を使い、保存済み sidecar を読み取り専用ツールから参照できます。

### Patch Changes

- 7862403: TTY の question なし Operator input pane から固定案内をなくし、入力欄だけを表示します。
- aefb82f: Add keyboard selection and Tab completion to TTY slash command suggestions.
- 55d2729: Expose per-agent token and cache details in session summaries, mark token totals as recorded usage only, and report reliable Pi compaction counts. Billing scope is conductor-only; its additive metadata remains optional in the public type for source compatibility.
- 5715bc8: Open Question の context への permission summary の自動追記をなくしました。必要な説明は conductor が質問と context に記述します。
- 9eb66ba: ADR 0031 で operator-agent 層を採用し、Phase 1 は conductor の config・backend・認証を流用して `ConductorAgent`（SDK / Pi、ACP 非採用）で動かす方針を architecture / modular-prompt に追記しました。
- Updated dependencies [a19ab4a]
- Updated dependencies [05168a8]
- Updated dependencies [993b66e]
- Updated dependencies [55d2729]
- Updated dependencies [5715bc8]
- Updated dependencies [4ef2ec7]
- Updated dependencies [9eb66ba]
- Updated dependencies [c7ab17a]
- Updated dependencies [e24cb1b]
  - @agents-ensemble/core@0.13.0
  - @agents-ensemble/operator-agent@0.1.0

## 0.12.0

### Minor Changes

- faa55f5: TTY に `/close` を追加し、Pi conductor の resumable close では stdio MCP 子プロセスを停止してから session を dispose する
- 86a53d2: TTY に `/close` コマンドを追加し、sidecar と worktree を残してセッションを閉じ、同じ Issue を `--continue` で再開できるようにします。

### Patch Changes

- 87fc4d8: Pi `cached-auth` の Node.js entrypoint を追加し、既存キャッシュとの互換を保ったまま cache hit の起動・判定を軽量化する。
- 822b7e2: 長時間の TTY Issue セッションで User Timing の measure / mark を定期的に整理し、Node の performance entry buffer が肥大化するのを防ぎます。
- b9c0e1f: Operator input の slash コマンド候補を表示し、候補表示と既存コマンド判定で同じカタログを使う
- Updated dependencies [faa55f5]
- Updated dependencies [c175013]
- Updated dependencies [e621fb0]
- Updated dependencies [b9c0e1f]
- Updated dependencies [721341b]
- Updated dependencies [cad3ca8]
  - @agents-ensemble/core@0.12.0

## 0.11.0

### Minor Changes

- 3191159: TTY TUI の既定レイアウトを `pane` から `stream` に変更します。従来のペイン分割を使う場合は `tui.layout: pane` または `ENSEMBLE_TUI_LAYOUT=pane` を指定してください。stream では scrollback 閲覧中に新着ログで末尾へ戻る場合があり、通常の幅変更では既追記行は再折り返しされません（[operator-input.md](https://github.com/otolab/agents-ensemble/blob/main/docs/operator-input.md)、[ADR 0015](https://github.com/otolab/agents-ensemble/blob/main/docs/adr/0015-cli-tui-library.md)）。

### Patch Changes

- 49a7e49: Add an explicit Pi model catalog comparison and import command for OpenAI-compatible providers.
- 76ce635: Make `implementer-and-reviewer-v2` the bundled default team profile.
- 1685822: Record open-question `yes_no` answers as three-way assent and add choice questions with a canonical selected option id. Existing sidecars remain readable, and legacy `approved` values are restored unchanged rather than recalculated; new `approved` values are derived only for permission-linked `yes_no` questions.
- 93fff85: Add opt-in lazy ACP worker attach with sleeping worker status and preserve eager startup by default.
- 09e7baa: Pi `cached-auth.sh` の既定キャッシュキーを `default` にし、既定 cache-dir を~/.ensemble/pi/cache/auth に変更。macOS 向け mkdir ロックを追加。
- dbe0a2d: Pi conductor の `models.json` `!command` 向けに `scripts/pi/cached-auth.sh` を同梱し、gcloud identity token 等の連続取得を抑えるキャッシュ運用をドキュメントに追記する。
- c190760: Support profile-independent user instructions for conductor sessions.
- 4b34c5f: Keep isolated worktree cleanup failures as warnings without changing the session exit code.
- c1da931: Preserve multiline activity posts and show compact Open Questions details with explicit truncation.
- Updated dependencies [76ce635]
- Updated dependencies [1685822]
- Updated dependencies [8ee983a]
- Updated dependencies [93fff85]
- Updated dependencies [fd97be2]
- Updated dependencies [c190760]
- Updated dependencies [4b34c5f]
- Updated dependencies [3191159]
  - @agents-ensemble/core@0.11.0

## 0.10.1

### Patch Changes

- e5c859d: Pi 依存（`pi-agent-core` / `pi-ai` / `pi-coding-agent` / `pi-codemode`）を 1.2.0 に揃え、npm global install 時に `pi-codemode@1.2` と `pi-coding-agent@1.0` が混在して CLI 起動できなくなる問題を解消する（#426）。
- Updated dependencies [e5c859d]
  - @agents-ensemble/core@0.10.1

## 0.10.0

### Patch Changes

- 915c6b0: ADR 0028 を追加し、worker ACP 認証の既定を移譲、conductor は ensemble auth 標準と `!command` 移譲を明文化する（実装は #421）。
- fda0b73: Extend the permission deadlock warning threshold to five minutes and notify the conductor with a low-priority stall event while preserving the operator warning.
- Updated dependencies [915c6b0]
- Updated dependencies [a4f121d]
- Updated dependencies [fda0b73]
- Updated dependencies [a83dbf9]
  - @agents-ensemble/core@0.10.0

## 0.9.3

### Patch Changes

- 9fd9d71: 既定の harness telemetry を conductor 境界・障害系の要約に絞り、`--verbose` / `CONDUCTOR_VERBOSE` / `conductor.verbose` で詳細表示を復活します。
- Updated dependencies [9fd9d71]
- Updated dependencies [140e8ff]
- Updated dependencies [dac599b]
  - @agents-ensemble/core@0.9.3

## 0.9.2

### Patch Changes

- Updated dependencies [eb5a039]
- Updated dependencies [498b1b8]
- Updated dependencies [5b9ee96]
- Updated dependencies [b049653]
  - @agents-ensemble/core@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [4ee10c6]
  - @agents-ensemble/core@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [1b908ef]
  - @agents-ensemble/core@0.9.0

## 0.8.0

### Minor Changes

- c4d9ec5: Pi conductor を `AuthStorage` / `ModelRegistry` と統合し、`ensemble auth login|logout|status`、実行時 OAuth refresh、`ensemble models list` を provider 単位で利用できるようにする。

### Patch Changes

- 5d9199b: worker failure や teardown 後に残った stale な `permission.pending` の dispatch を防ぎ、cleanup の発生順と対象 requestId を観測できるようにする。
- Updated dependencies [f81ccc2]
- Updated dependencies [4485f04]
- Updated dependencies [5d9199b]
- Updated dependencies [c4d9ec5]
- Updated dependencies [78c2461]
  - @agents-ensemble/core@0.8.0

## 0.7.0

### Patch Changes

- 4bbfd69: Add configurable Cursor/Pi conductor backend selection, sidecar backend persistence, and resume mismatch validation. Pi selection remains an explicit unsupported stub until #352.
- 9305ca9: Open questions ペインを内容駆動で拡大し、長文 question + context を通常端末で読めるようにした。非選択 question の compact 行も常に表示する。
- f3ec576: TUI と端末出力の inline Markdown で、リスト・GFM テーブル内のスタイルと通常リンク表示に対応しました。
- 6d6af3f: TTY TUI の `stream` で keyboard detached 中の新着 activity log を保留し、`End` で最新へ追従できるようにしました。`pane` では detached 中の新着追記後も同じログ行を維持します。
- 715a438: Coalesce terminal-width decreases during TUI resize so pane and stream live frames are redrawn once at the final width.
- ef7db30: Recover the stream TUI after a settled terminal-width shrink by resetting the display and replaying retained activity history.
- a1b685b: Warn when isolated worktree cleanup is skipped or fails, and retry transient cleanup failures after `/exit`.
- Updated dependencies [72e21fd]
- Updated dependencies [30378d8]
- Updated dependencies [4bbfd69]
- Updated dependencies [c1ed2be]
- Updated dependencies [d35e885]
- Updated dependencies [2497e75]
- Updated dependencies [c499139]
- Updated dependencies [b23cbb0]
- Updated dependencies [1cd7865]
- Updated dependencies [a1b685b]
  - @agents-ensemble/core@0.7.0

## 0.6.5

### Patch Changes

- 0d47974: `conductor.send` の SDK/transport 失敗を conductor 対話チャンネルへ合成表示せず、harness 障害として分類済みの日本語要約と診断情報を表示する。
- 882e3f9: conductor の Connection stalled 時に in-process transport 再接続を試行し、オペレータの `/reconnect` コマンドを追加する。
- 46b836c: Keep TTY issue sessions alive for post-loop permission requests and reject late teardown requests safely.
- 367105f: TTY で CLI または `ENSEMBLE_OPERATOR_MESSAGE` の初回メッセージを指定しても、`/exit` まで post-loop 待機と追加オペレータ入力を維持するようにしました。
- b630488: TTY TUI のリサイズを settle してから pane / stream の live frame を同じ terminal size snapshot で再配置し、stream の Static activity log を再送しないようにする。
- Updated dependencies [882e3f9]
- Updated dependencies [46b836c]
  - @agents-ensemble/core@0.6.5

## 0.6.4

### Patch Changes

- Updated dependencies [e1bba76]
- Updated dependencies [dbe70a4]
  - @agents-ensemble/core@0.6.4

## 0.6.3

### Patch Changes

- 800ca6f: TUI と端末出力で inline Markdown の bold / code 表示に対応しました。
- Updated dependencies [c7bfa82]
- Updated dependencies [8a6c457]
- Updated dependencies [cca77ad]
  - @agents-ensemble/core@0.6.3

## 0.6.2

### Patch Changes

- Updated dependencies [e69df17]
- Updated dependencies [612c94b]
  - @agents-ensemble/core@0.6.2

## 0.6.1

### Patch Changes

- a11ce11: Switch the CLI to the published `@otolab/react-ink-textarea@0.4.1-otolab.3` fork and remove the local patch override.
- 36285a9: CLI 利用者向け README、設定ドキュメント、設定例を npm パッケージに同梱します。
- 9e953db: `ensemble issue` が CLI 引数から初回のオペレータメッセージを受け取り、conductor へ 1 回送信できるようにしました。
- Updated dependencies [13b6026]
- Updated dependencies [e8503b2]
- Updated dependencies [075b9a6]
- Updated dependencies [c652456]
- Updated dependencies [5f56e40]
  - @agents-ensemble/core@0.6.1

## 0.6.0

### Patch Changes

- aac4ba4: Improve operator-facing `permission.pending` representations for ACP payload variants and share the renderer through core between CLI output paths.
- 16c8871: Normalize TUI Issue hyperlinks to canonical GitHub Issue URLs in pane and stream layouts.
- 9aef597: Add the conductor `set_dispatch_hold` tool to batch trigger events while keeping operator and permission dispatch immediate, with TUI visibility in both layouts.
- 2c77f65: Use canonical Issue URLs when the terminal does not support OSC 8 hyperlinks.
- 4162269: Keep truncated TUI Issue hyperlinks closed before the surrounding border is rendered.
- b9a34dc: Add an opt-in `stream` TTY layout with scrollback activity logs via `ENSEMBLE_TUI_LAYOUT=stream` while keeping the existing `pane` layout as the default.
- 400afca: Separate operator input prompts from session status: show Issue links in the Workers pane header and keep Operator input prompt-only across pane and stream layouts.
- 41ba1f2: Add `tui.layout` and `tui.forceHyperlink` to `.ensemble/config.yaml`, resolved with the same env-over-config precedence as other Phase 1 settings.
- Updated dependencies [aac4ba4]
- Updated dependencies [966e3c6]
- Updated dependencies [9aef597]
- Updated dependencies [7f8aa67]
- Updated dependencies [41ba1f2]
  - @agents-ensemble/core@0.6.0

## 0.5.3

### Patch Changes

- 9c2f97e: TTY オペレータ入力欄の Emacs 風 `Ctrl+f/b` の実キー経路を CI で検証し、`Ctrl+d` の 1 文字削除を追加。
- 26f4dd9: TTY の Issue コンテキスト表示に OSC 8 リンクと非対応端末向けフォールバックを追加。
  - @agents-ensemble/core@0.5.3

## 0.5.2

### Patch Changes

- Updated dependencies [ced9195]
- Updated dependencies [299fce5]
- Updated dependencies [a231f12]
- Updated dependencies [04625ce]
  - @agents-ensemble/core@0.5.2

## 0.5.1

### Patch Changes

- 54540a6: worker ACP attach 時の `authenticate` を preset 別に解決する。`codex` は `chat-gpt` で Codex CLI ログインを再利用、`claude` / `pi` は skip、`cursor` は `cursor_login` 維持。
- Updated dependencies [54540a6]
  - @agents-ensemble/core@0.5.1

## 0.5.0

### Minor Changes

- 1c2df6e: `.ensemble/config.yaml` を Phase 1 キー（profile / conductor / acp / session / github.monitor）まで拡張し、解決順 `CLI > env > project config > user config > コード default` を `resolve*Setting` とテストで統一。`ensemble issue` が config 既定を参照する。ドキュメント・ADR 0020 追加。
- 825ddb6: GitHub 情報取得を `gh` CLI から REST / GraphQL API 直接呼び出しへ移行。`GITHUB_TOKEN` / `GH_TOKEN` 設定時は `gh` 未インストールでも Issue 取得・GitHub 監視が動作する。認証フォールバックとして `gh auth token` のみ残す。GitHub 認証失敗時は conductor 認証と区別された `[github-auth]` 復旧ヒントを表示する。

### Patch Changes

- 07ce6c8: built-in ACP preset（`claude` / `codex` / `pi`）の `npx` 起動を廃止し、`optionalDependencies` 同梱 bin → PATH → 明示エラーの順で spawn する。spawn 前に外部 CLI（`agent` / `pi` 等）の存在チェックと install 手順付き fail fast を追加。
- Updated dependencies [07ce6c8]
- Updated dependencies [1c2df6e]
- Updated dependencies [8b8fbaf]
- Updated dependencies [825ddb6]
- Updated dependencies [c90fe10]
  - @agents-ensemble/core@0.5.0

## 0.4.1

### Patch Changes

- 913e629: AGENTS.md にリリース・ブランチ運用（通常 PR は main、release/\* への直接マージ禁止、main merge/push は明示指示時のみ）を追記する。
- c29f893: Orchestration ペインでオペレータ入力の段落間空行が潰れないよう活動ログの空 body 行を可視化する
- ae34447: CLI/TUI 標準ショートカット（Emacs 風）のサポート階層と実装方針を `docs/cli-text-input-keybindings.md` に追加する（#210）。
- e57a7a5: `/exit` 後のプロセス残留を解消（GitHub monitor poll タイムアウト・teardown 段階表示・Ctrl+C ガイダンス）
- 6b6d1fb: オペレータ入力欄の Emacs 風ショートカットを Readline デファクトに整合（`@otolab/react-ink-textarea` パッチ: キルリング、`Ctrl+f/b`、`Ctrl+y` ヤンク、`Alt+y`）。CI 向けキーマップ監査テストを追加。
- 778f4a4: 同梱 team profile（implementer-and-reviewer）の conductor / implementer プロンプトを更新。マージ可否判断・未解決問題のエスカレーション・人間への引き渡し手順を明確化し、implementer に「手順の正本」への疑念の報告指針を追加する。
- Updated dependencies [e57a7a5]
- Updated dependencies [778f4a4]
  - @agents-ensemble/core@0.4.1

## 0.4.0

### Minor Changes

- f730b16: worker ACP built-in preset に `pi`（`npx -y pi-acp`）を追加。profile / `--default-acp-cli` / `ENSEMBLE_DEFAULT_ACP_CLI` から選択可能。制限事項は ADR 0019 参照。
- d467dc9: worker ACP spawn を profile / CLI / 環境変数で切り替え可能にした。built-in preset（cursor / claude / codex）、custom command、resume 時の spawn 不一致検知を追加。

### Patch Changes

- 942274f: Issue セッション TUI の 4 ペイン（Orchestration / Workers / Open questions / Operator input）タイトルを上枠線に埋め込み、内側タイトル専用行を廃止して表示行数を節約する。
- Updated dependencies [d263bf4]
- Updated dependencies [f730b16]
- Updated dependencies [d467dc9]
  - @agents-ensemble/core@0.4.0

## 0.3.2

### Patch Changes

- e6f8dbc: 同梱 team profile（implementer-and-reviewer）の conductor プロンプトを更新。人間へのエスカレーション表にシステム外境界の行を追加し、終了判断と引き継ぎ手順を明確化する。
- c163a10: post-loop 待機時の observation 文言を「自律作業が一段落しました。」に短縮する（`/exit` 案内は入力欄ヒント等に委譲）。
- 5a23c1d: `react-ink-textarea` を otolab フォーク（commit pin）へ切り替え、IME 物理カーソルをフォーク `TextArea` の `cursorStart` に委譲した（#196）。GitHub 依存は `dist` 未同梱のため `postinstall` でビルドする。
- Updated dependencies [e6f8dbc]
- Updated dependencies [c163a10]
  - @agents-ensemble/core@0.3.2

## 0.3.1

### Patch Changes

- c9baa35: workspace が存在しない（またはディレクトリでない）team profile を `unusable` として一覧表示し、`loadProfile` / `--profile` 起動前に拒否する。`ensemble profiles list` は `[unusable]` と issues を表示し、`--json` に `availability` / `issues` を含める。
- Updated dependencies [c9baa35]
- Updated dependencies [08fba5f]
  - @agents-ensemble/core@0.3.1

## 0.3.0

### Minor Changes

- febd6b9: `--profile` 未指定時に環境変数 `ENSEMBLE_DEFAULT_PROFILE` でデフォルト team profile（名前またはパス）を指定できる。CLI `--profile` が環境変数より優先される。
- 1ca6c84: team-profile の 4 層名前解決を追加（project `.ensemble/teams/` > user `~/.ensemble/teams/` > bundled > legacy）。`listTeamProfiles` / `resolveTeamProfilePath` API、組み込み default の内部名 `implementer-and-reviewer`（`default` エイリアス維持）、CLI `ensemble profiles list` を追加。

### Patch Changes

- 126a34d: `ensemble --version` の出力を `package.json` の version に連動させる（ハードコード `0.0.0` を廃止）
- 2089a6a: `/exit` 入力後の応答性を改善（fast path teardown・即時 UI フィードバック・worker cancel）
- ddbd826: セッション終了サマリを統計中心に変更。TTY はテキスト（stderr）、非 TTY は JSON（stdout）。`sessionUsage`・`responsePreview`・`--summary-format` / `--include-full-response-text` を追加。conductor `getUsage().cost` は取得時のみ `sessionUsage` にマージ。
- Updated dependencies [61e2aa4]
- Updated dependencies [febd6b9]
- Updated dependencies [2089a6a]
- Updated dependencies [ddbd826]
- Updated dependencies [1ca6c84]
- Updated dependencies [aebe79e]
  - @agents-ensemble/core@0.3.0

## 0.2.1

### Patch Changes

- 2bde484: ACP `session/update` の `harness.worker.acp.update` と `conductor.send.progress` を活動ログ / stderr から除外し、Workers ペインにフェーズ変化時のみ活動ヒントを表示（#161）
- Updated dependencies [2bde484]
- Updated dependencies [4a8088f]
- Updated dependencies [0c366f6]
  - @agents-ensemble/core@0.2.1

## 0.2.0

### Minor Changes

- facc478: ACP `session/update` を harness テレメトリ（`harness.worker.acp.update`）と TUI Workers 欄に配線。`dispatchMode` 型骨格を追加（#148 フェーズ 1）
- c74fe5f: `agents.<kind>` の system prompt 拡張を modular-prompt YAML（`prompt` / `promptFile`）に統一。`systemPrompt` / `systemPromptFile`（markdown 含む）を削除。

### Patch Changes

- be3891d: TUI Workers 欄を `list_workers` と整合させるため `harness.session.workers` / `harness.worker.state` を追加し reducer を強化（#147）
- Updated dependencies [facc478]
- Updated dependencies [6ffaf55]
- Updated dependencies [42c9bc1]
- Updated dependencies [c74fe5f]
- Updated dependencies [be3891d]
- Updated dependencies [badab66]
  - @agents-ensemble/core@0.2.0

## 0.1.1

### Patch Changes

- 9d2863c: `js-yaml` を core の runtime dependencies に移し、グローバル install 後の `ensemble` 起動を修正
- Updated dependencies [9d2863c]
  - @agents-ensemble/core@0.1.1

## 0.1.0

### Minor Changes

- d5ce3ef: npm 公開と changeset ベースのリリースフロー（modular-prompt 踏襲）を整備

### Patch Changes

- 124bdba: publish 時に prepublishOnly が dist を再生成するよう tsc --build --force を使う
- Updated dependencies [d5ce3ef]
- Updated dependencies [124bdba]
  - @agents-ensemble/core@0.1.0
