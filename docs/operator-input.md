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

データの正本: **イベントキュー**（`SessionEventQueue`）と **OpenQuestionRegistry**。通常の View 入力は `submit` で `operator.message` をキューへ積む。`/reconnect`、`/close`、`/exit` は conductor へ送らない専用コマンドとして SessionView の binding で intercept する。TTY の pane / stream は、未回答 open question について `OperatorInputBindingApi.getContext().openQuestions`（Registry の `listOpen()` スナップショット）を表示状態の正本として使う。binding 前の初回描画だけは、イベント reducer の表示 state をフォールバックにする。

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
  submit: (
    message: string,
    options?: { targetOpenQuestionId?: string; delivery?: 'idle' | 'next' | 'interrupt' },
  ) => boolean;
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
- `/close` / `close` は専用の終了 signal として扱い、イベントキューへは enqueue しない（`false`）。SessionResumeStore を flush して worker / conductor / GitHub monitor を停止し、worktree を残してプロセスを終了する
- `/exit` / `exit` は専用の終了 signal として扱い、イベントキューへは enqueue しない（`false`）
- TTY の通常入力は配信モード prefix を付けられる。`/idle ...`、`/next ...`、`/interrupt ...` を本文先頭に置き、prefix 自体は conductor へ送らない。prefix なしは `next`
- TTY（Ink TUI）では選択中の open question への回答として `submit` する（`targetOpenQuestionId` オプション）
- 非 TTY では未回答 1 件のときはプレーンテキストをその open question への回答として解釈する
- `choice` の選択肢は回答を簡潔にするための候補で、オペレータは自由記述でも回答できる。選択肢 ID / 一意な label / 候補順の 1 始まり番号に一意に解決できる入力には `selectedChoice` を記録し、それ以外は回答全文を保存して `selectedChoice` を付けない。重複する label は自由記述として記録し、候補を推測しない。TTY の Open questions ペインには選択肢を表示する
- `yes_no` の回答は原文と `assent: yes | no | unclear` を記録する。判定できない回答は否定にせず `unclear` とし、`approved` は permission に関連付けた質問に限って明確な assent から導出する

### オペレータメッセージの配信モード

`operator.message` は `delivery?: 'idle' | 'next' | 'interrupt'` を持ち、省略時は `next` として扱います。SessionLogEvent の `operator.input` にも解決後のモードを記録し、TTY 活動ログでは本文の前に `[idle]` / `[next]` / `[interrupt]` を表示します。

| モード | 動作 |
|--------|------|
| `next`（既定） | 現行どおり、次に選ばれる dispatch で最優先に送る。進行中の `agent.send` は完了を待つ |
| `idle` | キューには積むが、conductor の send 中、worker が動作中、または送信可能な自律イベントが残っている間は選ばない。dispatch hold 自体は待機理由にならず、hold 中は held buffer のイベントがあっても送信できる。hold 解放後に送信可能な held event が残っている場合は、その flush / dispatch を先に行う |
| `interrupt` | 進行中の conductor run の cancel を試してから送る。cancel が使えない・失敗した場合は警告を記録し、`next` と同じ次回 dispatch にフォールバックする（[#86](https://github.com/otolab/agents-ensemble/issues/86) の最小経路） |

`idle` はセッション終了まで保留する指定ではありません。TTY の post-loop 待機中は Driver が動作を続けており、worker や送信可能なイベントがなければ dispatch されます。max-turns 到達後も operator 入力は dispatch 可能です。実行中 worker があればその終了を待ち、worker event が max-turns で送れない状態まで来たら operator message を先に届けて上限をリセットします。dispatch hold 中も operator message は held buffer に入らず、hold の有効中であること自体は `idle` を止めません。そのため、worker と通常 queue の送信可能イベントがなければ、held buffer に自律イベントが残っていても `idle` message は hold を貫通して送られます。hold 解放後は送信可能な held event を先に flush / dispatch し、残った `idle` message はその処理後に送ります。Open Question 回答経路は引き続き `next` 固定です。

operator-agent は `send_operator_message` tool から稼働中 session の UDS control API へ `text` と任意の `delivery` を渡せます。省略時は `next` です。wire schema とエラー応答は [稼働中 harness control API reference](live-open-question-control-api.md) を参照してください。

### 稼働中 harness の UDS control

稼働中 harness の UDS interface は、Open Question の一覧・回答、watch 用 `session.observe` snapshot、conductor 宛て `operator.message.send`、最後の conductor 成功応答の取得を提供します。watch pool は `session.observe` が到達不能または旧 harness で未対応なら、Open Questions YAML / session-state YAML / SessionResumeStore に保存された情報を読みます。一方、Open Question の個別操作、message 送信、`get_last_conductor_message` は SessionResumeStore に記録された `harnessSocketPath` へ直接接続し、停止・接続不能時はエラーで、保存済み情報へ fallback しません。最後の成功応答がまだなければ `message: null` です。通常 message は Open Question の回答から独立し、queue acknowledgment は処理完了を意味しません。wire schema、answer semantics、response、error / unknown outcome、security と運用時の対処は [稼働中 harness control API reference](live-open-question-control-api.md) を参照してください。

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

セッションの operator input binding 直後に `api.submit(message)` を 1 回だけ呼ぶため、TTY（Ink TUI）と非 TTY のどちらでも、手入力を待たずに `operator.message` として conductor へ届きます。TTY では初回メッセージの有無に関わらず通常の binding として扱い、`session.post_loop_wait` から `/close` または `/exit` まで待機します（`--no-wait` または `session.postLoop.wait: false` を除く）。メッセージ未指定時の TTY 入力の挙動も変わりません。

非 TTY の単発注入は追加入力を提供しないため、終了契約も通常の TTY 入力と異なります。初回メッセージを処理した conductor の `error` は再入力を待たずにエラー終了し、SDK の `cancelled` も terminal status（`stopReason: cancelled`）として終了します。`ask_human` による未回答 open question、または未解決の permission が残った場合も、回答を待つ post-loop へは移らず、その時点でセッションを終了します。dispatch hold 中にこれらの停止条件へ到達した場合も release を待ちません。未回答 question は終了結果と Open Question YAML に残り、移行期間中は SessionResumeStore にも同じ snapshot を保存します。未解決 permission は終了処理で拒否されます。TTY の初回メッセージはこの単発終了契約を使わず、post-loop 待機中に追加入力で処理できます。

CLI メッセージと `ENSEMBLE_OPERATOR_MESSAGE` は同時に指定できません。両方が trim 後に空でない場合は、セッション開始前にエラーになります。これは優先順位ではなく併用禁止です。`--continue` または `--resume` で CLI メッセージを指定した場合は注入せず、stderr に 1 行の警告を出します。`ENSEMBLE_OPERATOR_MESSAGE` は従来どおりそのセッションの binding で解決されます。

`--continue` / `--resume` では、SessionResumeStore に記録された conductor agent を `Agent.resume` で復元するため、新規セッション用の initial conductor send（system prompt + Issue ブリーフィング）は行いません。復元中の worker から届く `permission.pending` などのイベントはキューに保持され、復元済み conductor への最初の入力として通常どおり dispatch されます。これにより、再開直後に worker が許可待ちになっても、initial send の完了を待たずに `resolve_permission` の判断へ進めます。

## operator-agent の会話中の監視 hold

`ensemble operator-agent` では、空でない通常の TTY 入力を受け取った時点で会話 hold を有効にし、登録済み session の自動 watch report が operator-agent の LLM に割り込まないようにします。watch pool の登録や polling は止めず、会話中に得た report は queue に保留します。user 入力は通常どおり最優先で dispatch され、明示的な `send_operator_message` もこの hold の対象外です。既に開始した `agent.send` は取り消しません。

operator-agent の応答が `finished` / `completed` で返り、次の user 入力が queue に残っていなければ会話 hold を自動解除します。応答中に次の user 入力が届いている場合は hold を維持し、その入力への応答が完了して queue が空になった時点で解除します。send が完了扱いにならなかった場合は自動解除せず、TTY の `/resume-watch` で会話 hold だけを手動解除できます。このコマンドは agent に送られず、解除後の次の通常入力で会話 hold が再び有効になります。

`set_report_hold({ hold: true })` / `release_reports` による手動 report hold は会話 hold と独立しています。どちらか一方が有効なら report を保留し、両方が解除されたときに保留分を既存の batching 規則で dispatch queue に戻します。`/resume-watch` は手動 report hold を解除しません。TTY には `監視報告保留中（会話・手動 / N 件）` のように hold の理由と保留件数を表示し、会話 hold の解除時に dispatch queue へ戻した報告数も知らせます。

## TTY TUI レイアウト

端末ごとの確認済み・未確認・既知制限と、実端末確認結果の更新手順は [TUI 端末互換性マトリクス](tui-terminal-compatibility.md) に記載します。

TTY の既定は `stream` レイアウトです。従来のペイン分割を使う場合は `.ensemble/config.yaml` に `tui.layout: pane`、または `ENSEMBLE_TUI_LAYOUT=pane` を指定します。環境変数は config より優先されます（[settings.md](settings.md)）。非 TTY は常に `pane` 経路です。

長時間 TTY セッションでは Ink / React の再描画に伴って Node の User Timing（measure / mark）が蓄積し、約 100 万件に達すると `MaxPerformanceEntryBufferExceededWarning` が出ることがあります。pane / stream 共通の TUI host は稼働中 30 秒ごとに `performance.clearMeasures()` と `performance.clearMarks()` を呼び、終了時にタイマーを解除します。クリアに失敗しても描画は継続します。Node の performance バッファはプロセス共通のため、この処理では同じプロセス内の他の measure / mark も消去されます。

既定の `stream` レイアウトでは、活動ログ（operator / conductor / harness / observation）は Ink の `<Static>` で枠なしに上へ追記され、下部は上から **Open questions（未回答時のみ独立表示）→ Operator input → Workers** の順に固定されます。未回答の open question がないときは独立枠も空状態本文も描画しません。入力欄は `pane` と同じ `react-ink-textarea` の IME 物理カーソル同期を使い、stream の下部 live frame を座標原点として変換窓の位置を計算します。`stream` では活動ログ用のアプリ内スクロールを持たず、端末の scrollback を使います。scrollback 閲覧中に新着ログで末尾へ戻る場合があり、通常の幅変更では既追記行は再折り返しされません（詳細は [ADR 0015](adr/0015-cli-tui-library.md)）。

question がないときの pane / stream の Operator input は、通常時・post-loop 待機中とも固定案内を出さず入力欄を表示します。TTY の pane / stream では `/` 入力時にコマンド候補を表示します。stream の scrollback 閲覧中に保留した新着がある場合は、その件数と `End` による復帰案内を引き続き表示します。question があるときの選択・回答案内と、終了処理中の `終了しています…` も表示します。この変更は TTY の pane / stream に限り、readline 経路の1行案内にあるコマンド一覧は維持します。非 TTY では対話入力を開かず、CLI / env の初回メッセージがあれば従来どおり1回だけ送信します。

`pane` では Workers / Orchestration / Operator input を固定表示し、未回答の open question があるときだけ Open questions ペインをその上に追加します。Orchestration はアプリ内の windowing と `PgUp` / `PgDn` / `End` で操作します。`PgUp` 中に新着 activity log が追記された場合は、表示行数の差分を detached offset に反映して同じログ行を維持します。`End` で最新へ追従します。

Workers ペインの高さは内容駆動です。conductor と登録 worker の各状態行、または worker 未登録時の待機表示に合わせて高さを取り、端末内では Open questions・Operator input と Orchestration の最低高さを保てる範囲が上限になります。短い端末や worker 数が多い場合、枠に収まらない状態行はクリップされます。Workers ペイン内のスクロールは行いません。

活動ログは投稿本文の明示的な改行と段落間の空行を表示行として保ち、端末幅に合わせて各行を折り返します。複数行の投稿ではラベルを独立行に置き、本文を次の行から表示します。これは pane と stream の両方に適用されます。pane は可視行数を超えた過去ログをスクロールで確認でき、stream は端末 scrollback に追記します。

Open questions は内容駆動で高さを決めます。選択中 question の `question` / `context` / `choices` は、それぞれ明示的な改行・段落・リスト構造を保って折り返し、全表示行を保持します。非選択 question は question、context、choices の順に最大 2 行まで表示し、続きがある場合は 2 行目の末尾に `…` を付けます。pane / stream とも、まず compact 行を確保し、残りを選択中の detail に割り当てます。通常の 80×24 程度では質問本文と compact 行を読める範囲を確保します。選択中の detail が表示領域を超える場合は、本文を表示行単位で windowing します。Ctrl と Meta を付けない `Shift+PgUp/PgDn` で選択中 question の本文を 1 表示行ずつ上下にスクロールし、タイトルに操作キーと上下の続きがある方向を示します（Ink の `key.meta` には Alt も正規化されます）。このキーは Open questions が表示されている間、活動ログ操作より優先します。pane では plain `PgUp/PgDn`（入力欄が空のとき）と `Ctrl+PgUp/PgDn`（入力欄の内容を問わず）が活動ログ用に残ります。stream では `PgUp`（入力欄が空のとき）または `Ctrl+PgUp` で scrollback を離れ、`End`（入力欄が空のとき）または `Ctrl+End` で最新へ戻ります。質問を `Shift+↑/↓` で切り替えると本文 offset は先頭へ戻ります。

`stream` では、入力欄が空のときの `PgUp`、または入力中の `Ctrl+PgUp` で keyboard detached を宣言します。detached 中の新着 activity log は `<Static>` へ渡さず pending として保持し、Operator input の live frame に `N 件の新着 · End で最新へ` と表示します。入力欄が空のときの `End`、または入力中の `Ctrl+End` で pending を到着順に一度だけ追記して follow に戻ります。通常の detached 経路では既に Static へ渡した prefix の再送・remount・replay は行いません。settled columns shrink の scrollback recovery だけは [ADR 0026](adr/0026-tui-stream-shrink-recovery.md) に従って terminal reset 後に保持済み activity を再出力します。

TTY の pane / stream では、入力が単一行の slash コマンド prefix の間、Operator input ペイン内に候補と短い説明を表示します。先頭の空白またはタブは無視し、`/` に続く名前を大文字小文字を区別せず prefix 一致で絞り込みます（例: `/ex` は `/exit`、`/cl` は `/close`）。オペレータ入力で専用処理されるコマンドだけを候補に出し、別名は表示しません。

TTY の Ink pane / stream にある Operator input 欄の行頭には `> ` を表示します。ペインタイトルで入力者が分かるため、行頭に `operator` は重ねて表示しません。Ink を使わない TTY 継続入力（`bindAsyncOperatorInput`）では `operator> ` を維持します。非 TTY では対話 readline を開きません。また、非 TUI の stdout 対話ログに付く `operator>` / `conductor>` は入力プロンプトではなく話者ラベルのため、この変更の対象外です。

候補が出ると先頭の候補が選択状態になり、`›` と強調表示で分かります。plain `↑/↓` で選択を移動し、一覧の先頭・末尾ではそれ以上移動しません。入力内容を編集すると先頭候補が選び直されます。Open questions が表示されているときは `Shift+PgUp/PgDn` が本文スクロールを最優先し、`Shift+↑/↓` は質問選択に使います。これらの操作は slash 候補・回答候補の表示中も同じです。修飾なしの上下矢印は slash 候補、回答候補、textarea のカーソル操作の順に扱います。slash 候補の Tab は選択中のコマンド名で入力欄全体を置き換え、入力カーソルを末尾へ移しますが、送信はしません。Enter を押すと入力欄の内容を従来どおり submit します。Shift+Tab は補完しません。

候補がない入力、通常の入力、複数行入力では、上下矢印を含む既存の textarea 操作を使います。候補は、候補名の prefix として一致しない slash 付き本文や複数行入力には表示しません。IME 物理カーソルは従来どおり入力欄の caret に追従します。

モード A では、選択中の Open Question が `choice`（選択肢が 1 件以上）または `yes_no` のとき、入力欄が単一行であれば回答候補も表示します。入力が空なら全候補を表示し、入力があれば大文字小文字を区別せず prefix で絞り込みます。`choice` は ID・label・候補順の 1 始まり番号で絞り込み、Enter で補完すると ID が入力欄に入ります。`yes_no` は `yes — はい` / `no — いいえ` を表示し、英語または日本語の prefix で絞り込みます。補完値は `yes` / `no` です。`text` の質問と非 TTY 入力には回答候補を表示しません。

回答候補の plain `↑/↓` は候補選択に使い、`Shift+↑/↓` は従来どおり質問選択に使います。`Shift+PgUp/PgDn` は候補より優先して選択中本文をスクロールします。slash 入力では slash 候補を優先し、回答候補と同時には表示しません。回答候補が表示中の Enter は選択候補を入力欄へ補完するだけで送信しません。候補を補完した後の Enter は、従来どおり選択中の質問 ID を付けて送信します。Tab も回答候補の補完に使えます。補完後は候補表示を閉じ、追記で入力が変わると prefix に応じて再表示します。

回答の意味付けは既存 core の規則に従います。choice の `selectedChoice` は回答全文が ID・一意な label・候補順の番号に解決できる場合だけ記録され、理由などを追記した回答は従来どおり自由記述として扱われます。yes/no も回答全文から assent を判定し、判定できない追記付き回答は `unclear` になります。

### TTY Operator input の送信履歴

TTY の pane / stream では、Enter で送信した入力をセッション中の履歴として保持します。入力欄の先頭 visual row にカーソルがあるときの `↑` で古い履歴を呼び出し、末尾 visual row にあるときの `↓` で新しい履歴へ進みます。いちばん新しい履歴からさらに `↓` を押すと、履歴を呼び出す前に書いていた未送信ドラフトへ戻ります。

履歴から呼び出した入力を編集して Enter で送信すると、その内容を新しい履歴として先頭に追加します。元の履歴行は変更されず、送信後に `↓` を押せば呼び出し前のドラフトへ戻れます。履歴はその TTY セッション内だけで有効です。

候補表示中の `↑` / `↓` は slash コマンドまたは回答候補の選択を優先し、未回答 open question があるときの `Shift+↑/↓` は質問選択を優先します。複数行入力では、先頭・末尾 visual row に達するまでは `↑` / `↓` でカーソルを移動します。`Ctrl+p/n` は従来どおり visual row の上下移動で、履歴には使いません。キーごとの優先順位は [CLI / TUI の標準ショートカット](cli-text-input-keybindings.md) を参照してください。

### 表示出力の inline Markdown subset

活動ログと Open questions の `question` / `context` / `choices`、および dialogue / observation の端末出力では、次の inline Markdown だけを表示スタイルへ変換します。

| 記法 | TUI | 端末出力 |
|------|-----|----------|
| `**text**` / `__text__` | 太字 | 太字（端末が対応する場合） |
| `` `code` `` | code 風の色 | code 風の色（端末が対応する場合） |
| `[text](url)` | 表示テキストをリンク風に表示。OSC 8 対応時はクリック可能 | 表示テキストだけを表示（URL は出さない） |
| `\*` / `\_` / `` \` `` など | エスケープ後のプレーン文字 | 同左 |

`**`、`` ` ``、リンク表示テキストは相互にネストできます（例: `` **`flag`** ``、`[**bold**](url)`）。明示的な改行と段落間の空行は表示行に保たれます。箇条書き・番号付きリストは任意段を再帰的に辿り、リスト記号と簡易インデントを保ったまま item 内の inline style を適用します。GFM テーブルも列揃えを変更せず、セル内の inline style だけを適用します。表示幅で折り返された場合も、各行の style とリンク先は `string-width` に合わせて維持されます。

リンクは通常の `[text](url)` 形式だけに対応し、表示テキストから URL を省略します。TTY TUI では、Workers ペインの Issue リンクと同じ `issueLinkMode`（端末判定、`FORCE_HYPERLINK`、`tui.forceHyperlink`）を使い、OSC 8 が有効な場合だけ表示テキストを OSC 8 で包みます。参照リンク `[text][ref]`、自動リンク `<url>`、未対応の見出しなどスコープ外のブロック構造、コードブロックは Markdown として解釈せず、そのまま表示します。HTML を含む入力全体も Markdown として解釈せず、未閉じの code span もプレーン文字列として表示します。

### Operator input の2モード

pane / stream とも、下部の表示は open question の有無で次の2モードに解決されます。

| モード | 条件 | 表示と入力 |
|--------|------|------------|
| **A: question あり** | `getContext().openQuestions.length > 0` | Open questions ペインを表示。Operator input には選択中 question への回答、`Shift+↑↓`、Enter 送信の prompt を表示し、Issue 参照と自律ターン数は表示しない。choice / yes_no の回答候補が表示中は最初の Enter で補完し、次の Enter で `targetOpenQuestionId` 付き送信を行う。 |
| **B: question なし** | `getContext().openQuestions.length === 0` | Open questions ペインを高さ 0 として省略。Operator input は固定案内を出さず、入力欄だけを表示する。通常の submit は operator メッセージとして送信する。 |

`--continue` / `--resume` では、`open-questions.yaml` があればその YAML を正本として Registry を復元し、YAML がまだない旧形式の session に限って SessionResumeStore の `openQuestions` / `sequence` から復元して YAML をバックフィルします。YAML が存在する場合に読み取り・検証に失敗したら resume を中止し、SessionResumeStore にはフォールバックしません。復元後は `getContext()` が同じ Registry から未回答 question の一覧を返すため、binding 後の pane / stream はモード A として表示します。表示 reducer の `openQuestions` は live event と binding 前フォールバック用の投影であり、resume 後の判定・選択・submit target は Registry スナップショットと一致する binding context を使います。

post-loop 待機中も Operator input はモード B と同じく入力欄だけを表示します。終了中は入力を無効化し、`終了しています…` を表示します。Operator input には session status（Issue 参照、post-loop 待機など）を載せず、Workers ペイン上枠の右端に Issue リンクを表示します。

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
| TTY + デフォルト（有効な初回メッセージの有無に関わらず。`--continue` / `--resume` で CLI メッセージを無視した場合を含む） | 自律ループ停止後も Ink pane / stream の入力欄に `> ` を表示。`/close` または `/exit` で teardown 後にプロセス終了 |
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
| `permission.stall` | dispatch（低優先度。`operator.message` / `permission.pending` を先に選択） | dispatch（permission 回復用の例外。`operator.message` / `permission.pending` の後） |
| `github.update` | dispatch。状況把握ターンとして自律ターンを 1 消費 | enqueue のみ。dispatch しない |

自律ループ稼働中（post-loop 前）も同じ経路で処理する。GitHub 更新の種類による `notifyResume` 条件分岐は持たない（#160）。

### `/reconnect` — conductor transport の手動再接続

`/reconnect` または `reconnect`（大文字小文字無視・前後空白トリム）は、conductor との対話に載せない専用コマンドです。直近の `conductor.send` が完了（成功・エラーを含む）した後、現在の agent を `close` し、同じ `agentId` で `resume` します。再接続そのものは prompt を再送せず、次の operator 入力や worker/GitHub 通知から新しい agent を使います。worker、worktree、プロセスは触りません。

成功・失敗は `conductor.transport.reconnect` として harness / observation に表示されます。失敗してもセッションは継続し、もう一度 `/reconnect` または通常の入力を受け付けます。send 中の in-flight 中断は行いません。

Connection stalled が自動再接続後も続く場合は `/reconnect` を試してください。worktree を残したままプロセスを終了するには `/close` を使います（次節）。Ctrl+C も cleanup を行いませんが、終了結果は `interrupted` になります。`/exit` は isolated worktree の cleanup を試みます。プロセスを維持したまま conductor を再接続する場合は `/reconnect` を使います。

### `/close` — worktree を残してセッションを閉じる

`/close` または `close`（大文字小文字無視・前後空白トリム）は、conductor に送らない一時終了コマンドです。入力直後に `session.operator_close` を emit し、force teardown で処理中 worker prompt を停止して未解決 permission を deny します。attach 済み worker の ACP session ID と cwd は、初回 prompt が完了する前でも runtime の接続一覧から snapshot します。GitHub monitor を停止して最新 cursor と未配送 outbox を SessionResumeStore に flush した後、worker と conductor を force stop し、TUI を dispose してプロセスを終了します。正常に完了した `/close` は exit code 0 です。

SessionResumeStore には conductor agent ID、worker ACP session ID / cwd、profile、GitHub monitor cursor / pending update などを保存します。Open Question の正本は `.ensemble/sessions/{conductorAgentId}/open-questions.yaml` です。version 1 の YAML に `sequence` と open / answered を含む全 `openQuestions` を保存し、移行期間中は `.ensemble/sessions/{conductorAgentId}.json` にも同じ snapshot を書きます。flush は YAML を先に保存してから SessionResumeStore を更新するため、2 ファイルをまたぐ transaction ではありません。YAML の保存に失敗した場合は SessionResumeStore も更新せず、warning を表示します。2 ファイルの内容が異なる場合、`--continue` / `--resume` では YAML があれば YAML を採用します。YAML がまだない旧形式のセッションに限り SessionResumeStore から復元して YAML をバックフィルし、不正な YAML は古い保存状態へ fallback せず resume を失敗させます。worktree path は保存せず、同じ Issue の `issueUrl` と `repoRoot` から再導出します。`--continue` は既存 conductor ID を使い、保存済み worker ACP session ID / cwd が整合すれば `session/load` します。保存 session を load できない場合は新しい ACP session と bootstrap prompt にフォールバックし、以前の worker transcript は復元されません。

`report_session_state` の最新 1 行は `.ensemble/sessions/{conductorAgentId}/session-state.yaml` に報告時刻とともに atomic rename で保存し、過去の報告も最大 50 件・ファイル全体 16 KiB まで保持します。`list_operator_sessions` は最新値のほか `statusLineHistory` を古い順に返します。異なる conductor agent ID は、同じ Issue のセッションでも別の状態として一覧に残ります。

SessionResumeStore は、conductor send / worker prompt の in-flight がある間 `harnessPhase: running`、両方が idle の状態を250ms保った後 `idle` を保存します。phase 開始は即時に flush し、idle だけ debounce します。`/close` は teardown 完了後に `close`、`/exit` は worktree cleanup 試行後に `exit`、SIGINT / SIGTERM は `abort` を最終 flush します。terminal phase は後続 flush で上書きしません。従来の `lifecycle` も移行期の読み取り互換のため書き続け、`closed` / `exited` / `interrupted` / `unknown` の値を保ちます。旧形式は `closed→close`、`exited→exit`、`interrupted→abort` と読み替えます。通常の非TTY終了は `harnessPhase` / `modifiedAt` を持たず、`lifecycle: unknown` として扱います。

`modifiedAt` は harness が SessionResumeStore を保存するたび `updatedAt` と同じ時刻へ更新します。operator 向け statusLine の `reportedAt` は別の報告時刻です。`list_operator_sessions` は一覧取得ごとの UDS probe を行わず、watch pool が直近10秒以内に観測した場合だけ `live.connectivity` に結果を載せます。watch がない場合の `unknown` は未確認を示し、停止中を意味しません。`running` / `idle` の到達不能がwatch上で30秒続くと `coherence: conflict` にし、それより短い場合や live 観測がない場合は `insufficient_data` とします。`close` / `abort` は `resume`、`exit` は `purge` の候補ですが、自動削除はしません。terminal phase と `reachable` の同時観測も conflict です。

`--continue` は同じ Issue の `close` / `abort` を優先し、`exit` を候補から外します。優先候補がなければ `exit` 以外で `updatedAt` が最新の SessionResumeStore を選びます。これは `--resume` で exit 済み instance を明示指定する挙動は変更しません。

`tool_call` / `tool_call_update` から累積した snapshot は、SessionResumeStore とは別の `.ensemble/sessions/{conductorAgentId}.tool-calls` に保存し、`--continue` / `--resume` 後の permission brief と `get_tool_call` で再利用します。履歴が無い旧 session、読めないファイル、不正な entry は履歴なしとして扱うため、tool-call 履歴の問題だけで session resume が失敗することはありません。履歴は最終更新から 30 日、最大 1,000 件かつ 8 MiB まで保持し、上限時は古い snapshot を削除します。1 件で上限を超える snapshot は保存しません。終了時に flush しますが、予期しないプロセス終了では最後の flush 以降が失われる場合があります。

履歴ファイルはローカルに平文で置かれ、path、command、tool input などを含む可能性があります。`.ensemble/` は gitignore 対象で、ファイル自体は Issue / PR や終了 JSON に含めませんが、再開後に permission brief や `get_tool_call` で conductor へ渡した内容は、選択中 backend の会話に含まれる場合があります。履歴を早期削除するには対象の `.tool-calls` ファイルを削除してください。

GitHub update は conductor send が `finished` で完了した後に限って outbox から ack します。`/close` と send 完了が競合すると、send が完了しても close 中は ack せず、`--continue` 後に再配送します。ack 後に cursor を SessionResumeStore へ flush する前の crash でも重複することがあり、配送は at-least-once です。終了時の YAML / SessionResumeStore の flush は best effort で、失敗時は終了経路にかかわらず warning を表示して終了を続けます。直近の更新や Open Question が保存されず、以前の状態から再開するか、有効な SessionResumeStore がなければ再開できない場合があります。in-flight conductor send と teardown で deny した permission は保存・再開しません（[ADR 0011](adr/0011-session-sidecar-resume.md)、[ADR 0017](adr/0017-conductor-send-lifecycle-events.md)）。

### `/exit` の即時フィードバック（#170）

`/exit` または `exit`（大文字小文字無視・前後空白トリム）を受け付けた直後、harness は `session.operator_exit` を **同期** emit する。

| 表示経路 | 内容 |
|----------|------|
| TTY（Ink） | 活動ログに「終了しています…」（`session.post_loop_wait` と同様 observation ラベル）。入力欄は二重 submit を防ぐため無効化 |
| 非 TTY interactive | stderr に `\n終了しています…\n`（`createObservationSink`） |

その後、worker へ `session/cancel`、明示 exit 時は fast path teardown（`waitForIdle` スキップ・並列 close）が走る。終了後、isolated worktree の cleanup を試みます。詳細は [harness-events.md](harness-events.md) の `harness.teardown`。

cleanup が dirty worktree のためスキップされた場合や、削除に失敗した場合は warning と復旧方法を表示します。cleanup の失敗はセッション結果を error にせず、CLI exit code に影響しません（[#448](https://github.com/otolab/agents-ensemble/issues/448)）。

### `/close` の即時フィードバック

`/close` または `close` を受け付けた直後は `session.operator_close` を同期 emit します。TTY の活動ログには「セッションを保存して閉じています…」と表示し、入力欄を無効化します。teardown 後に終了 JSON を出し、worktree cleanup を行わず exit code 0 でプロセスを終了します。YAML / SessionResumeStore の flush failure は warning として扱い、`/close`・`/exit`・割り込み・通常終了など、どの終了経路でも終了を続けます。`/exit` の cleanup failure を warning のみ・exit 0 とする [#448](https://github.com/otolab/agents-ensemble/issues/448) の契約とは別の条件です。

#### post-loop 開始直後の `/exit`（#200）

`session.post_loop_wait` の通知後も SessionDriver がイベント待機を継続する。`/close` と `/exit` は専用の終了 signal で Driver の待機を中断するため、通知と待機 API の間に終了入力が失われるレースはない。

#### teardown が長引く場合（#200）

| 段階 | 通常の挙動 | 利用者への表示 |
|------|------------|----------------|
| `/exit` / `/close` 直後 | 専用イベントで TUI は終了フィードバック・入力無効化 | 活動ログ / 入力ヒント |
| `buildResult` | 明示 `/exit` / `/close` / interrupt 時は `getUsage().cost` 取得をスキップ（SDK 応答待ちで teardown を止めない） | なし |
| `finally` teardown（停止フェーズ） | `/close` は処理中 worker prompt を cancel し、permission を deny、attach 済み ACP session ID / cwd を snapshot してから monitor を停止し、その cursor / outbox を SessionResumeStore に flush する。続いて worker と conductor を force stop する。Pi は MCP を無効にして reload し、stdio MCP child を閉じてから session を dispose する。worker ACP child は stdin EOF 後 500ms 待ち、SIGTERM 後 5s、SIGKILL 後最大 2s の回収を試みる。`/exit` は cursor を flush してから worker / conductor / monitor を停止する | `harness.teardown.phase` で段階表示。完了時 `harness.teardown`（1s 超または force 時） |
| GitHub monitor `stop`（停止フェーズ内・accepted risk） | poll 実行中に `/exit` または `/close` すると `stop()` は完了を待つ | 5s まで待ち、超過時 poll を abort。その後最大 500ms 待って teardown を続ける（#209） |
| isolated worktree 削除（停止フェーズ後） | 正常 `/exit` のみ clean worktree の削除を試みる。`/close` と Ctrl+C/SIGINT は削除しない。未コミット変更時は削除を拒否し、一時的な失敗は初回＋100ms／250ms の最大 3 回まで再試行 | `/exit` では成功時 `harness.worktree.removed`。dirty / 最終失敗時は診断と手動復旧方法を表示 |

worktree 削除の再試行は、一時的に ACP / worker の終了処理が git worktree の lock を保持しているケースを対象にした限定的な改善です。`git worktree remove --force` は使わず、dirty worktree の自動破棄や SIGINT 時の削除も行いません。全試行が失敗した場合は最後の git エラーを `harness.worktree.remove_failed` と warning の両方に残します。warning には、変更を commit または stash した後に `git worktree remove <path>` を手動実行する復旧ヒントを含めます。post-loop の worktree cleanup failure は warning として記録し、CLI exit code には影響しません。CLI は `stopReason === 'error'` の場合だけ exit 2 で終了します。

正常に `/exit` が完了すれば Pi の stdio MCP 子プロセスと worker ACP 子プロセスを停止・回収して CLI は自然終了します。サマリー表示後に Ctrl+C で終了させる回避操作は不要です。

worker ACP は stdin EOF 後 500ms の自然終了猶予を持ちます。終了しない場合は SIGTERM を送り、5 秒後も残っていれば SIGKILL で終了を求め、最大 2 秒回収を待ちます。それでも終了を確認できなければ teardown error になります。

**GitHub monitor poll ハング（accepted risk, #200）**

| 項目 | 内容 |
|------|------|
| 発生条件 | GitHub 監視が有効（デフォルト）で、GitHub API による poll が進行中に `/exit` または `/close` |
| 症状 | UI は即「終了しています…」になるが、teardown が `githubMonitor.stop()` で `pollInFlight` 待ちになりプロセスが長時間残る（5s 超は abort） |
| 回避策 | `--no-github-monitor` で監視を無効化（[cli/README.md](cli/README.md)・[harness-events.md](harness-events.md)） |
| 実装 | poll / `stop()` のタイムアウト 5s（#209）。超過時は進行中 API リクエストを abort して teardown 継続 |

自律ループ実行中の `/exit` は `shutdownSignal` abort で driver を抜ける。conductor `send` 進行中でも abort を優先し、完了待ちで固まらない（#200）。

終了 JSON はプロセス終了時のみ stdout（変更なし）。
