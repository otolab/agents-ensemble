# @agents-ensemble/core

## 0.9.2

### Patch Changes

- eb5a039: Issue 文脈に GitHub オペレータ login（`@me` の実体）を載せ、conductor プロンプトでオペレータ本人の GitHub 投稿を TTY 入力同等と扱う旨を明記します。
- 498b1b8: Pi conductor の headless 経路で、`.ensemble/pi/settings.json` の `compaction.*` と `branchSummary.*` を user / project 層から解決して適用します。transcript の保存先は引き続き harness が管理します。
- 5b9ee96: Pi conductor の headless 設定をコード上の allowlist に基づいて適用し、`.ensemble/pi` と Pi SDK の project settings の境界を明確化します。`compaction` / `branchSummary` の再適用ポリシーも create / reload / resume のライフサイクルに合わせて統一します。
- b049653: Profile の `conductor.builtinTools` で Pi / Cursor conductor の built-in coding tools を制御できるようにします。省略・未指定は有効で、`false` のときだけ無効になります。

## 0.9.1

### Patch Changes

- 4ee10c6: Pi conductor now resolves `!command` API keys in `models.json` and `settings.json` using Pi's standard configuration behavior.

## 0.9.0

### Minor Changes

- 1b908ef: Migrate the Pi conductor backend to the Pi 1.x AgentSession SDK and its official MCP extension. This is a breaking change for Pi conductor MCP configuration: SSE servers are no longer supported, MCP tools use Pi's `mcp__<server>__<tool>` names, and HTTP OAuth/resource tools are handled by the official extension.

## 0.8.0

### Minor Changes

- c4d9ec5: Pi conductor を `AuthStorage` / `ModelRegistry` と統合し、`ensemble auth login|logout|status`、実行時 OAuth refresh、`ensemble models list` を provider 単位で利用できるようにする。

### Patch Changes

- f81ccc2: GitHub CI 通知を commit SHA ごとの `running` / `failed` / `completed` 集約状態の遷移として扱う。
- 4485f04: conductor プロンプトでオペレータ対話の優先条件と Open Question 経由のエスカレーションを明記する。
- 5d9199b: worker failure や teardown 後に残った stale な `permission.pending` の dispatch を防ぎ、cleanup の発生順と対象 requestId を観測できるようにする。
- 78c2461: conductor が明示登録した GitHub PR の監視を解除できる `unregister_github_watch` ツールを追加する。

## 0.7.0

### Minor Changes

- 30378d8: Extract the backend-neutral ConductorAgent interface and factory, and move the default implementation behind the Cursor SDK backend.
- 4bbfd69: Add configurable Cursor/Pi conductor backend selection, sidecar backend persistence, and resume mismatch validation. Pi selection remains an explicit unsupported stub until #352.
- c1ed2be: Add the backend-neutral ConductorTool registry and Cursor SDK adapter for conductor harness tools.
- d35e885: Add the Pi conductor backend with native system prompts, harness-tool adapters, and Pi file-based model/auth configuration.
- 2497e75: Load the resolved ensemble MCP configuration into the Pi conductor through a pinned MCP bridge, alongside the existing Cursor SDK path.
- c499139: Wire the Pi conductor to user/project `.ensemble/pi` resources, including local extensions, while retaining the fixed harness and MCP tool loadout.

### Patch Changes

- 72e21fd: Detect GitHub CI completions from normalized check-state differences instead of run identities, while preserving bootstrap and retry behavior.
- b23cbb0: Persist Pi conductor transcripts and restore them for `--continue` / `--resume` with the existing sidecar agent id.
- 1cd7865: Ensure dispatchable worker completion and failure events are delivered before a conductor session stops, regardless of which event source triggered the preceding send.
- a1b685b: Warn when isolated worktree cleanup is skipped or fails, and retry transient cleanup failures after `/exit`.

## 0.6.5

### Patch Changes

- 882e3f9: conductor の Connection stalled 時に in-process transport 再接続を試行し、オペレータの `/reconnect` コマンドを追加する。
- 46b836c: Keep TTY issue sessions alive for post-loop permission requests and reject late teardown requests safely.

## 0.6.4

### Patch Changes

- e1bba76: GitHub monitor の CI 完了通知で、CheckRun の弱い runKey（URL / 名前フォールバック）が poll ごとに揺れて同じ完了を毎回 `github.update` として再送する問題を修正。
- dbe70a4: base-module のチーム運用 instructions を profile materials に移し、worktree 解決（isolated / in_repo）を terms に追記。同梱 `implementer-and-reviewer-v2` profile を追加（kind 別 materials 分割）。

## 0.6.3

### Patch Changes

- c7bfa82: conductor が `prompt_worker` で worker を dispatch した直後に自律ループが停止し teardown が始まる問題を修正しました。outbound dispatch 件数の追跡と `runningCount` の同期更新により、worker 完了を待ってから停止判定します。
- 8a6c457: profile materials に `kinds` を指定し、agent kind ごとに Prepared Materials を絞り込めるようにしました。
- cca77ad: ACP の pipe 切断時に JSON-RPC write error が未処理例外にならず、進行中の worker ラウンドへ伝播するようにしました。

## 0.6.2

### Patch Changes

- e69df17: base-module の methodology / instructions を整理し、harness 経由の worker 往復と常駐を明文化。conductor-base の harness 定義重複を解消。
- 612c94b: `--continue` 再開時に initial conductor send が `permission.pending` を塞ぎ calling/thinking で固まる問題を修正しました。resume 時は `skipInitialSend` を配線し、worker イベントを即時 dispatch します。

## 0.6.1

### Patch Changes

- 13b6026: conductor の Cursor SDK local agent が Cursor settings.json の proxy 設定を利用するようにしました。
- e8503b2: conductor プロンプトに open question の一問一答形式を明記し、作業開始前に Issue へ作業方針をまとめる手順を team profile に追加しました。
- 075b9a6: dispatch hold 中の `permission.pending` を held buffer に積み、release 時に他の trigger とまとめて conductor へ dispatch するようにしました。
- c652456: GitHub PR 監視で CI の再実行を run 単位で検知し、登録直後の bootstrap poll でカーソルを初期化するようにしました。
- 5f56e40: ACP worker の失敗時に pending permission を deny して inbox waiter を解消するようにしました。

## 0.6.0

### Minor Changes

- 966e3c6: Add the `register_github_watch` conductor tool for explicitly monitoring pull requests that GitHub Search has not indexed yet.
- 9aef597: Add the conductor `set_dispatch_hold` tool to batch trigger events while keeping operator and permission dispatch immediate, with TUI visibility in both layouts.

### Patch Changes

- aac4ba4: Improve operator-facing `permission.pending` representations for ACP payload variants and share the renderer through core between CLI output paths.
- 7f8aa67: Allow conductor sessions to receive MCP config options for test isolation.
- 41ba1f2: Add `tui.layout` and `tui.forceHyperlink` to `.ensemble/config.yaml`, resolved with the same env-over-config precedence as other Phase 1 settings.

## 0.5.3

## 0.5.2

### Patch Changes

- ced9195: conductor（Cursor SDK）向け MCP 設定の user / project 読み込みと inline 配線を追加。
- 299fce5: Use Codex ACP's normal Agent mode by default, preserve backend permission options, and return their semantic allow/deny option IDs.
- a231f12: post-loop 待機中も GitHub 更新を conductor へ配送し、状況把握ターンとして処理できるようにする。
- 04625ce: 同梱 team profile（implementer-and-reviewer）の conductor 向けに、引き渡し時の心得を追加。Issue / PR を conductor の成果物として扱い、達成不可と判明したときのオペレータへの説明責務を明記する。

## 0.5.1

### Patch Changes

- 54540a6: worker ACP attach 時の `authenticate` を preset 別に解決する。`codex` は `chat-gpt` で Codex CLI ログインを再利用、`claude` / `pi` は skip、`cursor` は `cursor_login` 維持。

## 0.5.0

### Minor Changes

- 07ce6c8: built-in ACP preset（`claude` / `codex` / `pi`）の `npx` 起動を廃止し、`optionalDependencies` 同梱 bin → PATH → 明示エラーの順で spawn する。spawn 前に外部 CLI（`agent` / `pi` 等）の存在チェックと install 手順付き fail fast を追加。
- 1c2df6e: `.ensemble/config.yaml` を Phase 1 キー（profile / conductor / acp / session / github.monitor）まで拡張し、解決順 `CLI > env > project config > user config > コード default` を `resolve*Setting` とテストで統一。`ensemble issue` が config 既定を参照する。ドキュメント・ADR 0020 追加。
- 8b8fbaf: `.ensemble/config.yaml` の 2 層解決（user → project deep merge）と `loadEnsembleConfig` API を追加。GitHub 認証解決 API（`resolveGitHubAuthToken`）が `github.auth.allowGhAuthTokenFallback` を参照する。`ensemble issue` 起動時に config を読み込む。
- 825ddb6: GitHub 情報取得を `gh` CLI から REST / GraphQL API 直接呼び出しへ移行。`GITHUB_TOKEN` / `GH_TOKEN` 設定時は `gh` 未インストールでも Issue 取得・GitHub 監視が動作する。認証フォールバックとして `gh auth token` のみ残す。GitHub 認証失敗時は conductor 認証と区別された `[github-auth]` 復旧ヒントを表示する。

### Patch Changes

- c90fe10: GitHub 監視 poll のパース防御・フェーズ単位エラー分離・`monitor_error` 構造化（`phase` / `prNumber` / `cause` / `retryable`）を追加。`runGh` の認証・rate limit・リポジトリアクセスエラー分類を改善。

## 0.4.1

### Patch Changes

- e57a7a5: `/exit` 後のプロセス残留を解消（GitHub monitor poll タイムアウト・teardown 段階表示・Ctrl+C ガイダンス）
- 778f4a4: 同梱 team profile（implementer-and-reviewer）の conductor / implementer プロンプトを更新。マージ可否判断・未解決問題のエスカレーション・人間への引き渡し手順を明確化し、implementer に「手順の正本」への疑念の報告指針を追加する。

## 0.4.0

### Minor Changes

- f730b16: worker ACP built-in preset に `pi`（`npx -y pi-acp`）を追加。profile / `--default-acp-cli` / `ENSEMBLE_DEFAULT_ACP_CLI` から選択可能。制限事項は ADR 0019 参照。
- d467dc9: worker ACP spawn を profile / CLI / 環境変数で切り替え可能にした。built-in preset（cursor / claude / codex）、custom command、resume 時の spawn 不一致検知を追加。

### Patch Changes

- d263bf4: `/exit` 後にプロセスが固まる問題を修正。post-loop 開始直後の `/exit` レース、自律ループ中の in-flight conductor send 待ち、明示終了時の `getUsage` 待ちを解消。

## 0.3.2

### Patch Changes

- e6f8dbc: 同梱 team profile（implementer-and-reviewer）の conductor プロンプトを更新。人間へのエスカレーション表にシステム外境界の行を追加し、終了判断と引き継ぎ手順を明確化する。
- c163a10: post-loop 待機時の observation 文言を「自律作業が一段落しました。」に短縮する（`/exit` 案内は入力欄ヒント等に委譲）。

## 0.3.1

### Patch Changes

- c9baa35: workspace が存在しない（またはディレクトリでない）team profile を `unusable` として一覧表示し、`loadProfile` / `--profile` 起動前に拒否する。`ensemble profiles list` は `[unusable]` と issues を表示し、`--json` に `availability` / `issues` を含める。
- 08fba5f: profile の `workers[].workspace` で `~` / `~/...` を homedir() で展開するようにした。

## 0.3.0

### Minor Changes

- febd6b9: `--profile` 未指定時に環境変数 `ENSEMBLE_DEFAULT_PROFILE` でデフォルト team profile（名前またはパス）を指定できる。CLI `--profile` が環境変数より優先される。
- 1ca6c84: team-profile の 4 層名前解決を追加（project `.ensemble/teams/` > user `~/.ensemble/teams/` > bundled > legacy）。`listTeamProfiles` / `resolveTeamProfilePath` API、組み込み default の内部名 `implementer-and-reviewer`（`default` エイリアス維持）、CLI `ensemble profiles list` を追加。
- aebe79e: profile の `workers[]` に optional な `workspace` を追加し、worker ごとの ACP 起動 cwd（`agent acp` の `session/new` / `session/load`）を指定可能にした。未指定時は従来どおりセッション共通の Issue worktree を使用する。

### Patch Changes

- 61e2aa4: default プロフィールと ensemble base モジュールのプロンプト分担を調整（persona / objective / instructions の整理）
- 2089a6a: `/exit` 入力後の応答性を改善（fast path teardown・即時 UI フィードバック・worker cancel）
- ddbd826: セッション終了サマリを統計中心に変更。TTY はテキスト（stderr）、非 TTY は JSON（stdout）。`sessionUsage`・`responsePreview`・`--summary-format` / `--include-full-response-text` を追加。conductor `getUsage().cost` は取得時のみ `sessionUsage` にマージ。

## 0.2.1

### Patch Changes

- 2bde484: ACP `session/update` の `harness.worker.acp.update` と `conductor.send.progress` を活動ログ / stderr から除外し、Workers ペインにフェーズ変化時のみ活動ヒントを表示（#161）
- 4a8088f: post-loop 待機中に GitHub Issue コメント（`issue.comment`）で SessionDriver を再開し、conductor ターンを起動できるようにする
- 0c366f6: `gh pr view` の `statusCheckRollup` に含まれる `StatusContext` を正規化し、CI 監視 poll の `monitor_error`（`toUpperCase`）を修正

## 0.2.0

### Minor Changes

- facc478: ACP `session/update` を harness テレメトリ（`harness.worker.acp.update`）と TUI Workers 欄に配線。`dispatchMode` 型骨格を追加（#148 フェーズ 1）
- c74fe5f: `agents.<kind>` の system prompt 拡張を modular-prompt YAML（`prompt` / `promptFile`）に統一。`systemPrompt` / `systemPromptFile`（markdown 含む）を削除。

### Patch Changes

- 6ffaf55: イベント型を `conductor/session/events/` に分割。`SessionLogEvent` / `SessionEvent` の正本モジュールを追加し、共有 payload 型・型グループ定数（`ALL_SESSION_LOG_EVENT_TYPES` 等）を公開 export。内部の `isConductorSendEvent` を削除（公開 API には含まれていなかった）。
- 42c9bc1: `index.ts` をドメイン別 barrel に分割。`WorkerSession.startWorkers()` を追加し `bootstrap()` を deprecated に。GitHub monitor の `bootstrapOnly` を `initialCursorPoll` に rename。`@agents-ensemble/core/testing` subpath を追加。`SessionSummary` とテスト API のルート export に deprecated 注記。
- be3891d: TUI Workers 欄を `list_workers` と整合させるため `harness.session.workers` / `harness.worker.state` を追加し reducer を強化（#147）
- badab66: `WorkerLifecycleState` / `WorkerDisplayStatus` と `mapHarnessToDisplayStatus` を公開 export。`WorkerHarnessState` は deprecated alias として維持。

## 0.1.1

### Patch Changes

- 9d2863c: `js-yaml` を core の runtime dependencies に移し、グローバル install 後の `ensemble` 起動を修正

## 0.1.0

### Minor Changes

- d5ce3ef: npm 公開と changeset ベースのリリースフロー（modular-prompt 踏襲）を整備

### Patch Changes

- 124bdba: publish 時に prepublishOnly が dist を再生成するよう tsc --build --force を使う
