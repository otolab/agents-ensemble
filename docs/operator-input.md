# オペレータ入力（SessionView）

ConductorSession の **View 層**契約。入力・表示はここに閉じ、オーケストレーション（Driver）とは `bindOperatorInput` で接続する。

関連: [architecture.md](architecture.md) §5、[ADR 0009](adr/0009-conductor-session-event-queue.md)、[ADR 0014](adr/0014-conductor-dispatch-batch-coalescing.md)、[cli-text-input-keybindings.md](cli-text-input-keybindings.md)（Emacs 風ショートカットの実装階層）、Issue #54（TUI）

## 3 層の分担

| 層 | 責務 | 主なモジュール |
|----|------|----------------|
| **SessionPolicy** | dispatch 可否・ループ終了・自律ターン数 | `session-policy.ts` |
| **SessionDriver** | イベントキュー消費・max-turns 登録・`agent.send` | `conductor-session-driver.ts` |
| **SessionView** | TTY Ink TUI / env からのオペレータ入力 | CLI `createIssueSessionTuiHost` / `bindAsyncOperatorInput` |

データの正本: **イベントキュー**（`SessionEventQueue`）と **OpenQuestionRegistry**。View は `submit` で `operator.message` をキューへ積むだけ。TTY の pane / stream は、未回答 open question について `OperatorInputBindingApi.getContext().openQuestions`（Registry の `listOpen()` スナップショット）を表示状態の正本として使う。binding 前の初回描画だけは、イベント reducer の表示 state をフォールバックにする。

## View 契約: `OperatorInputBinding`

`@agents-ensemble/core` が export する型（`operator-input-binding.ts`）。

```typescript
interface OperatorInputContext {
  conductorTurn: number;      // 次の send 番号（1 始まり）
  autonomousTurns: number;
  maxTurns: number | null;    // 無制限時は null
  openQuestions: OpenQuestion[];
}

interface OperatorInputBindingApi {
  submit: (message: string) => boolean;
  getContext: () => OperatorInputContext;
}

type OperatorInputBinding = (
  api: OperatorInputBindingApi,
) => void | (() => void);
```

### `submit(message)`

- 空文字は無視（`false` を返す）
- 受け付けたら `operator.message` をイベントキューへ enqueue（`true`）
- TTY（Ink TUI）では選択中の open question への回答として `submit` する（`targetOpenQuestionId` オプション）
- 非 TTY では未回答 1 件のときはプレーンテキストをその open question への回答として解釈する

View は **ブロックしない**。ループの待機は Driver が `waitForDispatchBatch`（内部で `selectDispatchBatch` + `SessionEventQueue.waitForEvent`）で行う。到着済みの同一メンバーイベントは [ADR 0014](adr/0014-conductor-dispatch-batch-coalescing.md) に従い 1 束にまとめてから `agent.send` する。

### `getContext()`

プロンプト直前の案内（未回答 open question 一覧など）に使う。CLI では `notifyOperatorInputReprompt` 経由で TTY 表示を更新する。

### 戻り値

購読解除関数を返せる（readline close 等）。省略可。

## TTY TUI レイアウト

TTY の既定は `pane` レイアウトです。Workers / Orchestration / Operator input を固定表示し、未回答の open question があるときだけ Open questions ペインをその上に追加します。Orchestration はアプリ内の windowing と `PgUp` / `PgDn` / `End` で操作します。

`ENSEMBLE_TUI_LAYOUT=stream` または `.ensemble/config.yaml` の `tui.layout: stream` を指定すると、活動ログ（operator / conductor / harness / observation）は Ink の `<Static>` で枠なしに上へ追記され、下部は上から **Open questions（未回答時のみ独立表示）→ Operator input → Workers** の順に固定されます。環境変数は config より優先されます（[settings.md](settings.md)）。未回答の open question がないときは独立枠も空状態本文も描画せず、post-loop 待機中は Operator input に `追加指示を入力するか /exit で終了` の prompt のみを表示します。入力欄は `pane` と同じ `react-ink-textarea` の IME 物理カーソル同期を使い、stream の下部 live frame を座標原点として変換窓の位置を計算します。`stream` では活動ログ用のアプリ内スクロールを持たず、端末の scrollback を使います。非 TTY は常に `pane` 経路です。

### Operator input の2モード

pane / stream とも、下部の表示は open question の有無で次の2モードに解決されます。

| モード | 条件 | 表示と入力 |
|--------|------|------------|
| **A: question あり** | `getContext().openQuestions.length > 0` | Open questions ペインを表示。Operator input には選択中 question への回答、`Shift+↑↓`、Enter 送信の prompt を表示し、Issue 参照と自律ターン数は表示しない。submit は `targetOpenQuestionId` 付きで送信する。 |
| **B: question なし** | `getContext().openQuestions.length === 0` | Open questions ペインを高さ 0 として省略。Operator input には `任意のタイミングで入力 · /exit で終了` の prompt のみを表示する。submit は通常の operator メッセージとして送信する。 |

resume で sidecar の未回答 question を復元した場合も、`getContext()` が同じ Registry から一覧を返すため、binding 後の pane / stream はモード A として表示する。表示 reducer の `openQuestions` は live event と binding 前フォールバック用の投影であり、resume 後の判定・選択・submit target は Registry スナップショットと一致する binding context を使う。

post-loop 待機中はモード B の prompt を `追加指示を入力するか /exit で終了` に上書きします。終了中は `終了しています…` を表示して入力を無効化します。Operator input には session status（Issue 参照、post-loop 待機など）を載せず、Workers ペイン上枠の右端に Issue リンクを表示します。

scrollback を実行中に上へ移動しているときに新着ログが追記されると、端末依存で表示が末尾へ戻ることがあります。端末幅を変更しても、既に Static として追記された行は再折り返しされません。

## 実装例

| 環境 | 実装 | ファイル |
|------|------|----------|
| TTY（本番 CLI） | `createIssueSessionTuiHost`（Ink `pane` / `stream` + 入力欄） | `packages/cli/src/tui/create-issue-session-tui-host.tsx` |
| 非 TTY + `ENSEMBLE_OPERATOR_MESSAGE` | `bindAsyncOperatorInput`（env を 1 回 submit） | `packages/cli/src/async-operator-input.ts` |
| テスト | `createTestOperatorInputBinding` | `packages/core/src/conductor/testing/test-operator-input-binding.ts` |

## `runConductorSession` への接続

```typescript
runConductorSession({
  // ...
  bindOperatorInput: bindAsyncOperatorInput, // View
});
```

`runConductorSession`（ファサード）が View を Driver へ配線する。Driver の public API を View 実装が知る必要はない。

## Policy との境界

View が決めないこと（SessionPolicy / Driver の責務）:

- max-turns 到達後に worker イベントを送るか（`maxTurns <= 0` のときは常に可）
- 次に送るイベント束の選び方（`operator.message` 最優先 → `permission` → worker continuation 1 回 → 静的優先度 — [ADR 0014](adr/0014-conductor-dispatch-batch-coalescing.md)）
- 未回答 open question があるときのループ継続（open question がある間は停止しない）
- ループ終了条件

## CLI: 自律ターン上限

| 条件 | デフォルト |
|------|-----------|
| TTY または `ENSEMBLE_OPERATOR_MESSAGE` あり | 無制限 |
| 非 TTY / CI | 5 |

明示指定:

```bash
ensemble issue <url> --max-turns 10   # 上限 10
ensemble issue <url> --max-turns 0    # 無制限
ensemble issue <url> --no-max-turns   # 無制限
```

無制限時は `OperatorInputContext.maxTurns` が `null` となります。`autonomousTurns` / `maxTurns` は View がコンテキストとして受け取りますが、現在の Operator input hint には自律ターン数を表示しません。

View は `getContext()` で状態を**読む**だけ。dispatch 判断は Driver が Policy を参照して行う。

### Issue リンク

TTY の Ink TUI では、Workers ペイン上枠の右端に作業中 Issue の
`owner/repo#number` を表示する。対応端末では OSC 8 リンクとして表示され、Cmd+クリック
（または端末の同等操作）で canonical な `https://github.com/{owner}/{repo}/issues/{number}`
をブラウザで開ける。Operator input の prompt には Issue 参照を載せない。OSC 8 が
非対応・無効、または端末を判定できない場合は、`owner/repo#number` を端末の自動リンクに
誤認識させないため canonical URL 全文を省略せず表示する（OSC 8 制御文字は出力しない）。
URL が端末幅を超える場合も URL は省略せず、上枠の title / suffix を先に省略する。
`TERM_PROGRAM=vscode` は統合端末ごとの挙動差があるため自動的には OSC 8 対応とみなさず、
必要な場合は `FORCE_HYPERLINK=1` または config の `tui.forceHyperlink: on` で明示的に有効化できる（tmux 経由で `TERM_PROGRAM=tmux` になる場合も同様）。非 TTY では既存の
フォールバック出力を維持する。

## post-loop 待機（プロセス維持）

自律ループ停止後、CLI TTY デフォルトでは harness が **post-loop 待機** に入る（[ADR 0013](adr/0013-process-lifecycle-vs-autonomous-loop.md)）。この間も SessionDriver は停止せず、イベントキューで次の dispatch を待つ。`session.post_loop_wait` は待機 UX の開始通知であり、イベント配送を止める合図ではない。

| 条件 | 動作 |
|------|------|
| TTY + デフォルト | 自律ループ停止後も `operator>` を維持。`/exit` でプロセス終了 |
| `--no-wait` | 自律ループ停止後に即終了（従来動作） |
| 非 TTY / CI | `waitForOperatorExit` なし → 即終了 |
| post-loop 中の TTY 追加入力 | `operator.message` としてキューに積み、継続中の SessionDriver が処理 |
| post-loop 中の GitHub 更新 | `issue.comment` / `pr.review` / `pr.review_comment` / `ci.completed` を `github.update` として enqueue し、継続中の SessionDriver が処理（[harness-events.md](harness-events.md) §3） |

**post-loop 中の dispatch と max-turns**

| イベント | ターン残あり | max-turns 到達後 |
|----------|------------|----------------|
| `operator.message` | dispatch。オペレータ入力として自律ターン数をリセット | dispatch（`operator.message` は常に許可） |
| `permission.pending` | dispatch | dispatch（permission 判断を優先） |
| `github.update` | dispatch。状況把握ターンとして自律ターンを 1 消費 | enqueue のみ。dispatch しない |

自律ループ稼働中（post-loop 前）も同じ経路で処理する。GitHub 更新の種類による `notifyResume` 条件分岐は持たない（#160）。

### `/exit` の即時フィードバック（#170）

`/exit` または `exit`（大文字小文字無視・前後空白トリム）を受け付けた直後、harness は `session.operator_exit` を **同期** emit する。

| 表示経路 | 内容 |
|----------|------|
| TTY（Ink） | 活動ログに「終了しています…」（`session.post_loop_wait` と同様 observation ラベル）。入力欄のヒントも同文になり、二重 submit を防ぐため入力は無効化 |
| 非 TTY interactive | stderr に `\n終了しています…\n`（`createObservationSink`） |

その後、worker へ `session/cancel`、明示 exit 時は fast path teardown（`waitForIdle` スキップ・並列 close）が走る。詳細は [harness-events.md](harness-events.md) の `harness.teardown`。

#### post-loop 開始直後の `/exit`（#200）

`session.post_loop_wait` の通知後も SessionDriver がイベント待機を継続する。`/exit` は専用の終了 signal で Driver の待機を中断するため、通知と待機 API の間に `/exit` が失われるレースはない。

#### teardown が長引く場合（#200）

| 段階 | 通常の挙動 | 利用者への表示 |
|------|------------|----------------|
| `/exit` 直後 | `session.operator_exit` で TUI は「終了しています…」・入力無効化 | 活動ログ / 入力ヒント |
| `buildResult` | 明示 exit / interrupt 時は `getUsage().cost` 取得をスキップ（SDK 応答待ちで固まらない） | なし |
| `finally` teardown | force 時は worker / conductor / GitHub 監視を並列停止。子プロセスは SIGTERM 後最大 5s、残存時 SIGKILL | `harness.teardown.phase` で段階表示。完了時 `harness.teardown`（1s 超または force 時） |
| GitHub monitor `stop`（accepted risk） | 監視有効時、GitHub API poll 実行中（`pollInFlight`）に `/exit` すると `stop()` が poll 完了までブロックしうる | 最大 5s 待機後に poll を abort して teardown 継続（#209）。`harness.teardown.phase` で段階表示 |
| isolated worktree 削除 | `/exit` 正常終了後のみ（未コミット変更時はスキップ） | `harness.worktree.*` イベント |

**GitHub monitor poll ハング（accepted risk, #200）**

| 項目 | 内容 |
|------|------|
| 発生条件 | GitHub 監視が有効（デフォルト）で、GitHub API による poll が進行中に `/exit` |
| 症状 | UI は即「終了しています…」になるが、teardown が `githubMonitor.stop()` で `pollInFlight` 待ちになりプロセスが長時間残る（5s 超は abort） |
| 回避策 | `--no-github-monitor` で監視を無効化（[README.md](../README.md)・[harness-events.md](harness-events.md)） |
| 実装 | poll / `stop()` のタイムアウト 5s（#209）。超過時は進行中 API リクエストを abort して teardown 継続 |

自律ループ実行中の `/exit` は `shutdownSignal` abort で driver を抜ける。conductor `send` 進行中でも abort を優先し、完了待ちで固まらない（#200）。

終了 JSON はプロセス終了時のみ stdout（変更なし）。
