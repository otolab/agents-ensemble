# オペレータ入力（SessionView）

> **正本:** TUI とオペレータ入力の利用者向け挙動および SessionView 契約。入力ショートカットの実装詳細は [cli-text-input-keybindings.md](cli-text-input-keybindings.md)、設定の正本は [settings.md](settings.md) です。

ConductorSession の **View 層**契約。入力・表示はここに閉じ、オーケストレーション（Driver）とは `bindOperatorInput` で接続する。

関連: [architecture.md](architecture.md) §5、[ADR 0009](adr/0009-conductor-session-event-queue.md)、[ADR 0014](adr/0014-conductor-dispatch-batch-coalescing.md)、[cli-text-input-keybindings.md](cli-text-input-keybindings.md)（Emacs 風ショートカットの実装階層）、[tui-scrollback-detection.md](tui-scrollback-detection.md)（native scrollback 検出の設計）、Issue #54（TUI）

## 3 層の分担

| 層 | 責務 | 主なモジュール |
|----|------|----------------|
| **SessionPolicy** | dispatch 可否・ループ終了・自律ターン数 | `session-policy.ts` |
| **SessionDriver** | イベントキュー消費・max-turns 登録・`agent.send` | `conductor-session-driver.ts` |
| **SessionView** | TTY Ink TUI / CLI 引数 / env からのオペレータ入力 | CLI `createIssueSessionTuiHost` / `bindAsyncOperatorInput` |

データの正本: **イベントキュー**（`SessionEventQueue`）と **OpenQuestionRegistry**。通常の View 入力は `submit` で `operator.message` をキューへ積む。`/reconnect` と `/exit` は conductor へ送らない専用コマンドとして SessionView の binding で intercept する。TTY の pane / stream は、未回答 open question について `OperatorInputBindingApi.getContext().openQuestions`（Registry の `listOpen()` スナップショット）を表示状態の正本として使う。binding 前の初回描画だけは、イベント reducer の表示 state をフォールバックにする。

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
- `/reconnect` / `reconnect` は `operator.reconnect` をイベントキューへ enqueue し、conductor へは送らない（`true`）
- `/exit` / `exit` は専用の終了 signal として扱い、イベントキューへは enqueue しない（`false`）
- TTY（Ink TUI）では選択中の open question への回答として `submit` する（`targetOpenQuestionId` オプション）
- 非 TTY では未回答 1 件のときはプレーンテキストをその open question への回答として解釈する

View は **ブロックしない**。ループの待機は Driver が `waitForDispatchBatch`（内部で `selectDispatchBatch` + `SessionEventQueue.waitForEvent`）で行う。到着済みの同一メンバーイベントは [ADR 0014](adr/0014-conductor-dispatch-batch-coalescing.md) に従い 1 束にまとめてから `agent.send` する。

### `getContext()`

プロンプト直前の案内（未回答 open question 一覧など）に使う。CLI では `notifyOperatorInputReprompt` 経由で TTY 表示を更新する。

### 戻り値

購読解除関数を返せる（readline close 等）。省略可。

## CLI からの初回オペレータメッセージ

`ensemble issue <ref> [message...]` の残り引数をスペース 1 つで結合し、前後を trim した値を初回メッセージとして扱います。値が空文字または空白だけの場合は、メッセージ未指定として扱います。

```bash
ensemble issue 42 受け入れ条件を確認して実装してください
ensemble issue https://github.com/org/repo/issues/42 "まずテストから始めてください"
```

セッションの operator input binding 直後に `api.submit(message)` を 1 回だけ呼ぶため、TTY（Ink TUI）と非 TTY のどちらでも、手入力を待たずに `operator.message` として conductor へ届きます。TTY では初回メッセージの有無に関わらず通常の binding として扱い、`session.post_loop_wait` から `/exit` まで待機します（`--no-wait` または `session.postLoop.wait: false` を除く）。メッセージ未指定時の TTY 入力の挙動も変わりません。

非 TTY の単発注入は追加入力を提供しないため、終了契約も通常の TTY 入力と異なります。初回メッセージを処理した conductor の `error` は再入力を待たずにエラー終了し、SDK の `cancelled` も terminal status（`stopReason: cancelled`）として終了します。`ask_human` による未回答 open question、または未解決の permission が残った場合も、回答を待つ post-loop へは移らず、その時点でセッションを終了します。dispatch hold 中にこれらの停止条件へ到達した場合も release を待ちません。未回答 question は終了結果・sidecar に残り、未解決 permission は終了処理で拒否されます。TTY の初回メッセージはこの単発終了契約を使わず、post-loop 待機中に追加入力で処理できます。

CLI メッセージと `ENSEMBLE_OPERATOR_MESSAGE` は同時に指定できません。両方が trim 後に空でない場合は、セッション開始前にエラーになります。これは優先順位ではなく併用禁止です。`--continue` または `--resume` で CLI メッセージを指定した場合は注入せず、stderr に 1 行の警告を出します。`ENSEMBLE_OPERATOR_MESSAGE` は従来どおりそのセッションの binding で解決されます。

`--continue` / `--resume` では、sidecar の conductor agent を `Agent.resume` で復元するため、新規セッション用の initial conductor send（system prompt + Issue ブリーフィング）は行いません。復元中の worker から届く `permission.pending` などのイベントはキューに保持され、復元済み conductor への最初の入力として通常どおり dispatch されます。これにより、再開直後に worker が許可待ちになっても、initial send の完了を待たずに `resolve_permission` の判断へ進めます。

## TTY TUI レイアウト

端末ごとの確認済み・未確認・既知制限と、実端末確認結果の更新手順は [TUI 端末互換性マトリクス](tui-terminal-compatibility.md) に記載します。

TTY の既定は `pane` レイアウトです。Workers / Orchestration / Operator input を固定表示し、未回答の open question があるときだけ Open questions ペインをその上に追加します。Orchestration はアプリ内の windowing と `PgUp` / `PgDn` / `End` で操作します。`PgUp` 中に新着 activity log が追記された場合は、表示行数の差分を detached offset に反映して同じログ行を維持します。`End` で最新へ追従します。

`ENSEMBLE_TUI_LAYOUT=stream` または `.ensemble/config.yaml` の `tui.layout: stream` を指定すると、活動ログ（operator / conductor / harness / observation）は Ink の `<Static>` で枠なしに上へ追記され、下部は上から **Open questions（未回答時のみ独立表示）→ Operator input → Workers** の順に固定されます。環境変数は config より優先されます（[settings.md](settings.md)）。未回答の open question がないときは独立枠も空状態本文も描画せず、post-loop 待機中は Operator input に `追加指示を入力するか /reconnect で再接続 · /exit で終了` の prompt を表示します。入力欄は `pane` と同じ `react-ink-textarea` の IME 物理カーソル同期を使い、stream の下部 live frame を座標原点として変換窓の位置を計算します。`stream` では活動ログ用のアプリ内スクロールを持たず、端末の scrollback を使います。非 TTY は常に `pane` 経路です。

Open questions は内容駆動で高さを決めます。選択中 question の `question` と `context` は折り返し後の要求行数として扱い、非選択 question は 1 行の compact 表示として同じ一覧に残します。pane / stream とも、まずこの要求行数に合わせて Open questions 枠を拡大し、通常の 80×24 程度では質問本文と compact 行を読める範囲を確保します。表示上限に達した場合は、非選択 question の compact 行を先に 1 行ずつ確保し、残りを選択中の detail に割り当てます。そのため通常端末では、選択本文が長くても compact 行が実画面から隠れることはありません。端末の高さ、または compact 行を確保した残りの本文上限を超える極端に長い内容は、#321 と同じ非保証の clip 方針です。Open questions ペイン内のスクロールは行いません。

`stream` では、入力欄が空のときの `PgUp`、または入力中の `Ctrl+PgUp` で keyboard detached を宣言します。detached 中の新着 activity log は `<Static>` へ渡さず pending として保持し、Operator input の live frame に `N 件の新着 · End で最新へ` と表示します。入力欄が空のときの `End`、または入力中の `Ctrl+End` で pending を到着順に一度だけ追記して follow に戻ります。通常の detached 経路では既に Static へ渡した prefix の再送・remount・replay は行いません。settled columns shrink の scrollback recovery だけは [ADR 0026](adr/0026-tui-stream-shrink-recovery.md) に従って terminal reset 後に保持済み activity を再出力します。

### 表示出力の inline Markdown subset

活動ログと Open questions の `question` / `context`、および dialogue / observation の端末出力では、次の inline Markdown だけを表示スタイルへ変換します。

| 記法 | TUI | 端末出力 |
|------|-----|----------|
| `**text**` / `__text__` | 太字 | 太字（端末が対応する場合） |
| `` `code` `` | code 風の色 | code 風の色（端末が対応する場合） |
| `[text](url)` | 表示テキストをリンク風に表示。OSC 8 対応時はクリック可能 | 表示テキストだけを表示（URL は出さない） |
| `\*` / `\_` / `` \` `` など | エスケープ後のプレーン文字 | 同左 |

`**`、`` ` ``、リンク表示テキストは相互にネストできます（例: `` **`flag`** ``、`[**bold**](url)`）。箇条書き・番号付きリストは任意段を再帰的に辿り、リスト記号と簡易インデントを保ったまま item 内の inline style を適用します。GFM テーブルも列揃えを変更せず、セル内の inline style だけを適用します。表示幅で折り返された場合も、各行の style とリンク先は `string-width` に合わせて維持されます。

リンクは通常の `[text](url)` 形式だけに対応し、表示テキストから URL を省略します。TTY TUI では、Workers ペインの Issue リンクと同じ `issueLinkMode`（端末判定、`FORCE_HYPERLINK`、`tui.forceHyperlink`）を使い、OSC 8 が有効な場合だけ表示テキストを OSC 8 で包みます。参照リンク `[text][ref]`、自動リンク `<url>`、未対応の見出しなどスコープ外のブロック構造、コードブロックは Markdown として解釈せず、そのまま表示します。HTML を含む入力全体も Markdown として解釈せず、未閉じの code span もプレーン文字列として表示します。

### Operator input の2モード

pane / stream とも、下部の表示は open question の有無で次の2モードに解決されます。

| モード | 条件 | 表示と入力 |
|--------|------|------------|
| **A: question あり** | `getContext().openQuestions.length > 0` | Open questions ペインを表示。Operator input には選択中 question への回答、`Shift+↑↓`、Enter 送信の prompt を表示し、Issue 参照と自律ターン数は表示しない。submit は `targetOpenQuestionId` 付きで送信する。 |
| **B: question なし** | `getContext().openQuestions.length === 0` | Open questions ペインを高さ 0 として省略。Operator input には `任意のタイミングで入力 · /reconnect で再接続 · /exit で終了` の prompt を表示する。通常の submit は operator メッセージとして送信する。 |

resume で sidecar の未回答 question を復元した場合も、`getContext()` が同じ Registry から一覧を返すため、binding 後の pane / stream はモード A として表示する。表示 reducer の `openQuestions` は live event と binding 前フォールバック用の投影であり、resume 後の判定・選択・submit target は Registry スナップショットと一致する binding context を使う。

post-loop 待機中はモード B の prompt を `追加指示を入力するか /reconnect で再接続 · /exit で終了` に上書きします。終了中は `終了しています…` を表示して入力を無効化します。Operator input には session status（Issue 参照、post-loop 待機など）を載せず、Workers ペイン上枠の右端に Issue リンクを表示します。

`stream` の mouse-only scrollbar / native scrollback 操作は、terminal host から viewport state が TTY へ通知されないため keyboard detached として自動検出できません。保護が必要な場合は `PgUp` / `Ctrl+PgUp` で detached を宣言し、`End` / `Ctrl+End` で復帰します。通常の幅変更では既に Static として追記された行は再折り返しされませんが、settled columns shrink では [ADR 0026](adr/0026-tui-stream-shrink-recovery.md) に従って scrollback を reset し、保持済み activity history を新幅で再出力します。

TTY の pane / stream は、Ink の resize 通知を通常 100ms の settle window にまとめ、columns の連続した縮小では**最後の縮小イベントから 250ms**の quiet-period が終わるまで中間幅の live frame 更新を保留します。この時間は最初の縮小イベントからの絶対上限ではありません。TUI の `terminalSizeStore` は settled した実際の端末幅を使って幅・高さ・live frame と IME cursor の座標を再計算します。一方、Ink に渡す stdout proxy の `columns` は縮小中の high-water mark を保ち、幅が増えたときに更新します（`rows` も既存どおり high-water mark）。そのため、縮小後は Ink の viewport と TUI の実幅が意図的に異なることがあります。pane は Ink の fullscreen clear 分岐を避けるため live frame の末尾 1 行を安全余白として予約し、最終サイズで再レイアウトします。固定ペインの余剰行は短い端末で先に縮め、Orchestration はタイトル上枠と下枠を保てる最小 2 行まで compact します。これにより 60×12（live frame 11 行）への resize でも、no-question モードは各ペインのタイトル・上下枠と Operator input 行を維持します。さらに短い端末ではログ・Worker 状態・open question 本文がクリップされることがあり、全ペインの本文表示は保証しません。

stream の settled な columns shrink では、Ink の論理フレームと端末/tmux の物理折り返しを再同期するため、端末の primary screen と scrollback を CSI 3J / CSI 2J / CSI H で一度 reset し、view model に保持した activity history を Static から一度だけ書き直します。通常の activity append、grow、height change では reset や replay を行いません。stream の activity history は全件保持されるため内容は再表示されますが、reset 前の native scrollback の位置・連続性は失われます。pane は bounded activity window を使うためこの recovery を適用せず、既追記行の再折り返しと mouse-only native scrollback の自動保護は引き続き非対応です。

この resize workaround の意図、Ink upstream との関係、撤去条件は [ADR 0024](adr/0024-tui-shrink-coalesce.md) と [ADR 0026](adr/0026-tui-stream-shrink-recovery.md) に、Ink / React 更新時の回帰確認は [Ink / React アップグレード回帰手順](tui-ink-upgrade.md) に記載します。従来の settle と rows high-water mark の判断履歴は [ADR 0022](adr/0022-tui-resize-workaround.md) に残しています。

## 実装例

| 環境 | 実装 | ファイル |
|------|------|----------|
| TTY（本番 CLI） | `createIssueSessionTuiHost`（Ink `pane` / `stream` + 入力欄） | `packages/cli/src/tui/create-issue-session-tui-host.tsx` |
| TTY + 有効な CLI 初回メッセージ（新規セッション） | `createIssueSessionTuiHost`（CLI メッセージを 1 回 submit） | `packages/cli/src/tui/create-issue-session-tui-host.tsx` |
| 非 TTY + 有効な CLI 初回メッセージ（新規セッション） / `ENSEMBLE_OPERATOR_MESSAGE` | `bindAsyncOperatorInput`（指定値を 1 回 submit） | `packages/cli/src/async-operator-input.ts` |
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
- 未回答 open question があるときのループ継続（TTY の通常 binding では open question がある間は停止しない。非 TTY の単発注入では回答を待たずに停止する）
- ループ終了条件

## CLI: 自律ターン上限

| 条件 | デフォルト |
|------|-----------|
| TTY、または有効な CLI 初回メッセージ / `ENSEMBLE_OPERATOR_MESSAGE` あり | 無制限 |
| 非 TTY / CI で有効な単発メッセージなし（`--continue` / `--resume` で CLI メッセージだけを指定した場合を含む。binding なし） | 5 |

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

自律ループ停止後、CLI TTY デフォルトでは harness が **post-loop 待機** に入る（[ADR 0013](adr/0013-process-lifecycle-vs-autonomous-loop.md)、初回メッセージの分類は [ADR 0023](adr/0023-tty-initial-message-post-loop.md)）。この間も SessionDriver は停止せず、イベントキューで次の dispatch を待つ。`session.post_loop_wait` は待機 UX の開始通知であり、イベント配送を止める合図ではない。

| 条件 | 動作 |
|------|------|
| TTY + デフォルト（有効な初回メッセージの有無に関わらず。`--continue` / `--resume` で CLI メッセージを無視した場合を含む） | 自律ループ停止後も `operator>` を維持。`/exit` でプロセス終了 |
| 非 TTY / CI + 有効な CLI 初回メッセージ（新規セッション） / `ENSEMBLE_OPERATOR_MESSAGE` | binding 直後に 1 回注入し、post-loop 待機なしで終了 |
| `--no-wait` | 自律ループ停止後に即終了（従来動作） |
| 非 TTY / CI かつ有効な単発メッセージなし（`--continue` / `--resume` で CLI メッセージだけを指定した場合を含む） | `waitForOperatorExit` なし → 即終了 |
| post-loop 中の TTY 追加入力 | `operator.message` としてキューに積み、継続中の SessionDriver が処理 |
| post-loop 中の GitHub 更新 | `issue.comment` / `pr.review` / `pr.review_comment` / `ci.completed` を `github.update` として enqueue し、継続中の SessionDriver が処理（[harness-events.md](harness-events.md) §3） |

**post-loop 中の dispatch と max-turns**

| イベント | ターン残あり | max-turns 到達後 |
|----------|------------|----------------|
| `operator.message` | dispatch。オペレータ入力として自律ターン数をリセット | dispatch（`operator.message` は常に許可） |
| `operator.reconnect` | dispatch。直近の send 完了後に conductor を close → `resume(sameId)`。worker / worktree / プロセスは変更しない | conductor へメッセージとして送らない。max-turns 到達後も許可 |
| `permission.pending` | dispatch | dispatch（permission 判断を優先） |
| `github.update` | dispatch。状況把握ターンとして自律ターンを 1 消費 | enqueue のみ。dispatch しない |

自律ループ稼働中（post-loop 前）も同じ経路で処理する。GitHub 更新の種類による `notifyResume` 条件分岐は持たない（#160）。

### `/reconnect` — conductor transport の手動再接続

`/reconnect` または `reconnect`（大文字小文字無視・前後空白トリム）は、conductor との対話に載せない専用コマンドです。直近の `conductor.send` が完了（成功・エラーを含む）した後、現在の agent を `close` し、同じ `agentId` で `resume` します。再接続そのものは prompt を再送せず、次の operator 入力や worker/GitHub 通知から新しい agent を使います。worker、worktree、プロセスは触りません。

成功・失敗は `conductor.transport.reconnect` として harness / observation に表示されます。失敗してもセッションは継続し、もう一度 `/reconnect` または通常の入力を受け付けます。send 中の in-flight 中断は行いません。

Connection stalled が自動再接続後も続く場合は `/reconnect` を試してください。暫定回避策は Ctrl+C で終了して `--resume <agentId>` で再開することです。`/exit` は isolated worktree を削除することがあるため、worktree を残したい場合は `/exit` ではなく `/reconnect` または Ctrl+C + `--resume` を使います。

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
| 回避策 | `--no-github-monitor` で監視を無効化（[cli/README.md](cli/README.md)・[harness-events.md](harness-events.md)） |
| 実装 | poll / `stop()` のタイムアウト 5s（#209）。超過時は進行中 API リクエストを abort して teardown 継続 |

自律ループ実行中の `/exit` は `shutdownSignal` abort で driver を抜ける。conductor `send` 進行中でも abort を優先し、完了待ちで固まらない（#200）。

終了 JSON はプロセス終了時のみ stdout（変更なし）。
