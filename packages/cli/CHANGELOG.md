# @agents-ensemble/cli

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
