# Conductor dispatch lifecycle

> **正本:** Issue workflow の conductor dispatch における状態の所在、遷移、利用者に説明できる契約。send failure と recovery inbox の詳細は [conductor-auth-reconnect.md](conductor-auth-reconnect.md)、入力操作は [operator-input.md](operator-input.md)、観測イベントの型と出力先は [harness-events.md](harness-events.md) を参照する。

この文書は現行実装の静的な対応を記録し、To-Be の transition core と実行層を分ける境界を定める。現行 TypeScript と Lean As-Is の遷移同値性や、外部 provider まで届く性質の証明を主張しない。現行 As-Is の分析は [Composition.md](../formal/lean/Ensemble/AsIs/Composition.md)、共通の抽象的な性質は [Flow/Spec.lean](../formal/lean/Ensemble/Flow/Spec.lean) を参照する。

## 将来契約の参照

[ADR 0088](adr/0088-conductor-durable-inbox-recovery-contract.md) は、Issue workflow の永続 inbox と process 再開後の recovery に関する承認済み将来契約を記録する。これは現行 runtime には未実装である。本文書の以下の状態・遷移・保証は現行挙動の記述であり、ADR 0072 のうち Issue workflow の durable inbox・restart recovery・batch delivery 境界は ADR 0088 により部分的に supersede された。ADR 0072 の本文は当時の判断記録として維持し、operator-agent の watch report 契約など対象外の範囲も維持する。

## 状態の正本

`ConductorDispatchLifecycle.state` は複数の状態を一つにまとめた表示である。send lease、接続可能性、confirmation gate の正本をひとつの `state` 値が持つわけではない。selector、dispatch hold、permission、recovery inbox もそれぞれ別の所有者を持つ。

| 状態 | 正本と更新主体 | 範囲・永続性 |
|---|---|---|
| conductor send / reconnect lease、agent availability、failure後の attention | `ConductorDispatchLifecycle` の `activeLease`、`agentAvailable`、`attentionAttemptId`、`lastFailureClass`。Driver が `begin*` / `settle*` を呼び、reconnect callback が availability を更新する | 一つの driver 実行中に限る。`state` getter は `in_flight` / `reconnecting` / `unavailable` / `attention` / `ready` の優先順で導出する。`ready` は queue が空、または send 可能であることを意味しない。availability は harness が受け取った結果であり、provider が次の send を受け付ける保証ではない |
| 受理済み SessionEvent | `SessionEventQueue`。producer が enqueue し、Driver が選択済み batch を send lease 取得後に除去する | process 内の queue。一般的な resume / restart 後の再配送は契約しない。legacy waiter API は matching event を直接返すが、本番 Driver は batch selection を使う |
| dispatch hold と `heldEvents` | `DispatchHoldState`。`set_dispatch_hold` の tool 経路が hold を切り替え、Driver が queue から hold 対象を buffer し、解除後に再選択する | Driver 内のメモリだけにある。SessionResumeStore には保存しない。hold 中も operator message、operator reconnect、permission stall は held buffer を通らない |
| batch の直前 source と continuation 消費状態 | `runConductorSessionDriver` の `dispatchBatchState`。selector の結果後に Driver が更新する | Driver 実行中だけの選択状態。queue や lifecycle の正本ではない |
| permission request の生存 | `PermissionPipeline.pending` | `permission.pending` event の payload だけでは現在も pending か決めない。Driver は dispatch 前に pipeline を参照して stale event を queue / held buffer から除く |
| worker 実行数・worker outcome | `WorkerSession.runtime` と worker inbox / event producer。Driver は runtime の running count を停止判定に使い、outcome event は queue を通す | event の受理と worker の実行状態は別の状態。queue 受理だけでは worker outcome の dispatch を意味しない |
| Open Question | `OpenQuestionRegistry` とその永続化経路 | Driver は未回答数を停止判定に使う。回答を operator message として queue に入れる処理は別の handoff |
| recovery snapshot と send 前 reservation | `ConductorRecoveryInbox` | operator が確認できる対話 TTY 実行では process-local。本文、上限、寿命、shutdown 時の扱いは [ADR 0072](adr/0072-conductor-dispatch-lifecycle-and-recovery-boundary.md) と [conductor-auth-reconnect.md](conductor-auth-reconnect.md) を参照 |
| turn / send counters | `runConductorSessionDriver` の値。resume 時の初期値は `resumeStore` から受け取る | `sendCount`、`autonomousTurns` など一部は resume state に写す。in-flight lease、queue、held buffer は復元しない |
| Cursor bootstrap gate | session / resume state の `cursorBootstrapState` と Driver 内の pending 判定 | `unknown` / `saving` は operator の判断を待ち、`incomplete` は次に選ばれた新しい dispatch へ compiled prompt を添える。送信成功で完了を記録する。詳細は [conductor-auth-reconnect.md](conductor-auth-reconnect.md) を参照 |
| session shutdown | session が所有する `AbortSignal` と operator close / exit の mode。Driver は signal を受け取り、自律 loop の停止とは別に扱う | `shouldStopIssueLoop` の成立は process close を意味しない。shutdown / post-loop の区別は [ADR 0013](adr/0013-process-lifecycle-vs-autonomous-loop.md) を参照 |

### 導出状態の読み方

| 見える状態 | 意味 | 意味しないこと |
|---|---|---|
| lifecycle `ready` / `canDispatch` | active lease がなく、agent が available で、attention gate がない | queue の項目が eligible、dispatch hold が解除済み、turn 上限内、send が開始可能、とは限らない |
| Driver の batch wait | queue / lifecycle / recovery inbox の変化または shutdown を待ち、再選択する | 恒久的な `idle` 状態ではない。wake 後の選択、send、完了も保証しない |
| Issue loop stop | `shouldStopIssueLoop` 等が自律処理の停止を判定した | post-loop 待機を含む session や process の終了とは限らない |
| `conductor.send.started` | `agent.send` 呼び出し直前の観測イベント | provider が入力を受理したこと、処理が成功したことを示さない |

## 現行 lifecycle の遷移

下表は現行コードの責務境界を示す。selector の結果、Driver の状態更新、外部 I/O の結果を同じ「dispatch」イベントとして扱わない。

| 段階 | trigger / guard と処理 | 状態の正本・停止時の所在 |
|---|---|---|
| 受理 | operator / worker / permission / GitHub 等の producer が `SessionEventQueue.enqueue` を呼ぶ。`operator.message.send` の UDS 成功応答は queue に受理されたことを示す | queue が受理後の process-local 項目を持つ。`queued: true` は conductor dispatch receipt ではない |
| 待機・保留 | lifecycle が send 不可なら Driver は待ち、明示 reconnect は別経路で扱う。dispatch hold 中は hold 対象 trigger を `heldEvents` に移す。dispatch 前に stale permission を除く | hold / queue / lifecycle が独立している。held buffer と queue は一般に process restart へ引き継がれない |
| eligible 判定・選択 | `selectDispatchBatch` が dispatch mode、turn policy、idle message gate、source priority、continuation に基づいて純粋に候補 batch を返す | selector 自身は queue / lifecycle を更新せず、選択結果だけを返す。recovery inbox が operator input を保持する場合、Driver は send 前 reservation を試みる。容量不足なら event を queue に残して再選択を待つ |
| send 開始 | `beginSend` が lease を取得する。取得後に Driver が選択 event を queue または held buffer から除き、`conductor.send.started` を出して `agent.send` 呼び出しへ進む | `ConductorDispatchLifecycle` が active attempt を所有し、取り出した batch は lease payload / Driver の send 処理にある。selection は send 開始と同義ではない |
| send 結果 | `settleConductorDispatch` が result と workflow policy を解釈し、reservation を release または recovery snapshot に commit してから lease を settle する。Issue workflow は `finished` / `completed` / `running` を完了扱いにする | 成否・failure class・availability・attention は lifecycle と recovery inbox が持つ。未完了時は通常 attention を立てるが、`cancelled` と明示的 interrupt message が揃う場合はその message を次に処理する。結果を得ず shutdown で Driver が戻る場合、外部 send の完了や副作用の有無は確定しない |
| reconnect | 明示 `/reconnect` は `beginReconnect` 後に外部 adapter を実行し、結果を `settleReconnect` に渡す。自動 reconnect callback も availability の変化を知らせる | `settleReconnect` は成功時に availability を戻し、失敗時は unavailable のままにする。attention は解除しない。reconnect は失敗 prompt を送らない |
| 利用者確認 | `/recovery continue` が `confirmRecovery` を呼び、active lease がなければ attention を解除する。attempt ID を渡す呼び出しでは一致も検査する | confirmation は agent availability を変更せず、失敗 input を replay しない。`/reconnect` と別の操作 |
| loop / session 停止 | Issue loop の stop 判定後も TTY post-loop では Driver が待機しうる。shutdown signal は Driver の wait / send wait を中断し、session teardown へ渡す | loop stop、shutdown 要求、provider 側 send の終端、process teardown は別状態。`operator.message` の `interrupt` と session shutdown も別の操作 |

### 選択から send 開始まで

現行 TS では少なくとも次の境界を区別する。

1. `selectDispatchBatch` が queue snapshot から候補を返す。
2. `waitForDispatchBatch` が inbox reservation を確保し、候補を Driver に返す。容量不足なら queue を変更しない。
3. `runConductorSessionDriver` が `beginSend` で lease を取り、reservation を確保できなかった場合や lease を取れなかった場合は queue を消費しない。
4. lease 取得後に選択 event を queue / held buffer から除き、`runEventConductorSend` が `conductor.send.started` を出してから外部 `agent.send` に進む。
5. send result を受けて settle / inbox commit / worker outcome acknowledgement を行う。

この差は「候補が選ばれた」「send を開始する状態を commit した」「外部 agent.send が呼ばれた」「send が完了した」を区別する。`SessionEventQueue` から除いたことだけで provider の受理や完了を推論しない。

### 停止・割り込み時の項目の所在

| 停止する位置 | 項目・状態の所在 | そこからは言えないこと |
|---|---|---|
| 選択前、または batch wait 中 | queue / held buffer に残る。shutdown signal は wait を解除する | process が終了すれば、これらの process-local event が resume 後に復元されるとは限らない |
| 選択・reservation 後、`beginSend` 前 | event は queue / held buffer に残る。shutdown を検知した Driver は reservation を release する | 選択されたことは lease 取得や send 開始を意味しない |
| `beginSend` と queue / held buffer からの除去後 | lease payload と in-flight send 処理が保持する。send 中に到着した別 event は queue に残る | shutdown / cancel が provider の処理を確実に止めたこと、結果や副作用が確定したこと、除去済み event が再送されることは言えない |
| send result settle 後 | 完了 event は workflow の完了処理へ進む。shutdown 中でなく、保存可能な TTY 実行なら未完了 operator input を recovery inbox に保存する。通常は confirmation gate で後続 dispatch を止めるが、明示 interrupt message がある cancelled result はその入力を次に処理する。watch report retry は別契約 | shutdown 中の failure capture は抑止される。failed batch 自体が通常 queue に戻ること、process teardown 後に inbox が残ることはない |

`delivery: 'interrupt'` は operator message が進行中 run の cancel を試す指示で、session shutdown signal ではない。cancel 成否は send result として扱い、queued operator message はその後の選択へ回る。`/close`、`/exit`、SIGINT / SIGTERM は session lifecycle の操作であり、operator message の優先度や `set_dispatch_hold` を変更する操作とは別である。

### 待機・hold・上限の解除

`selectDispatchBatch` の優先順は、eligible な `operator.message`、`permission.pending`、直前 worker source の一度限りの continuation、その後に静的優先度である（[ADR 0014](adr/0014-conductor-dispatch-batch-coalescing.md)）。`idle` operator message は active worker やほかに送信可能な event がある間は候補にしない。`next` は次の選択で operator message を最優先にし、`interrupt` は進行中 run の cancel を試すが、cancel 成功や即時送信を保証しない。

dispatch hold は自動解除しない。`permission.pending` と通常 trigger は hold 対象だが、`permission.stall` は hold を通り抜けて低優先度で選択可能である（[ADR 0056](adr/0056-permission-stall-dispatch-hold.md)）。max-turns は worker / GitHub などの自律 event を抑える一方、operator message、reconnect、permission 回復などの既定例外がある。turn 上限、hold、agent availability、attention、worker / permission / open question の状態は別々に判定する。

## TypeScript の関数対応

クラスやファイル配置をそのまま将来の仕様上の責務とみなさず、現行の読み書きと外部境界で対応づける。

| 現行関数 / 型 | 現行の責務 | 将来の境界 |
|---|---|---|
| [`packages/core/src/conductor/conductor-dispatch-lifecycle.ts`](../packages/core/src/conductor/conductor-dispatch-lifecycle.ts) — `ConductorDispatchLifecycle.beginSend` | guard を満たす場合に単一 send lease を作り listener を起こす | reducer が扱う lease 状態の更新 |
| 同ファイル — `ConductorDispatchLifecycle.beginReconnect` | 他の lease がない場合に reconnect lease を作る。send の dispatch gate は使わない | reducer の reconnect 開始 |
| 同ファイル — `ConductorDispatchLifecycle.settleSend` | lease を検査して解放し、完了・failure class・availability・attention を更新 | reducer が扱う send result |
| 同ファイル — `ConductorDispatchLifecycle.settleReconnect` | lease を検査して解放し、availability を成功結果に合わせる | mock reconnect result の reducer 入力 |
| 同ファイル — `ConductorDispatchLifecycle.setAgentAvailable` | 自動 reconnect 等の結果を availability に反映 | 外部結果 event の適用 |
| 同ファイル — `ConductorDispatchLifecycle.confirmRecovery` | lease 不在を検査し、指定があれば attempt ID を照合して attention を解除 | 利用者確認 operation |
| 同ファイル — `ConductorDispatchLifecycle.wake` | 状態変更なしで listener に通知 | 実行層の wake 通知。domain state ではない |
| 同ファイル — `settleConductorDispatch` | workflow ごとの完了判定、recovery reservation の release / commit、lifecycle settle をまとめる | reducer の result rule と inbox effect を切り分ける |
| [`packages/core/src/conductor/session/dispatch-hold.ts`](../packages/core/src/conductor/session/dispatch-hold.ts) — `createDispatchHoldState` | driver-local hold state を作る | core state 初期化 |
| 同ファイル — `bufferDispatchHoldEvents` | hold 対象 event を到着順に held buffer へ移す | queue / hold state transition |
| 同ファイル — `pruneStalePermissionEvents` | `PermissionPipeline.pending` を正本として stale permission を queue と held から除く | permission liveness を入力 event として明示 |
| [`packages/core/src/conductor/session/session-event-queue.ts`](../packages/core/src/conductor/session/session-event-queue.ts) — `SessionEventQueue.enqueue` / `snapshot` / `removeEvents` / `replaceQueue` / `subscribe` | event の受理、選択用 snapshot、選択済み項目の除去、change notification。legacy waiter も提供する | event storage adapter。永続 queue ではない |
| [`packages/core/src/conductor/session/select-dispatch-batch.ts`](../packages/core/src/conductor/session/select-dispatch-batch.ts) — `selectDispatchBatch` | policy を満たす event の source と batch を純関数で選ぶ | selector / scheduling decision。送信を実行しない |
| 同ファイル — `dispatchBatchStateAfterSend` | 直前 source と次の continuation を記録 | scheduler state transition |
| 同ファイル — `markContinuationConsumed` | worker continuation の一回分を消費済みにする | scheduler state transition |
| [`packages/core/src/conductor/conductor-session-driver.ts`](../packages/core/src/conductor/conductor-session-driver.ts) — `runConductorSessionDriver` | turn / stop 判断、選択、reservation、lease、queue 除去、非同期 send、result settle、wait を束ねる | judgement / reducer logic と async execution を分割する対象 |
| 同ファイル — `waitForDispatchBatch` | lifecycle / hold / permission を見て選択し、inbox reservation を確保または wait する | selection と reservation effect。timer / subscription wait は実行層 |
| 同ファイル — `runEventConductorSend` | `conductor.send.started` を通知し、`sendConductorWithReconnect` を呼ぶ。reject を `send_rejected` として settle callback に返す | send effect executor と result event adapter |
| [`packages/core/src/conductor/session/dispatch-mode.ts`](../packages/core/src/conductor/session/dispatch-mode.ts) — `DispatchMode` / `sessionEventDispatchMode` / `canTriggerConductorDispatch` / `isTriggerSessionEvent` | telemetry / inform / trigger の分類。inform は単独 batch を起こさない | event normalization / eligibility input |
| [`packages/core/src/conductor/session-policy.ts`](../packages/core/src/conductor/session-policy.ts) — `shouldStopIssueLoop` | SDK result、worker / permission / open question 等から Issue 自律 loop の停止を判定 | pure policy。process shutdown とは別 |
| 同ファイル — `canDispatchConductorSend` | turn 上限到達後も送れる event type の例外を判定 | pure eligibility rule |
| 同ファイル — `autonomousTurnsAfterConductorBatch` | operator message を含む batch で reset、reconnect / recovery report のみの batch では維持、それ以外で increment する turn counter を計算 | pure counter transition |

`runConductorSessionDriver` 全体は pure reducer ではない。`Promise`、`AbortSignal`、listener、外部 agent、reconnect、event logging、recovery inbox I/O と session shutdown を含む。関数を一対一で Lean に写すのではなく、transition core に入れる state / event / pure rule と、実行層に残す I/O を抽出する。

## 入力 EOF と session 停止の現行実装

以下は現行 CLI のコード経路を記したもので、EOF 時の終了を利用者に約束する契約ではない。

`ensemble issue` / `ensemble run` の通常 TTY 実行は `useTui = interactive && tty` により `createIssueSessionTuiHost` を選び、Ink の入力欄から submit する。host は submit を `OperatorInputBindingApi.submit` へ渡し、`/close` と `/exit` は `conductor-session.ts` の submit 分岐から `requestOperatorShutdown` を呼ぶ。一方、TUI host / view には stdin の `end` を session shutdown に結ぶ処理がない。

別の binding `bindAsyncOperatorInput` は readline の `line` event を処理するが、readline の `close` を shutdown 要求へ変換する listener は登録しない。通常の CLI TTY 経路はこの binding ではなく上記の Ink TUI を使う。返す disposer が readline を閉じるのは session teardown 時であり、入力 stream の EOF を teardown に結び付けるものではない。

そのため、TTY の post-loop 待機が有効なときは、stdin EOF だけでは `requestOperatorShutdown` や Driver の shutdown signal は発生しない。`waitForOperatorExit` が有効なら、Issue 自律 loop が止まった後も Driver は event を待ちうる。EOF 後はその入力経路から追加操作を送れないが、EOF 自体が session を閉じるわけではなく、他の event や UDS / process signal による終了経路は別に残る。プロセスが必ず終了する、または無期限に残るとはここから断定しない。非 TTY の one-shot は継続入力 binding と post-loop 待機を持たず、別の停止条件で動く。

`operator-agent` の `runTtyConversation` は stdin `end` を `inputEnded` に反映する別プロセスの経路である。その挙動を Issue CLI の conductor session の EOF 処理と同一視しない。

## 利用者に説明できる保証と限界

| 契約 | 利用者に言えること | 言えないこと・根拠 |
|---|---|---|
| operator message の受理 | UDS の `queued: true` は event queue への受理を示す。通常入力は選択されるまで queue に残る | dispatch / conductor の読了 / 完了 receipt ではない。queue と held buffer の一般的な restart durability はない |
| failure 後の再送 | ADR 0072 により、失敗した operator input を通常 queue に戻して自動再送しない。watch report の ID-based at-least-once retry は別契約 | 内容 dedupe、provider 側副作用の重複防止、結果不明時に副作用がなかったことは保証しない |
| reconnect と recovery confirmation | reconnect 成功は availability を回復する。confirmation は attention gate を解除する。この二つは独立し、どちらも失敗 prompt を replay しない | reconnect 成功だけで後続 dispatch が可能・成功とは限らない。他の hold、turn policy、attention が残りうる |
| 失敗内容の保持 | 対話 TTY の recovery inbox は実際に dispatch した batch の operator-authored input を制限付きで保持する | 非 TTY での本文確認、process 終了後の復元、queue 全体の永続化、任意 event の保持は保証しない |
| dispatch hold / 待機 | hold と各 gate は独立している。permission stall は hold 中も回復判断の契機になりうる | hold の自動解除、即時 dispatch、固定時間内の解除は保証しない |
| #855 の回復可能性 | `RecoveryPossible` は回復操作に加えて send / reconnect の環境結果や時刻を含む有限経路の**存在**を述べる | 環境が成功すること、その経路を実行すること、配信または有限時間内の回復を保証しない |
| #855 の進行性 | `SchedulerFair` は対象が以後ずっと eligible な無限実行を前提に、scheduler がいつか選ぶ条件付き性質。`ReconnectResumes` / `HoldExemptDelivered` にも他の停止要因が介入しない条件がある | 実時間期限、無条件の公平性、有限実行での進行、send 完了や tool effect 成功は保証しない。有限実行だけでは無限実行の性質が空虚になりうる |
| #855 の重複・保持性 | `NoAutomaticInputReplay` は失敗確定後の同一 abstract ID の再 dispatch を禁じる。結果不明後は、process 再開時の `restartRecoveryDispatch` と、3回上限後に TTY operator が選ぶ `operatorResend` を別 event として同じ ID の例外に表す。両方とも Issue #909 で承認された To-Be であり、現行 runtime はどちらも実装していない | abstract `EventId` はモデル内の受理項目を追う名前で、現行 `SessionEvent` の永続 ID でも本文 equality でもない。event tag は呼び出し元が与える前提であり、実際の process 再開・3回到達・TTY 操作を検証しない。形式性質は batch identity・永続化・send 回数上限・operator 操作の実装・外部副作用重複防止を証明せず、現行 TypeScript 全体への実行可能性も示さない |

Issue #855 は元の `NoAutomaticInputReplay` を含む性質文面への operator 合意を記録した。Issue #909 は、process 再開時の delivery-unknown recovery と、3回上限後に operator が選ぶ明示 resend をそれぞれ承認した。`Flow/Spec.lean` はこの property-specific な合意範囲を明記する。これは他の性質が合意済みであることや、現行 runtime が再送を実装していることを意味しない。

## Transition core と実行層

Transition core は純粋な一段遷移として、概念上 `step(state, event) -> (nextState, effects)` の形を持つ。`effects` には外部 action と trace observation を別々に含める。Lean と TypeScript は構文を揃える必要はないが、state の意味、step の入力・出力、観測対象の振る舞いを揃え、event trace を照合できる形にする。core の遷移だけを Lean / TS の二重記述対象にする。

### State / Event / Effect の形

| 型 | 含める値 | 役割 |
|---|---|---|
| `State` | lifecycle lease / availability / attention、抽象 queue item と status、dispatch hold / held、selector continuation、turn policy、eligible / stop guard に必要な permission・worker・Open Question・bootstrap の投影 | core が所有する決定的な状態。実際の queue object や service instance ではなく、遷移に必要な値だけを含める。投影の入力源は現行 owner のままとする |
| `Event` | `arrival`、operator operation / shutdown input、scheduler の `schedule(selection)`、実行層から戻る `sendStarted(attempt)` / `sendResult(attempt, outcome)` / `reconnectResult(outcome)`、明示 `tick(time)` | core への一回の入力。ID は trace 内の項目 / attempt の対応づけに使い、現行 wire API の安定 ID を意味しない |
| `Effect.actions` | `startSend(attempt, payload)`、`startReconnect(attempt)`、operator notification | reducer が実行層に依頼する作用。外部 I/O が実行・成功したこととは区別する |
| `Effect.observations` | `accepted`、`scheduled`、`dispatched`、`discarded`、recovery 等の状態変化を trace で照合する観測 | action の実行とは別の出力。#855 の `Observation.dispatched` は実 send 開始を指す意味のまま保つ |

`schedule(selection)` は選択の記録であり、実 send 開始を表す `sendStarted(attempt)` と同じ event にはしない。実行層は `startSend` effect を受けて agent API を呼び、その開始を `sendStarted`、返却 / reject を `sendResult` として戻す。`reconnect` も core は開始要求と成功 / 失敗結果だけを扱い、close / resume や transport の内部過程を表現しない。

TypeScript core は `session.shutdown` event に shutdown mode（`close` / `exit` / `signal`）を記録する。選択後、send 開始前にこの event が届いた場合は `startSend` を出さず、選択項目は queue に残す。未開始 lease がある trace でも `dispatched` を観測しない。AbortSignal の伝達、listener の解除、実際の I/O の中断は execution layer の責務であり、この reducer だけでは provider 側の停止を保証しない。

architect との相談を踏まえ、具体実装の複数遷移（選択、reservation、lease 取得、実 send 開始）を抽象 `.schedule` に写す案を候補として残す。この案では `Observation.dispatched` を実 send 開始として保ち、選択時の観測へ読み替えない。ただし、この抽象化が成り立つことや Lean / TS の整合は現時点で証明されていない。中断・停止・無限待機を含む全 trace の対応と、必要となる公平性条件の検証が別途必要である。今回、公平性条件も #855 の性質も追加・変更しない。次の Lean / TS モデルでこの対応を前提にする前に、差分と未証明条件を conductor / operator が確認する。ここに挙げた型は契約の初版であり、具体的なコード union や wire format の確定ではない。

| core に属する値 | execution layer に属する値・処理 |
|---|---|
| lease / availability / attention、queue 上の抽象項目、hold、turn counter、明示された event と result | Promise、`AbortSignal`、listener、timer、実時間 clock、agent / provider API、reconnect 内部処理、queue / inbox I/O、永続化、TTY / UDS、SessionLogEvent emission |
| 到着・operator operation・send / reconnect result・明示 tick・選択に関する遷移と guard | 実際の到着順、イベント通知、timer 発火、SDK call の開始・完了、cancel / shutdown race を core の外部入力へ変換する |
| 遷移で生じる effect の種類と payload の意味 | effect を実行し、得られた結果だけを対応する result event として core に戻す |

reconnect はモックとして開始と成功 / 失敗の結果だけを表す。認証、close / resume の内部段階、transport の retry、成功確率はモデル化しない。

選択 / schedule と実 send 開始は別段階として扱い、選択だけで provider send の成功や完了を意味させない。一方、#855 の `ScheduledDispatches` は `.schedule id` の遷移内に、実 send 開始を指す `Observation.dispatched` を要求する。具体遷移列を一つの抽象 `.schedule` に対応づける案はあるが、中断・停止・無限待機を含む全 trace と公平性を検証していないため、現時点で同値性や整合を証明したとは言えない。#855 の性質や `dispatched` の意味を変えず、この抽象化候補と未証明条件を明示する。operator 合意の記録差も未解決であり、どちらの記録も書き換えない。

As-Is Lean は参照用に凍結し、新規 Lean 定義は `Ensemble.ToBe` に置く。To-Be は有限探索の結果で代用せず、性質を theorem として全域に証明する。証明が過度に複雑なら transition design を見直す。trace 照合は対応する個々の trace を比較する手段であり、全 trace の対応や公平性、Lean / TS の全域一致を証明しない。trace に含まれない I/O の成功、配送期限、provider effect の exactly-once も主張しない。

## Conductor と operator のイベント契約（初版）

この契約は二つの core を結ぶ意味上の境界であり、wire schema や operator core の詳細設計ではない。共有 mutable state は作らず、conductor core が conductor dispatch state の正本を持つ。operator 側は受け取った event の表示・制御を担い、conductor state の正本にはならない。

| 向き・事象 | 生成者 | 受け渡す意味 | 状態の正本 / acknowledgment の限界 |
|---|---|---|---|
| operator → conductor: message | TTY / operator binding / `operator.message.send` が `operator.message` を生成 | text と `delivery` (`next` / `idle` / `interrupt`) を入力として渡す | 受理後は `SessionEventQueue`。UDS の `queued: true` は queue acceptance のみ |
| operator → observer: `operator.input` | input binding が受理時に `SessionLogEvent` を記録 | 解決後の delivery と入力を operator-facing log / activity view に示す | observation であり、queue item の ID や dispatch receipt ではない |
| operator → conductor: reconnect | `/reconnect` command が `operator.reconnect` を生成 | prompt を送らず reconnect 操作を要求する | queued request は event queue、進行中 lease / availability は lifecycle。結果は実行層が返す |
| operator → conductor: recovery confirmation | operator が `/recovery continue` を実行 | 現在の未確定 attempt を確認し attention gate を解放する | lifecycle の `attentionAttemptId`。agent availability や失敗 input の内容・再送は変更しない |
| conductor tool → conductor core: hold change | conductor の `set_dispatch_hold` tool が driver-local hold を変更する | hold の ON / OFF を通知し、hold 対象 event の buffer / flush を促す | `DispatchHoldState`。SessionLogEvent は観測であり state の正本ではない |
| operator → session: shutdown | TTY `/close` / `/exit`、または UDS `operator.session.shutdown` | session shutdown mode を要求する | session の shutdown flags / signal。受付応答は shutdown の完了 receipt ではない |
| conductor → operator: queue / selection observation | session logger が `operator.queue.changed`、`operator.dispatched`、`conductor.inbound` を発行 | UI queue refresh、operator message の dispatch 表示、send 前の trigger/source summary を伝える | いずれも観測。`operator.dispatched` / `conductor.inbound` は provider の受理・完了を示さない |
| conductor → operator: send lifecycle | session logger が `conductor.send.started` / `conductor.send.progress` / `conductor.send` を発行 | 開始直前、tool progress、send result を観測可能にする | event stream は観測記録。queue / lifecycle state を置き換えず、`started` は成功を意味しない |
| conductor → operator: reconnect lifecycle | reconnect adapter callback が `conductor.auth.reconnect` / `conductor.transport.reconnect` の attempt / succeeded / failed を発行 | `source` と reconnect 結果を伝える | availability の正本は lifecycle。成功 event は失敗 prompt の再送や attention の解除を意味しない |
| conductor → operator: recovery attention | send settle 後に `harness.warning` を発行 | attempt / failure class と必要な確認操作を伝える。本文・raw error は通常 warning に含めない | snapshot 本文の正本は TTY の recovery inbox。warning は ack や復旧成功 receipt ではない |

Core 間の abstract event identity は trace 上で受理項目を結び付けるために使えるが、現行 SessionEvent / UDS の安定 ID・再起動を跨ぐ ID として公開しない。operator と conductor の各 core は自分の state だけを更新し、相手側の状態を結果 event として受け取る。

## 関連 ADR

- [ADR 0056](adr/0056-permission-stall-dispatch-hold.md): dispatch hold 中の permission stall。
- [ADR 0072](adr/0072-conductor-dispatch-lifecycle-and-recovery-boundary.md): single lease、no replay、recovery inbox、confirmation gate。
- [ADR 0088](adr/0088-conductor-durable-inbox-recovery-contract.md): Issue workflow の durable inbox と restart recovery の承認済み将来契約。現行未実装。
- [ADR 0086](adr/0086-lean-formal-model-for-dispatch-flow.md): Lean を中間言語とする Phase 0 / Phase 1 の位置づけ。
- [ADR 0087](adr/0087-conductor-dispatch-transition-core.md): transition core と execution layer の分離、trace 接続。
