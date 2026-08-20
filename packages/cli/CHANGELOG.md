# @agents-ensemble/cli

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
