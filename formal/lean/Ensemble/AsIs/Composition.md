# 合成モデルの検査状況

この文書は作業途中の対応表であり、TS 全体の形式化や #855 の全命題の判定を示すものではない。TS を現状の基準とし、抽象仕様との違いは検査結果として扱う。

## TS の関数と Lean 定義の対応

パスはリポジトリルートから記す。Lean の名前は `Ensemble.AsIs.` を省略する。
`Composition.step` は主体別の既存モデルを合成する部分モデルで、TS の driver 全体との等価性は未証明である。
`ObservedHistory` の列は具体状態を保持する観測接続の試作であり、全遷移の写像ではない。

| TS ファイル | 関数・操作 | Lean 定義 | 接続範囲と未対応 |
| --- | --- | --- | --- |
| `packages/core/src/conductor/session/session-event-queue.ts` | `enqueue` | `Composition.step` の `conductorEnqueue`、`ObservedHistory.conductorAcceptWorker` | 履歴の受理観測は worker 完了と permission stall に限定。waiter への直接配送は未接続。 |
| `packages/core/src/conductor/session/select-dispatch-batch.ts` | `selectDispatchBatch` | `ConductorQueue.chooseDispatch`、`Composition.step` の `conductorBeginSend`、`ObservedHistory.conductorDispatch` | 履歴は worker 完了・permission stall の受理と batch を部分的に接続。予約・時刻と全項目の条件は未接続。 |
| `packages/core/src/conductor/session/dispatch-hold.ts` | `bufferDispatchHoldEvents` | `ConductorQueue.bufferHold`、`Composition.step` の `conductorHold`、`ObservedHistory.conductorDispatchHold` | held の操作を部分的に接続。permission の失効・通知と全項目の観測は未検査。 |
| `packages/core/src/dispatch/set-dispatch-hold-tool.ts` | `createSetDispatchHoldTool` 内の `execute` | `ConductorQueue.setHold`、`ObservedHistory.conductorDispatchHold` | hold 切替の結果のみ。ツール出力・通知は対象外。 |
| `packages/core/src/conductor/conductor-session-driver.ts` | `runConductorSessionDriver` 内の reconnect 選択・結果 | `Composition.step` の `conductorBeginReconnect` / `conductorReconnectResult` | 成功 settle の局所定理あり。conductor の主体別履歴への接続、非同期中断は未実装。 |
| `packages/core/src/conductor/conductor-session-driver.ts` | `runConductorSessionDriver` 内の send・結果処理 | `Composition.step` の `conductorBeginSend` / `conductorSendResult`、`ObservedHistory.conductorCompleted` | 観測履歴は追跡した batch の成功のみ。失敗・例外と driver の全停止境界は未接続。 |
| `packages/core/src/conductor/conductor-dispatch-lifecycle.ts` | `settleConductorDispatch` | `ConductorDispatchLifecycle.settleConductorDispatch`、`Composition.step` の send 結果 | lease と結果を合成。inbox の実容量・期限・dispose は外部結果で過大近似。 |
| `packages/core/src/conductor/conductor-recovery-inbox.ts` | `ConductorRecoveryInbox.reserve` / `release` | `Composition.Reservation`、`Composition.step` の `operatorBeginCommit` / `operatorCommitStopped` | token と byte 数は保持。容量・期限・dispose は `reservationOk` で外部から与え、実行可能性は別途確認が必要。 |
| `packages/core/src/conductor/session-policy.ts` | `canDispatchConductorSend` / `autonomousTurnsAfterConductorBatch` | `ConductorQueue.canSend`、`Composition.step` の `conductorBeginSend` / `conductorSendResult` | 自律ターン数と上限を保持。全セッション制御の実行順は未接続。 |
| `packages/operator-agent/src/run/run-operator-conversation.ts` | `runTtyConversation` 内の `handleSubmittedInput` | `Composition.step` の `operatorInput`、`ObservedHistory.accept` | 通常入力の受理を記録。入力文字列の表示、全コマンドと外部 I/O は未接続。 |
| `packages/operator-agent/src/dispatch/operator-dispatch.ts` | `selectOperatorDispatchBatch`、`createOperatorDispatchQueue` の `selectBatch` | `OperatorDispatch.Queue.selectBatch`、`Composition.step` の `operatorBeginCommit`、`ObservedHistory.internal` | lifecycle の `canDispatch` gate を通った後に選択を記録し、send 開始と分離。全 focus・時刻・入力条件との履歴対応は未証明。 |
| `packages/operator-agent/src/watch/operator-watch-dispatch.ts` | `createWatchDispatchOperations` の `commitBatch` | `Composition.step` の `operatorBeginCommit` / `operatorCommitApply` | user・凍結 batch と未凍結 report の commit 境界を区別。lock 競合・永続化例外の全順序は未接続。 |
| `packages/operator-agent/src/watch/operator-watch-pool.ts` | `refreshPendingReports` / `syncPendingReportsToQueue` | `Composition.Event.operatorRefreshReport`、`Composition.step`、`ObservedHistory.internal`、`OperatorDispatch.Queue.reconcileQueuedReport` | 既存 queue 内の report を一回 refresh する履歴を接続。2 秒 timer、poll 通知から runner の選択・送信までの全順序は未接続。 |
| `packages/operator-agent/src/dispatch/operator-dispatch.ts` | `createOperatorDispatchQueue` の `commitBatch` / `rollbackBatchCommit` | `OperatorDispatch.Queue.commitBatch` / `afterCommitError`、`Composition.step` の `operatorCommitException` | queue 更新と rollback をモデル化。例外の実到達性と全保存先は未証明。 |
| `packages/operator-agent/src/run/run-operator-waiters.ts` | `createOperatorWaiters` の `retryWatchLock` | `Composition.step` の `operatorCommitStopped` / `operatorRetryStopped` / `operatorRetryException`、`ObservedHistory.retryStopped` / `retryException` | 停止・例外を区別。同期 user commit 後に停止通知が先行する候補の TS 実到達性は未確認。 |
| `packages/operator-agent/src/run/run-operator-conversation.ts` | `runTtyConversation` 内の send 開始・結果・中断 | `Composition.step` の `operatorCommitSuccess` / `operatorSendResult` / `operatorInterruptSend`、`ObservedHistory.dispatch` / `sendResult` / `interruptSend` | 正常・未完了・中断の限定列。race の全実行順序は未証明。 |
| `packages/operator-agent/src/dispatch/operator-dispatch.ts` | `createOperatorDispatchQueue` の `requeue` | `OperatorDispatch.Queue.requeueReport`、`Composition.step` の `operatorRetryResult`、`ObservedHistory.retrySaved` | 非空 report ID のみ論理 ID を保持。空 ID・重複や時刻の全組合せは未接続。 |
| `packages/operator-agent/src/watch/operator-watch-ack.ts` | `retryOperatorWatchAcknowledgement` | `OperatorDispatch.Runner.ackResult` / `advanceAck` / `finishAcknowledged`、`ObservedHistory.operatorAckStep` | ack 待機と再試行の限定列。実時間の単調性・全例外順序は未証明。 |
| `packages/operator-agent/src/run/run-operator-conversation.ts` | `runTtyConversation` 内の `handleInputEnd` / `requestStop`、`/reconnect`、dispatch 不可時の待機 | `Composition.step` の `operatorInputEnd` / `operatorRequestStop` / `operatorWaitStopped` / reconnect 各操作、`ObservedHistory.operatorRequestReconnect` / `operatorBeginReconnect` / `operatorReconnectResult` / `internal` | EOF と停止要求を分離。`operatorWaitStopped` は dispatch 不可時に `stopping` が解決して return する境界を表す。reconnect・他の待機箇所や全 callback 順序は未接続。 |
| `packages/operator-agent/src/run/run-operator-conversation.ts` | `runTtyConversation` 内の `/resume-watch` | `Composition.step` の `operatorResumeWatch`、`ObservedHistory.operatorResumeWatch` | report hold 保持を局所的に証明。全解除操作の観測接続は未証明。 |

## 現行 TS の idle・停止・終了・通信・回復

調査対象のコードは開始時の commit `8657a347ae6a8e63295513dfacf3e98102e369f8`。Issue #881 本文・履歴を基準にし、#855 / #859 / #848 の Issue 記録、PR #879 の差分・説明・レビュー、ADR 0086、`Flow/Spec.lean` と As-Is モジュール、関連する TS 関数を照合した。調査中に `origin/main` が3 commit進んでいたため、PR #880 で入った TUI clock 表示変更も確認した。この変更は表示更新・cursor 維持の範囲で、ここで扱う session lifecycle / harness idle state の更新ではない。PR #884 のレビューで指摘された3経路は、レビュー時点の head `fe4949bad55eb930089f34baac8e6b76706aab1c` の TS を改めて読み、以下に追補した。これらも関数と分岐の静的な照合であり、runtime trace、Lean build、非同期順序の実測は行っていない。根拠となるコードパスはリポジトリルートから記す。

| Issue #881 の確認項目 | 本文書での記録先 |
| --- | --- |
| 関数単位の状態、trigger / guard / update、主体間 handoff | 「conductor 側の状態遷移」「operator-agent 側の状態遷移」「二つの主体の通信」 |
| idle / 停止 / 終了 / 通信可能 / 回復可能の区別と未確認条件 | 「同じ語で呼ばれがちな状態」「回復可能性と『見かけ上の回復経路』」 |
| 順序、await・外部結果境界、事実 / 仮定 / 未確認 | 上記状態遷移表、「事実・モデル上の仮定・未確認事項」 |
| Lean 具体モデルと #855 の対応、有限探索・公平性・未証明点 | TS / Lean 対応表、#855 の性質、ADR 0086 と停止境界 |
| PR #879 の結果の確度、#859 の残作業 | 「PR #879 の結果と確度」「全体判定までの未解決点」「#859 の受け入れ条件」 |
| #848 Phase 1 に足す材料と残る判断 | 「#848 Phase 1 の途中判断材料」。Phase 1 の決定は本調査の対象外。 |

### 「idle」「停止」「終了」は同じ状態ではない

| 表現 | TS で表すもの | そこからは言えないこと |
| --- | --- | --- |
| conductor lifecycle の `ready` / `canDispatch` | `ConductorDispatchLifecycle.state` / `.canDispatch` (`packages/core/src/conductor/conductor-dispatch-lifecycle.ts`)。send・reconnect lease がなく、agent が available で、確認待ち attempt がない。 | event queue が空、driver が待機中または終了済み、プロセスが稼働中、実際の send が開始できる、とは限らない。queue の項目別 hold、turn 上限、reservation などは別判定。 |
| conductor driver の待機 | `waitForDispatchBatch` (`packages/core/src/conductor/conductor-session-driver.ts`) が選べる batch を得ず、queue・lifecycle 等の変更を待つ。lifecycle が dispatch 不可でも reconnect は別に返す。 | 「idle」を示す永続 lifecycle 値ではない。待機が解けても選択・send・成功は保証されない。 |
| `delivery: 'idle'` | `canDispatchIdleOperatorMessage` (`packages/core/src/conductor/conductor-session-driver.ts`) が worker 実行中でなく、解除済み held batch も他の eligible trigger もないと判定した operator message の配送条件。 | agent や session の停止判定ではない。選択後に lifecycle、turn 上限、予約等で送信に至らない場合がある。 |
| operator-agent UI の `待機中` | `runTtyConversation` (`packages/operator-agent/src/run/run-operator-conversation.ts`) が reconnect 後や send 処理の `finally` などで設定する表示 status。 | queue が空、send lease がない、input が開いている、次の batch を送れる、を保証しない。 |
| operator-agent の no-batch 待機 | `runTtyConversation` が `selectBatch` から batch を得ず、`nextReadyAt` に基づく期限または queue change を待つ状態。詳細は次の「operator-agent の batch 待機」。 | UI status ではなく、conductor の `waitForDispatchBatch` とも別の待機。待機解除は batch 選択や送信成功を意味しない。 |
| Issue-session TUI の conductor status 時計 | `IssueSessionTui` / `IssueSessionTuiStream` (`packages/cli/src/tui/issue-session-tui.tsx`, `packages/cli/src/tui/issue-session-tui-stream.tsx`) が `conductorStatus.since` からの経過秒を定期再描画する。 | 秒表示の更新は status 本体の更新や harness phase の遷移ではない。 |
| watch の idle candidate | `evaluateOperatorIdleCandidate` (`packages/operator-agent/src/dispatch/operator-idle-candidates.ts`) が live UDS 観測の `harnessPhase: idle` が閾値を超えた場合等に作る確認 report。`running` の古い statusLine も別 candidate になる。 | worker 停止・失敗・停滞、Issue 作業の未完了の証拠ではない。長い正常処理もあり得る。 |
| operator-agent の `inputEnded` | `runTtyConversation` (`packages/operator-agent/src/run/run-operator-conversation.ts`) の stdin `end` または `/exit` 後に、新しい入力を受け付けない状態。loop は pending user と reconnect がなくなると return 可能。 | send suppression、process teardown、`/exit` であること、pending report の処理完了と同義ではない。 |
| operator-agent の `requestStop` / `stopping` | `runTtyConversation` (`packages/operator-agent/src/run/run-operator-conversation.ts`) の SIGINT・SIGTERM・TUI interrupt 等による send 抑止。input を無効化し、`sendSuppression` を abort して競合待機を起こす。 | stdin の end や `/exit` と同じ意味ではない。send 結果を得ないまま return し、lifecycle lease が残る経路もある。 |
| Issue loop の停止 | `shouldStopIssueLoop` (`packages/core/src/conductor/session-policy.ts`) と `shouldBreakAfterLoopState` (`packages/core/src/conductor/conductor-session-driver.ts`) が Issue conductor の自律ループを抜けるか判定する。 | conductor session 全体や harness process の終了ではない。`continueAfterIssueLoopStop` や pending event により待機を続ける場合がある。 |
| session の close / exit / interrupted | `requestOperatorShutdown` または process shutdown signal が driver を止め、`conductor-session.ts` の `finally` teardown が `closed` / `exited` / `interrupted` を保存する。 | Issue loop の stop reason や operator-agent の会話 return 値だけからは決まらない。close / exit / signal interruption の差は「conductor session の shutdown handoff」に記す。 |

### conductor 側の状態遷移と非同期境界

| TS 関数・操作 | trigger / guard | 状態更新・次の境界 | Lean との関係 |
| --- | --- | --- | --- |
| `ConductorDispatchLifecycle.beginSend` (`packages/core/src/conductor/conductor-dispatch-lifecycle.ts`) | `canDispatch` が true。 | send lease を設定して listener に同期通知。driver (`packages/core/src/conductor/conductor-session-driver.ts`) は選択 batch の event を queue / held list から除き、以後 send promise を待つ。 | `ConductorQueue.beginDispatch` と `Composition.step` の `conductorBeginSend`。selection、queue 除去、reservation の全条件は一対一対応していない。 |
| `settleConductorDispatch` → `settleSend` (`packages/core/src/conductor/conductor-dispatch-lifecycle.ts`) | send の完了・失敗結果。Issue workflow では `finished` / `completed` / `running` を完了扱い。 | lease を解除。完了は attention と failure class を消し、未完了は通常 attention を立てる。shutdown 時は recovery capture を抑制する。 | `conductorSendResult` の局所対応。send の結果が返らない中断や teardown 順序は未接続。 |
| `beginReconnect` → `settleReconnect` (`packages/core/src/conductor/conductor-dispatch-lifecycle.ts`) | reconnect event が選ばれ、active lease がない。send dispatch 不可でも reconnect は開始可能。 | lease を設定し、外部 reconnect を await (`packages/core/src/conductor/conductor-session-driver.ts`)。結果は availability に反映するが attention は保持する。成功後も driver は通常の selection loop に戻るだけ。 | `conductorBeginReconnect` / `conductorReconnectResult`。結果・履歴の全対応は未証明。 |
| `setAgentAvailable` / `confirmRecovery` (`packages/core/src/conductor/conductor-dispatch-lifecycle.ts`) | 自動 reconnect callback、または attempt ID に合う明示確認。 | 前者は availability のみ変更。後者は active lease がなく pending attention が一致すると attention のみ解除する。`wake` は listener 通知だけ。 | lifecycle の局所状態は対応するが、非同期 callback と外部入力の順序はモデル化していない。 |
| `SessionEventQueue.enqueue` (`packages/core/src/conductor/session/session-event-queue.ts`) → `selectDispatchBatch` (`packages/core/src/conductor/session/select-dispatch-batch.ts`) | event 到着。queue API に登録 waiter があれば直接 resolve、なければ queue に格納。 | listener 通知は同期的。現行 driver は batch wait から queue snapshot を選択し、個別 event waiter を使う legacy API は使わない。selector は batch を返すだけで、dispatch 開始は `beginSend` 後。 | `conductorEnqueue` / `chooseDispatch`。waiter への直接配送、全 priority・複数 item batch は未接続。 |
| `bufferDispatchHoldEvents` (`packages/core/src/conductor/session/dispatch-hold.ts`) / `waitForDispatchBatch` (`packages/core/src/conductor/conductor-session-driver.ts`) | dispatch hold 中、または dispatch がまだ選べない。 | hold 対象を driver-local `heldEvents` に移す。operator message、reconnect、permission stall は hold 対象外。解除後に再選択する。held list はここで SessionResumeStore に永続化されない。 | `ConductorQueue.bufferHold` 等の限定対応。permission 失効、通知、永続化は未接続。 |
| `shouldStopIssueLoop` (`packages/core/src/conductor/session-policy.ts`) → `shouldBreakAfterLoopState` (`packages/core/src/conductor/conductor-session-driver.ts`) | send 結果、worker / permission / open question / turn 状態を評価。 | stop 条件でも recovery attention、held event、worker inbox drain、`continueAfterIssueLoopStop` により driver が続くことがある。最後に driver が return してから session teardown が進む。 | 抽象 `stopped` に直接対応する TS field はない。session shutdown と Issue loop stop も別状態。 |
| `sendConductorWithReconnect` (`packages/core/src/conductor/conductor-send-reconnect.ts`) | `agent.send` の結果が認証 / transport 系失敗で、signal 等の条件を満たす場合。 | reconnect を最大一度試みるが、元 prompt を自動再送しない。戻り値と availability callback は別に lifecycle / recovery 状態へ反映される。 | 外部 send / reconnect 結果として部分抽象化。TS 実通信、認証、同一 prompt の副作用はモデル外。 |

`shouldStopIssueLoop` の条件は、`cancelled` / `send_rejected`、継続設定のない `error`、one-shot の未回答条件、worker / permission / open question、turn 内 dispatch 数等である。`maxTurns` 到達は許可 event の選別に影響する一方、operator message・reconnect・permission・recovery report は送れる経路がある。したがって「turn 上限に達した」「Issue loop が止まった」「session が終わった」を同一視できない。

#### conductor session の shutdown handoff

`/close` と `/exit` は `bindOperatorInput` の command 分岐から、UDS の `operator.session.shutdown` は同じ `requestOperatorShutdown(mode)` から入る。要求を受けると、まず mode 別の `session.operator_close` / `session.operator_exit` event を記録し、`workerSession.runtime.cancelAllActivePrompts()` を同期呼び出しして active prompt の `session/cancel` を開始する（cancel の完了は待たない）。その後で `operatorRequestedClose` / `operatorRequestedExit` を設定し、`shutdownIntentController.abort()` を呼んでから、`abortAfterOpenQuestionDrain(operatorTerminationController)` を開始する。control server に in-flight request がなければ `quiesce()` の開始後すぐ driver 用 controller を abort する。in-flight request があれば drain の成功・失敗または timeout まで待って abort する。timeout / drain failure は warning を記録しても abort に進むため、受理済み Open Question の通知結果が不明なまま残る場合がある。

内部 shutdown controller を使う通常の process signal 経路では、SIGINT / SIGTERM handler が controller を abort し、`onShutdownSignal` が `shutdownIntentController` を abort したうえで同じ drain 手順を `drainedShutdownController` に対して始める。`driverShutdownSignal` は `drainedShutdownController.signal` と operator 用 `operatorTerminationController.signal` の `AbortSignal.any` である。signal handler は session が controller を所有し、`registerProcessSignalHandlers` が false でない場合に限り登録される。

| 契機 | driver と teardown の見える遷移 | 確認できる差・限界 |
| --- | --- | --- |
| operator `/close` | drain 後に driver は shutdown を `interrupted` として返す。session は operator が close / exit を要求している場合、その `interrupted` を result 作成前に `completed` へ写し替える。teardown は `closed` を保存し、attached worker の ACP session 情報を resume state に写し、`closeConductorAgentOnce(..., { forResume: true })` を呼ぶ。 | close 固有の resume handoff がある。isolated worktree を削除する exit 分岐には入らない。実際に provider session が後続 process で復元できるかはここだけでは証明しない。 |
| operator `/exit` | driver と `stopReason` の写し替えは close と同じ。teardown は `exited` を保存し、通常の `closeConductorAgentOnce` を呼ぶ。stop reason が `interrupted` でなければ isolated worktree の削除を試す。 | close 固有の attached-session snapshot / `forResume` は行わず、exit の worktree cleanup がある。remove の実成否は別結果であり、失敗時は warning として処理される。 |
| SIGINT / SIGTERM 等の session shutdown signal（operator close / exit flag なし） | drain 後 driver は `interrupted` を返し、result も `interrupted` のまま。teardown は `interrupted` を保存し、force shutdown を行う。 | close 専用の resume snapshot / `forResume` と exit 専用の worktree cleanup のどちらも実行されない。保存済み state からの再開可否や provider 側の実状態は静的コード読解だけでは確定しない。 |

この shutdown handoff は `shouldStopIssueLoop` とは別である。Issue loop の stop 条件は `shouldBreakAfterLoopState` が判定し、`waitForOperatorExit` が true なら driver は post-loop wait を続ける。したがって Issue loop が止まっても session shutdown signal は発生しない。false なら driver は loop を終えて teardown へ進み得るが、close / exit / process signal の lifecycle label は operator flag または shutdown signal によって別に決まる。実際の signal と Open Question request の race、外部 agent の cancel / close の結果、teardown 中の process 強制終了を含む順序は runtime で確認していない。

### operator-agent 側の状態遷移と非同期境界

| TS 関数・操作 | trigger / guard | 状態更新・次の境界 | Lean との関係 |
| --- | --- | --- | --- |
| `handleSubmittedInput` (`packages/operator-agent/src/run/run-operator-conversation.ts`) | 空白でなく `inputEnded` 前。通常入力は recovery byte limit を queue 側でも検査。 | UI に表示し、user event を queue へ加え、conversation hold を設定する。`/exit` は `inputEnded` と `exitContinuity` を設定し、hold 解除や新規入力は受け付けない。`/reconnect` は pending count を増やす。`/resume-watch` は conversation hold のみ解除する。 | `operatorInput` / `operatorInputEnd` / reconnect / resume-watch。表示、command parsing、全 input guard は未接続。 |
| `selectBatch` (`packages/operator-agent/src/dispatch/operator-dispatch.ts`) | lifecycle が dispatch 可。selection clock で deadline を評価。 | user が report より優先。focus、Open Question、continuation、normal / aged idle / FIFO 等で report を選ぶ。戻り値は選択に過ぎず、queue commit も send もまだ行わない。 | `OperatorDispatch.Queue.selectBatch`。実 `Date.now`、focus timeout、全重み設定は限定抽象。 |
| `runTtyConversation` の selection loop (`packages/operator-agent/src/run/run-operator-conversation.ts`) | lifecycle が dispatch 可で、idle candidate gate refresh 後に `selectBatch` が `undefined`。 | 同じ `selectionTime` で `nextReadyAt` を問い合わせ、`waitForChange(waitMs)` と `stopping` を race する。最短の既知 deadline があれば timer で起きて再選択する。deadline が `undefined` なら queue notification か `stopping` まで timer なしで待つ。lifecycle / recovery inbox の subscription も queue を wake する。 | Lean に `selectBatch` の結果なしを独立した待機状態としては置いていない。deadline、queue wake、停止 race の対応は未接続。 |
| reserve → `beginSend` → `commitBatch` (`packages/operator-agent/src/run/run-operator-conversation.ts`, `packages/operator-agent/src/watch/operator-watch-dispatch.ts`) | 選択 batch に対する recovery reservation を確保できる。 | lease を取ってから `retryWatchLock` 経由で commit を await。user / frozen report は同期 queue commit。通常 report は lock 取得後に再検証し、queue と manifest を更新する。commit 後、`agent.send` 呼び出しまでは同期区間として実装されている。 | `operatorBeginCommit` / `operatorCommitApply` / `operatorCommitSuccess` 等。lock・永続化・event-loop 順序は未接続。 |
| `retryWatchLock` (`packages/operator-agent/src/run/run-operator-waiters.ts`) が停止を返す | `sendSuppression` abort、または操作開始後の `inputEnded`（retry 保存時は終了前からの inputEnded も停止条件）。 | commit 待機後に停止と判定すると reservation を release し lease を completed として settle して return。queue commit 済みなら user item を queue に戻す処理はない。 | `operatorCommitStopped` / `operatorRetryStopped` に対応。同期 commit 直後の停止が実際に await 継続より先行するかは未確認。 |
| send race → `settleConductorDispatch` (`packages/operator-agent/src/run/run-operator-conversation.ts`) | commit 成功後に `sendConductorWithReconnect` と `stopping` を race。 | send 結果が先なら通常 settle。停止側が先なら result は未定義で return し、reservation を release するが、この経路では active lease を settle しない。send の外部完了順は未確認。 | `operatorSendResult` / `operatorInterruptSend`。実 Promise race 全順序は未証明。 |
| send 結果後の report ack / retry (`packages/operator-agent/src/watch/operator-watch-ack.ts`, `packages/operator-agent/src/run/run-operator-conversation.ts`) | send 完了時は report acknowledgement。未完了時は report retry 時刻保存と requeue。 | ack は最大 4 回試行し、成功 send 自体を再送しない。ack retry 枯渇では runner を止め、pending report を保持。再起動で同 report ID を再配送する場合がある。user input の失敗は queue に戻さず、条件に応じ recovery snapshot を保存する。 | `operatorAckResult` / `operatorAdvanceAck` / `operatorRetryResult`。永続化・再起動の replay は対象外。 |
| `handleInputEnd` / loop top (`packages/operator-agent/src/run/run-operator-conversation.ts`) | stdin `end`。または `/exit` が `inputEnded` にする。 | `inputEnding` を abort して queue を wake。loop は `inputEnded && pendingUserCount === 0 && pendingReconnects === 0` で return 可能。条件式に pending report 数は含まれない。 | `operatorFinishInput` はモデル上の return 条件を抽象化するが、全 control point の照合は未完了。 |
| `requestStop` / outer `finally` (`packages/operator-agent/src/run/run-operator-conversation.ts`, `packages/operator-agent/src/run-operator-agent.ts`) | SIGINT、SIGTERM、TUI interrupt、ack retry 枯渇など。 | `sendSuppression` を abort し、input を無効化する。`runTtyConversation` return 後は watch pool / agent を閉じる。`/exit` のみ `exitContinuity` を通じ operator-agent state を削除し、通常 return は次回選択用 state を残す。 | `operatorRequestStop` の後に `operatorWaitStopped` が dispatch 不可の待機から return する経路を限定的に表す。保存 state、外部 resource teardown、再起動との連続性はモデル外。 |

#### operator-agent の batch 待機

上の no-batch 分岐は `runTtyConversation` の選択 loop 内で、send 可能な lifecycle を確認し、必要なら idle candidate gate refresh を終えた後に動く。`nextReadyAt` は queue 内の user `readyAt`、report の batch / retry / debounce / aging、focus inactivity など、queue が算出できる次の deadline の最小値を返す。deadline 到達は選択を確約せず、loop が再選択するだけである。held など現在 `pending` にない item や、selector が deadline を算出できない状態では timer が設定されず、queue wake を待ち続けることがある。

`waitForChange` は queue mutation / `wake()` で解け、`runTtyConversation` は dispatch lifecycle と recovery inbox の change を queue wake に結び付けている。これに対して `stopping` を解くのは `requestStop` であり、SIGINT / SIGTERM / TUI interrupt 等から input 無効化と `sendSuppression.abort()` を行う。stdin `end` / `/exit` の `handleInputEnd` は `inputEnded` を立てて queue を wake するが、`stopping` は解かない。loop top は pending user と reconnect がなければ return でき、その判定に pending report 数は含まれない。pending user が残る場合は入力終了だけで no-batch wait を抜けるとは限らない。

この待機中に UI status を `待機中` へ設定する処理はない。その status は reconnect 後や send の `finally` で設定される表示値である。また conductor の `waitForDispatchBatch` は `SessionEventQueue`、dispatch lifecycle、recovery inbox の change と shutdown signal を待つ別関数で、operator queue の `nextReadyAt` に相当する期限 timer は持たない。いずれも wait 中の永続 lifecycle label ではなく、wake 後の再選択・dispatch 成功も保証しない。

### 二つの主体の通信は明示的な handoff を通る

| 向き | TS の経路 | 状態変化と境界 |
| --- | --- | --- |
| harness / operator → Issue conductor | UDS `operator.message.send` (`packages/core/src/session/open-question-control.ts`) → callback `sendOperatorMessage` (`packages/core/src/conductor/conductor-session.ts`) → `enqueueOperatorMessage` → `SessionEventQueue.enqueue`。 | UDS handler は callback を await し、text / delivery を検証する。この method は queue 受理専用で、Open Question を参照・更新しない。queue API は waiter への直接 resolve も持つが、現行 driver は queue change を待ち、batch を選択する。 |
| operator message の `delivery: next / idle / interrupt` | TTY command parser (`packages/core/src/conductor/operator-command.ts`) または UDS input から `sendOperatorMessage` / `submitOperatorMessage` を経て queue へ入る。`enqueueOperatorMessage` が受理した後、`onOperatorMessageQueued` が interrupt 専用処理を行う。 | `next` は通常の operator trigger として選択される。`idle` は `canDispatchIdleOperatorMessage` が worker 実行中でない・dispatch 可能な held batch がない・他の eligible trigger がない場合だけ選択対象になる。`interrupt` は queue 受理後に `conductor.cancel?.()` を fire-and-forget で試す。呼び出し側は cancel 完了を待たない。cancel API がなければ warning を出し、拒否された場合も warning のうえ通常 dispatch に任せる。cancel 失敗時に interrupt event が特別な selector priority を得るわけではない。 |
| conductor send の cancel 結果 → 次の operator dispatch | `conductor-session-driver.ts` の初回 / in-flight send 結果処理と `waitForDispatchBatch`。 | in-flight send は結果が `cancelled` で、その時点の queue snapshot に `delivery: interrupt` の operator message が残っていれば、現在の run の終了を Issue loop stop とせず loop を続けて次を選択する。初回 send の結果処理でも同じ event 条件で recovery confirmation を要求しない。判定は cancel 結果と queue 内 event の共存であり、特定の cancel 呼び出しとの因果 ID は照合しない。 |
| operator → Open Question 回答 | UDS `open_questions.answer` (`packages/core/src/session/open-question-control.ts`) → `answerOpenQuestion` (`packages/core/src/conductor/conductor-session.ts`)。 | YAML へ回答を durable write した後、`submitOperatorMessage` / `submitOperatorInput` で回答を適用し、`operator.message` を enqueue。dispatch receipt が完了するまで待つ別経路。 |
| operator-agent 内の利用者 → operator-agent model | `handleSubmittedInput` (`packages/operator-agent/src/run/run-operator-conversation.ts`) → operator dispatch queue → commit → `agentHandle.send`。 | これは operator-agent 自身の model turn。上記 UDS method を自動呼出しせず、Issue conductor event も自動生成しない。conductor への発話は別の明示 tool / UDS call が必要。 |
| Issue conductor / watched session → operator-agent | watch pool の UDS poll / live observation → report persistence / dispatch queue → operator-agent model。 | report 到着、保存、ack は複数 await と lock を通る外部通信。watch report の受理を conductor の send 成功や利用者への到達確認と同一視しない。 |

`operator.message.send` の `{ queued: true, delivery }` と TTY 側の受理結果は queue への受付を示し、conductor への dispatch receipt ではない。`interrupt` の cancel が成功しても、その外部 agent / provider が実行中 run をどう終端するかは API の返却と driver が受け取る `cancelled` 結果を越えて保証できない。cancel が起きない場合や失敗時の通常 dispatch も、turn 上限・lifecycle・queue の他 event による selector 判定を経るため即時送信を保証しない。process SIGINT / SIGTERM による session shutdown の `interrupted` と `delivery: interrupt` は別の操作である。

この分離は `Composition.lean` の冒頭コメントとも一致する。`operatorMessageDelivered` と watch report は外部入力として与え、operator model の send から conductor への自動 handoff は仮定していない。

### 事実・モデル上の仮定・未確認事項

| 区分 | 内容 |
| --- | --- |
| TS から確認できる事実 | lifecycle は lease / availability / attention を別々に保持する。reconnect settle は availability しか更新しない。operator-agent は選択、commit、send、settle、report ack を別の処理段階に分ける。no-batch selection は deadline / queue change / `stopping` を race する。conductor shutdown は control drain 後に driver signal を abort し、teardown が mode 別 lifecycle を保存する。interrupt delivery は queue 受理後に cancel を試し、未対応・失敗時も通常 dispatch に残る。 |
| Lean に置いたモデル上の仮定 | reconnect 結果、send 結果、到着、tick、reservation 可否、retry lock の停止・例外等を環境 event として選ぶ。`RecoveryPossible` は回復 event だけからなる有限列の存在を要求する。これらの環境 event が TS でいつ・どの状態から可能かは、現在の全体モデルでは制約されていない。 |
| 未確認 | 同期 user commit の queue 更新後、解決済み Promise の await 継続より外部 stop callback が先行して `retryWatchLock` の停止分岐に入る実行があるか。停止通知・Open Question request・teardown の全 callback 順序、cancel 呼び出しが provider 上で現在の run をどう終端するか、保存と process teardown の race が再起動後に何を再配送するかは未確認。 |
| 有限探索からは言えない | 固定操作・固定値・有限深さで candidate が見つからないことは、無限実行での弱公平性や全 parameter の到達不能を示さない。有限実行だけのモデルで「いつか dispatch」の性質が空虚に真となる可能性もある。 |

### 回復可能性と「見かけ上の回復経路」

現行 TS に process 停止後も同じ runner を再起動する単一の `stopped` field はない。回復を論じるには、(1) runner / process が生きているか、(2) lifecycle lease が空か、(3) agent が available か、(4) attention が解除されたか、(5) pending item と hold / retry / frozen 条件が dispatch 可能か、(6) transport が実際に次の send を受けるかを分けて確認する必要がある。Lean の `State` にある `LifecycleReady` はこのうち lifecycle 条件、`Eligible` は item 条件を加えたモデル上の述語であり、TS 全体の生存性を表す述語ではない。

- conductor の `/reconnect` 成功は availability を true にし得るが、pending attention を消さず、turn 上限や hold も解除しない。したがって成功 callback だけを dispatch 再開の証拠にしない。
- operator-agent の `/reconnect` は同じ session 内の pending reconnect を処理する。send / commit の停止や `requestStop` 後に return 済みの runner を復活させる命令ではない。
- `confirmRecovery`、`/recovery continue`、`/resume-watch`、hold 解除はそれぞれ別 gate に作用する。対象外の gate、queue の不在、期限待ち、停止済み runner を一括して回復させない。
- operator-agent の commit 後停止 candidate では、TUI に表示された文字列とローカル batch がある一方、queue から user event が除かれ、recovery reservation は本文 snapshot ではなく容量枠で、停止分岐は snapshot commit / `agent.send` に到達しない。これは「全ての記録から入力が消えた」と確認された事実ではない。固定 Lean 射影の反例と、それに対応する TS の関数分岐は確認済みだが、当該 stop 順序の TS runtime 到達性は未確認なので、実障害ではなく反例候補として扱う。
- `StoppedRecovery` では、user send failure の confirmation と後続 input を保った runner が dispatch 不可の wait 中に stop signal を受けて return する具体 event を加えた。限定回復操作の任意有限列で stopped / attention が保たれ、eligible へ戻らない。retry 保存待ちに EOF が割り込む仮定は使わない。
- ただし候補観測は runner の停止を含めず、同じ live concrete history は recovery continue 後に eligible となる。`HistoryRecovery.no_fixed_transition_exact_correspondence` は、この観測・操作集合で一つの固定 abstract `Transition` が両 concrete history の回復可能性を同時に正確化できないことを示す。これは #855 `RecoveryPossible` の反例ではなく、候補射影による経路を停止履歴からの recovery と扱えないことを示す。

以上の静的照合は関数・状態・遷移候補を絞る根拠であり、await 境界の runtime 順序、全 event の状態写像、プロセス再起動を含む end-to-end の回復を証明しない。

## PR #879 の結果と確度

[PR #879](https://github.com/otolab/agents-ensemble/pull/879) は #859 の完了報告ではなく、現在の合成モデル接続と限定証明を積んだ途中成果である。レビューの承認も、この部分成果に対するもので #859 全体の完了判定ではない。以下は PR の差分・説明・レビューと、この worktree の Lean 定義・証明を対応させた読み方であり、PR の検証コマンドを今回再実行したという意味ではない。

| 結果 | 確度 | ここからは言えないこと |
| --- | --- | --- |
| commit 後停止の固定 Lean 射影で `NoEventLoss`、`AcceptedEventRetained`、`ObservationConsistent` が成立しない。固定した4操作・固定値で長さ3以下の85列を調べ、その範囲では提示列が最短。 | その固定モデル列と固定探索範囲に対する定理・探索結果として確定。 | TS がその停止順序へ到達すること、合成モデル全体や #855 の三性質が不成立なこと、全入力の内容が消失することは示さない。 |
| TS の user `commitBatch` は queue を同期更新した後に Promise を返し、caller は `await retryWatchLock(...)` の後で stopped 分岐を判定する。 | 関数の制御順序として確認済み。固定射影を調べるべき根拠になる。 | queue 通知や他 callback が await 継続より前に停止を届ける実際の runtime trace は確認されていない。したがって stop-before-send は **TS 到達性未確認の反例候補**。TUI dialogue 等の別保持先もあり、全記録から入力が失われたとの結論ではない。 |
| confirmation wait で保留 input を持つ runner が stop signal で終了し、同じ runner は限定回復操作で eligible に戻れない。live 側の同一候補観測には recovery continue 後の存在経路がある。 | Lean の concrete trace・任意有限長 no-path・候補観測の識別不能定理は build 済み。TS failure / confirmation / pending input と `stopping` return は、既存 test と静的 path を分けて照合した。 | 2 つの TS 振る舞いを一つの runtime test では通していない。再起動は対象外。#855 `RecoveryPossible` の違反でも、全履歴付き接続の不可能性でもない。 |
| reconnect・上限待機を繰り返す限定無限列が対象選択を行わない。 | その限定列が #855 の弱公平性前提を満たさないことを確認済み。 | `ReconnectResumes` の反例ではない。有限探索や有限 prefix だけでは公平な無限実行の有無・到達不能を決められない。 |

したがって PR #879 の反例候補は「Lean の固定射影では確かな結果」と「TS の実行可能性が未確認」を分けて扱う。TS 全体から抽象状態への対応を示せない限り、後者を実障害または #855 の反例として報告しない。

## TS と Lean の対応

| TS の対象 | 合成モデルの状況と限界 |
| --- | --- |
| conductor の batch 選択・send・reconnect | `ConductorQueue` と lifecycle を接続。非同期 driver の全停止・割り込み・予約失敗は未対応。 |
| operator の input、hold、send、retry 保存、ack、reconnect | `OperatorDispatch` を接続。commit 待機を分離し、成功後の同期的な send 開始までを同じ遷移とする。永続化と外部通信の詳細は未対応。 |
| operator `selectBatch` が no-batch を返す待機 | `selectBatch` のみを対応付ける。`nextReadyAt` の deadline timer、queue change / lifecycle wake、`stopping` との race はモデル化していない。 |
| conductor `requestOperatorShutdown` / process signal / teardown | close / exit / interrupted の mode flag、Open Question control drain、driver abort、teardown label、close 専用 resume handoff と exit worktree cleanup はモデル化していない。 |
| conductor operator message `delivery` | operator message 到着は外部入力として扱う。`next` / `idle` の dispatch gate と `interrupt` cancel / cancelled-result fallback の関数境界は合成 model に接続していない。 |
| `handleInputEnd`、`/exit`、`handleSubmittedInput` | 入力終了後の通常入力・reconnect・resume-watch・recovery continue は受け付けない。`/exit` の戻り値 `exitContinuity` や focus 等の表示操作は未表現。 |
| `retryWatchLock` の retry 保存 | 入力終了または `requestStop` 後の停止、timeout 以外の例外、成功を区別する。lock の timeout 回数や操作の開始・完了タイミングは外部から与え、実際の lock や保存自体は表さない。 |
| 入力終了後のループ終了 | pending user と reconnect がなく、send・retry・ack 等の処理が終わった時点で終了可能とした。driver の control point を厳密には表しておらず、他の途中状態との網羅的な照合が必要。 |
| 両主体間の通信 | operator message の conductor 到着や watch report は外部イベントとして与える。transport、poll、重複、再起動、プロセス間競合は表さない。 |

`operatorRequestStop` は停止要求を記録するが、TS の TUI 無効化、signal、他の待機処理への同時作用を完全には再現していない。たとえば別の遷移が停止要求と競合する場合の順序は未検査である。したがって合成モデル上の任意の経路を TS の実行と同一視できない。

## ADR 0086 §7 と停止境界

ADR §7 が純粋 step 関数への**差分テスト**から除くのは、非同期 driver 全体、lock 競合、プロセス間競合である。停止結果や停止後に残る lifecycle・queue まで検査対象から除外する趣旨ではない。Phase 0 の本作業では TS を静的に照合し、観察する停止境界を明示する。実際のスレッド間順序や lock の網羅、TS との実行時差分・イベントログ検証はここでは実施していない。

| TS の待機箇所 | モデル上の扱いと残る限界 |
| --- | --- |
| send と `stopping` の race | 停止要求後に send 中断を選ぶと runner は停止し、lease を残す。send 結果が先に得られる競合もあり得るが、Promise の完了順序を実行時に検証していない。 |
| retry 保存 | 入力終了または停止要求による通常停止と、例外を区別する。timeout の再試行中も入力終了で停止し得る。 |
| ack retry の待機 | `waitForAcknowledgementRetry` は ack から既定値で呼ばれるため、入力終了ではなく停止要求で止まる。ack 操作自体の完了・失敗は外部結果として扱う。 |
| batch commit の待機 | 選択・予約・lease 取得後を保持し、停止時に reservation を解放、lease を settle して終了する。commit 前と queue 更新後の停止を区別する。reservation の識別子と byte 数を保持し、予約容量の可否は外部から与える。例外時の rollback は `afterCommitError` を使う。 |
| reconnect・idle 待機 | TS は停止 signal により待機を抜け得る。合成モデルには要求・結果はあるが、待機箇所ごとの停止境界は未表現。 |

reconnect・idle 待機の行は、単に lock 競合の全列挙が対象外という話ではなく、対象とする停止結果が具体モデルにまだ含まれないという未達である。予約から lease 取得までの同期区間は単一の `operatorBeginCommit` 遷移であり、commit 成功後の同期区間も send 開始と一体にする。送信結果の予約有無・capture 設定は保持した状態から決め、空入力には予約を作らず、入力 byte 数の上限を確認する。ただし snapshot の容量・期限切れ・dispose と外部入力 `reservationOk` との整合、reservation token の失効、他の非同期 control point の全イベント制約は未検査である。静的照合は TS との対応の根拠になるが、実行時テストや網羅性の証明にはならない。

容量などを外部結果として扱う場合、具体経路として使うには、TS の inbox 状態でその結果が実際に起き得ることが前提となる。モデルはこれを検証しないため、`reservationOk` を任意に選ぶ探索は過大近似である。そこで見つかった列を、実行可能性を別途確かめず TS の反例とは扱わない。

user batch と凍結済み batch の queue commit は `commitBatch` の呼び出し中に実行され、その後に await が制御を戻す。未凍結 report は lock の取得後、`isBatchCurrent` で再選択してから同期的に queue 更新と永続化を行う。モデルでは user と凍結済み batch の queue 更新を待機開始と同じ遷移に置き、report は待機中の callback と再選択、queue 更新後の callback を区別する。lock 解放失敗や永続化例外の細かな時点までの全経路はまだ照合していない。

## #855 の性質

[Issue #855](https://github.com/otolab/agents-ensemble/issues/855) の抽象仕様を変更せず、現行 TS からの忠実性を判定対象とする。#855 の `RecoveryPossible` は回復操作と環境結果・tick を含む有限列の存在であり、回復の実行・環境結果の成功・最終配信を保証しない。公平性を使う命題も scheduler の弱公平性を前提にする一方、選択後に dispatch へ進む条件は別途必要である。

| 性質 | 確認できた範囲 | #855 との分類 |
| --- | --- | --- |
| `ObservationConsistent` | retry の正常列は限定観測で追跡できる。commit 後停止の固定射影は不整合。refresh 前後で retry / 時刻 / 追跡 item の観測値が同じでも、具体 queue の期限と selector 結果は異なる固定列がある。 | **限定射影で不一致、全体は未判定**。retry の二列は観測から concrete selector を再現できない例だが、全遷移の対応や抽象 `schedule` の時点を定めていないため、`ObservationConsistent` 自体の反例とはしない。停止列の TS 到達性も未確認。 |
| `RecoveryPossible` | `StoppedRecovery` は confirmation と後続入力を持つ runner を `requestStop` 後に return させ、宣言した回復操作10種の任意有限列でも eligible に戻らないことを証明。live 側の同一候補観測では recovery continue 後に eligible となる。`HistoryRecovery.no_fixed_transition_exact_correspondence` は、この2履歴の concrete 回復可能性を一つの固定 abstract `Transition` と候補観測で同時に正確化できないことを証明。retry report の reconnect 後 dispatch は別の具体 witness。 | **履歴別の concrete 存在／不存在は限定範囲で確認、#855 への接続は未判定**。#855 の `RecoveryPossible` 自体の反例ではない。`projected_recovery_exists` は live 側からの経路を状態射影で splice した候補であり、stopped 履歴からの経路ではない。 |
| `ReconnectRestoresAvailability` | operator の有効な成功結果は主体別履歴の局所定理と、今回の有限列で確認。conductor は具体状態の局所定理まで。 | **有効な成功結果の範囲で一致**。両主体の全遷移との観測接続は未判定。 |
| `ResumeWatchPreservesReportHold` | 主体別履歴で resume-watch 前後の手動 report hold を保持する局所定理を証明。 | **対象操作の範囲で一致**。全体の遷移関係と観測の完全性は未判定。 |
| `ReleaseIndependent` | operator 側4種類の解除を固定7操作 alphabet の長さ4以下2801履歴それぞれに適用し、保護 field を検査。conductor は held worker を含む具体状態で dispatch-hold 解除を個別検査。 | **候補観測・固定履歴で field を確認**。operator の物理 held は `observeDispatchHeld` が隠す。conductor は解除の一具体状態のみ。全 item・全遷移の判定は未達。 |
| `NoEventLoss` | retry 保存後を開始状態にした固定列では report A が reconnect 後の B dispatch 中も期限まで queue と履歴に残る。refresh 前後の比較列でも A はどちらも pending で、commit 後停止の固定射影では別の不一致がある。 | **retry の固定部分列では保持、停止射影では不一致、全体は未判定**。この確認は一般証明ではない。 |
| `AcceptedEventRetained` | retry 保存後の A と B の保持を固定履歴で確認。refresh 前後の比較列では追跡 item の状態は同じ。commit 後停止の固定射影では受理直後からの保持が成立しない。 | **retry の固定部分列では保持、停止射影では不一致、全体は未判定**。 |
| `NoAutomaticInputReplay` | input ID 7 / 8、6種類の未完了結果 profile、5操作・長さ4以下781列（計9,372組合せ）で同一 ID の再 dispatch はない。 | **固定有限範囲では一致、全遷移は未判定**。`other` / `running` と failure class の組合せは Lean の値域で、TS runtime の全 status 組合せや到達性を示さない。 |
| `ScheduledDispatches` | operator input の受理後、選択印は記録されるが send 開始前の固定列を検査。4操作 alphabet の長さ1以下5列では該当せず、この列は同範囲で最短。 | **選択と schedule の対応次第で不一致、対応自体は未判定**。 |
| `HoldExemptDelivered` | `FairExecution.lean` の限定遷移系で `ScheduledDispatches` から条件付き定理を導出。実行例には選択前の eligible 状態があるが、dispatch 後は対象が pending でなくなるため、どの suffix も「常時 eligible」ではない。別の対照モデルでは対象が常時 eligible で毎回 schedule され、公平性前提は有効だが dispatch に至らない。 | **限定モデルの条件付き定理のみ**。dispatch 例の `SchedulerFair` は antecedent が偽で成立する。対照例は `ScheduledDispatches` がない場合の公平性単独の限界を示すもので、Composition / TS の実行ではない。TS 全体の公平性・選択後進行は未判定。 |
| `ReconnectResumes` | refresh 前後の retry A/B 選択差に加え、上限到達後の reconnect 成功、dispatch hold が残る reconnect 成功、operator input 後の再開を `ReconnectExploration` で検査。 | **固定具体列で停止要因ごとの差を確認**。有限探索は以下の限定範囲で最短性も検査する。上限・hold が残る例は `EligibleUntilDispatch` を満たさず、#855 の弱公平な命題の反例ではない。全体の公平実行・選択後進行は未判定。 |

session 別 retry では TS selector の候補可能性と #855 の `Eligible` の一致に具体差がある。`frozen_blocks_other_report` が示すのは「物理 frozen と項目別 eligibility をそのまま保存するこの射影では B が eligible でない」という範囲であり、`ObservationConsistent` 自体の反例や、全観測の不可能性ではない。TS が B を選んだことを #855 の `schedule B` にどう対応させるか、単一 `retry` と複数期限の関係をどう保持するかは未解決である。

ここでいう具体履歴への片方向の含意は、具体遷移の両端を射影した遷移で**元命題が成立する場合**の一般定理である。全履歴の観測・イベント対応を構成したという意味でも、抽象経路を具体経路へ逆向きに持ち上げられるという意味でもない。

### 具体履歴の直接検査と #855 との対応

以下の有限探索は同じ `System` の `step` を逐次適用し、抽象状態の一致によって別の具体状態を継ぎ合わせない。TS の外部結果・実行順序はモデルへの入力であり、列の runtime 到達性まで保証しない。全性質について探索・証明が完了したという表ではない。

| #855 の性質 | Lean で再検査する箇所 | 具体側で検査する対象と範囲・元命題との関係 |
| --- | --- | --- |
| `ObservationConsistent` | `ObservedLoss.observation_consistent_fails`; `ObservedHistory.frozen_blocks_other_report` | commit 後停止を含む固定射影では不成立を証明。frozen の不一致はその射影候補に限る。全遷移の観測対応、TS runtime 到達性は未検査。 |
| `RecoveryPossible` | `StoppedRecovery.no_concrete_eligible_recovery`; `StoppedRecovery.projected_recovery_exists`; `StoppedRecovery.actions_preserve_stopped_operator`; `HistoryRecovery.no_fixed_transition_exact_correspondence` | confirmation 待ち停止 runner は限定回復操作の任意有限列でも具体的に eligible へ戻れない一方、同じ候補観測の live 履歴には回復経路がある。固定 Transition ではこの候補観測上の両履歴を具体回復可能性に同時に対応できない。#855 命題の違反ではなく、全履歴接続・対象外操作は未検査。 |
| `ReconnectRestoresAvailability` | `Composition.operator_reconnect_success_available`; `Composition.conductor_reconnect_success_available`; `Composition.reconnectResultsRestore` | 対応する lease を持つ成功結果に限る局所定理と、初期状態・固定8操作・長さ4以下の 4681 列。無効な成功入力は no-op。全 abstract transition との対応は未証明。 |
| `ResumeWatchPreservesReportHold` | `ObservedHistory.resumeModel_preserves_reportHold`; `Composition.resumeWatch_preserves_reportHold` | resume-watch の対象遷移での局所定理。全体遷移と観測の完全性は未証明。 |
| `ReleaseIndependent` | `ObservedHistory.releaseFieldsPreserved`; `ObservedHistory.conductorReleaseFieldsPreserved`; `ObservedHistory.dispatchHeld_operator_held_false`; `ObservedHistory.frozen_blocks_other_report`; reconnect hold/retry guards | 初期状態から固定7操作 alphabet の長さ4以下2801 prefix それぞれに、operator の resume-watch / recovery-continue / reconnect / report-hold-off の4操作を適用し、retry・tracked item・frozen・保護 field を検査（11,204 比較）。dispatch-hold-off は held worker 31 を含む一具体状態で、hold false 後も具体 held に残り、次の選択で held から send が始まることを検査。解除時には lifecycle 等の比較 field を保持する。候補観測は operator の物理 held を隠す（`dispatchHeld_operator_held_false`）。全状態・全遷移の接続は未証明。 |
| `NoEventLoss` | `ObservedLoss.no_event_loss_fails`; `ObservedHistory.retrySessionAfterOtherDispatch`; `ObservedHistory.retrySessionAfterRefreshAt900` | commit 後停止の固定射影で不成立を証明。retry report は別 session の dispatch 中と refresh 比較列で固定保持を確認するが、一般保持証明ではない。停止列の TS runtime 到達性・全保管先は未確認。 |
| `AcceptedEventRetained` | `ObservedLoss.accepted_event_retained_fails`; 上記 retry 履歴の item-state guards | 受理から commit 後停止までの固定射影では不成立。retry の保持は個別具体列に限る。全項目・全遷移と TS 到達性は未検査。 |
| `NoAutomaticInputReplay` | `ObservedHistory.noRepeatedInputDispatchFor`; `inputReplayTraces 4` | 初期具体履歴は input 7 / 8（1 byte）の受理、commit 選択、send 開始、未完了結果で作る。結果値は `other` × `{auth, transport, providerError, cancelled, sendRejected(false availability)}` と `(running, incompleteStatus)` の6 profile。各 profile / ID について、新規 input `id+1`（異なる抽象 ID）・retry 保存・recovery continue・選択・send 開始の5操作を長さ4以下全列挙（781列、計9,372組合せ）。TS queue の `enqueueUser` は新しい arrival を割り当てるが、Lean 数値 ID と TS arrival の同一性は主張しない。同じ abstract ID の dispatch 記録は一度だけ。全 result / 例外 / runtime event 順序は未検査。 |
| `ScheduledDispatches` | `ObservedLoss.selectedWithoutDispatch`; `ObservedHistory` の選択後停止 guard; `FairExecution.scheduled_dispatches` | operator input の受理・選択の2操作後に選択印はあるが send 開始印はない。固定4操作 alphabet の長さ1以下5列ではこの状態がなく、提示列はその範囲で最短。抽象 schedule を具体選択へ対応させるなら同一遷移 dispatch の条件は不成立だが、対応そのものは未確定。 |
| `HoldExemptDelivered` | `FairExecution.hold_exempt_delivered`; `FairExecution.delayed_while_eligible`; `FairExecution.unlinked_scheduler_fair`; `FairExecution.fair_selection_without_progress_not_delivered` | 限定遷移系では `ScheduledDispatches` からの条件付き定理を証明。実行 witness は公平性の前提が空虚、unlinked 対照は前提が非空虚でも TS / `Composition.step` の経路でない。TS 具体公平性と選択後進行は未判定。 |
| `ReconnectResumes` | `ReconnectExploration.blockedAfterSuccessfulReconnectAt`; `ReconnectExploration.resumesAfterSuccessfulReconnectAt`; `ReconnectExploration.targetWorkerStarted`; `ReconnectExploration.heldAfterSuccessfulReconnect` | 上限 1 は reconnect 成功後も停止し、上限なし・上限 2 は同じ列で送信開始。上限待ち開始状態から固定4操作の例が長さ3以下85列で最短。operator 入力による回復は固定4記号・長さ3以下85列で最短。hold 待ちも別固定列で確認した。いずれも停止要因が残る間は `EligibleUntilDispatch` を満たさず、弱公平性付き元命題の反例ではない。公平な無限実行と選択後進行は未判定。 |

### 未判定項目の優先順位と次の作業

| 優先 | 性質・対象 | 障害 | 次の一手 |
| --- | --- | --- | --- |
| 1 | `ObservationConsistent` | refresh 前後で abstract retry / time / tracked item が同じでも per-report deadline・session ごとの selector が異なる。commit 後停止の固定射影も観測なしの項目消失を示すが、その TS 到達性は未確定。 | concrete event ごとの状態・観測対応を定義し、retry refresh と停止列で対応の両端を検査する。抽象状態の一致から別の concrete state を接続しない。 |
| 2 | `NoEventLoss` / `AcceptedEventRetained` | 固定射影では不成立を証明したが、commit 後の停止通知順と queue・local batch・表示履歴・reservation・inbox 等の全保管先を実行時の順序で確定していない。 | TS の commit → await continuation → stop notification を関数単位で照合し、受理項目の全保存先を一覧化する。実到達性を示せない列は候補のまま保つ。 |
| 3 | `ScheduledDispatches` / `HoldExemptDelivered` / `ReconnectResumes` | selection・commit・send は別 event。現状の fair witness は継続 eligible を満たさず、非空虚な scheduler fair 対照は TS に接続していない。 | conductor driver loop の具体 trigger / selection / send を含む無限実行を作り、継続 eligibility・弱公平性の両方を満たす witness と、選択後 send の進行条件を別々に検証する。有限探索では代替できない。 |
| 4 | `RecoveryPossible` | abstract の有限存在経路と、stopped runner を含む concrete の回復操作列が同じ履歴に対応する relation はない。 | #855 の許可操作・外部結果を一つずつ concrete event に対応付け、同じ開始状態からの経路を構成する。持ち上げ不能な abstract path は元命題違反と呼ばない。 |
| 5 | `NoAutomaticInputReplay` / `ReleaseIndependent` の一般化 | 今回の bounded check は有限値・浅い prefix に限る。operator の held は候補観測が隠し、conductor は一具体解除状態のみ。 | finite domain 外で使う不変条件を証明できるか調べ、できない箇所は追加の値域・初期状態を明示した bounded search にする。全 transition との同値性を前提にしない。 |

今回追加した有限探索の具体的な値域と深さは次の通り。列数は固定 alphabet 上の組合せ数で、TS runner の到達可能性を表さない。

| 検査 | 具体開始状態と操作値 | 列数・深さ | 判定と限界 |
| --- | --- | --- | --- |
| `NoAutomaticInputReplay` | input ID `{7, 8}`、byte 数 `1`、`Scheduling={maxWait=0, idleAging=10, maxUserBytes=100}`、時刻 `0`、commit token `10`、選択・send 開始後の未完了結果を初期履歴として構成。結果 profile は `other × {auth, transport, providerError, cancelled, sendRejected(agentAvailable=false)}` と `(running, incompleteStatus)` の計6値。suffix alphabet は新規 input の抽象 ID `id+1` / retry 保存成功 / recovery continue / 選択 token `11` / send 開始。 | 各 profile・ID ごとに5記号から長さ4以下 `781` 列、全 `9,372` ケース。 | 同じ concrete history の dispatch mark で元 ID の再 dispatch は増えない。failure class の組は Lean 入力域で、全組合せの TS runtime 到達性は未確認。TS の queue `arrival` と Lean の ID の同一性は置かない。 |
| `ReleaseIndependent` operator | 初期状態から input `{id=1, bytes=1}`、report `{id=2, session="s", reportId="r"}`、時刻・delay・maxWait `0`、operator report hold on/off、resume-watch、input-end、stop-request の7記号。各 prefix を一つの concrete `System` へ逐次適用。 | 長さ4以下 `2,801` prefix × 4 operator 操作（resume-watch / recovery-continue / reconnect / report-hold-off）= `11,204` 比較。 | retry・tracked item・frozen と操作ごとの保護 field は候補観測で不変。物理 operator-held は候補観測から除外。 |
| `ReleaseIndependent` conductor | worker `{id=31, kind=workerCompleted}` 受理、dispatch hold on、選択試行で held に置いた concrete state から dispatch-hold off。 | 受理・hold・選択試行の3操作、解除後の次の選択を検査。 | TS 同様、hold false は held buffer を空にせず、次の選択が held から send を開始する。解除時は lifecycle / batch state / operator state を保持する。一つの concrete stateであり conductor の全項目・全遷移ではない。 |

#### reconnect 成功後に worker が再開しない条件

`ReconnectExploration` では、停止要因を混ぜずに二つのケースを別履歴で検査した。

- **自律ターン上限**: 最初の worker send 完了で `autonomousTurns=1` に達した後、worker 2 の到着・reconnect 到着・reconnect 開始・成功を行う。availability は戻るが、`maxTurns=1` では次の worker send を開始できず、turn 数も reconnect でリセットされない。同じ列の `maxTurns=0`（無制限）と `maxTurns=2` では worker send が始まる。これは TS `canDispatchConductorSend` / `autonomousTurnsAfterConductorBatch` の規則に対応する。
- **dispatch hold**: hold を有効にして worker と reconnect を待たせる。選択処理は worker を held に移して reconnect を開始し、reconnect 成功後も hold は残る。worker は hold 解除後に send される。これは `bufferDispatchHoldEvents` と `waitForDispatchBatch` に対応する。

上限ケースは到達済み状態から4操作の例があり、同じ状態・4操作の固定 alphabet で長さ3以下の85列を探索して最短性を確認した。上限から戻る列は operator message 到着・その send 開始・成功結果・worker send 開始の4操作であり、固定4記号・長さ3以下の85列では worker send は始まらない。held ケースの回復は固定の hold 解除・send 開始の2操作である。これらはモデル内のイベント列最小性であり、全 TS 入力値・全操作・runtime スケジュールに対する最小性ではない。

いずれの no-resume 列も、対象 worker が dispatch まで eligible であり続けるという `ReconnectResumes` の前提を満たさない。上限到達時は `canDispatchConductorSend` が偽、hold 中は dispatch hold が有効である。従って reconnect 成功後に待機する具体列を、弱公平性違反として数えない。operator input が来ないまま上限や hold が残る無限待機について、TS runner 全体で実行可能か・#855 の射影前提を満たすかは未検査である。

停止 no-path 例の主経路は `runTtyConversation` の user input 受付・send failure 後の confirmation・dispatch 不可時の `stopping` wait である。user-only batch は `recordRetry` が report 不在時に即時 return するので、retry 保存待ちに EOF が割り込む仮定は置かない。既存 `run-operator-agent-recovery.test.ts` の `keeps only authored input after a failed first Cursor send and waits for confirmation` は failure・後続 input・confirmation gate を通す。SIGINT をその gate で受けた同一 test はなく、`requestStop` → `stopping` による return は静的な関数経路で結んだ。初期状態から停止までの全値域での最小性は未検査。

追加の `reportRetryWaitingStart` は、実際に非同期 lock wait がある別経路である。既存 `run-operator-agent-watch.test.ts` の `stops after retry lock acquisition races with eof` を個別実行し、retry lock 待機中の EOF と runner 終了を確認した（1 test passed）。既存 test は後続 user input を queue に追加しない。Lean では lock 待機中の入力・EOF・retry 停止の3操作を、固定 alphabet の長さ2以下13 prefix と比べ、その範囲で最短とした。これは停止例の主経路とは別の限定 witness である。

resume-watch の具体列は `ObservedHistory.resumeHeldExample` とその直後の操作である。TS の `operator-dispatch.ts` の `setConversationHold` / `updateHold` が会話 hold の解除時に held report を pending に移す。既存テスト `keeps reports held when conversation hold starts during manual hold` も、手動 hold を解除した後、最後の会話 hold を解除すると report が戻ることを検査する。これは固定列・暫定観測上の差であり、対象列の一般的な最小性は未検査。

#855 の [レビュー対応](https://github.com/otolab/agents-ensemble/pull/866#issuecomment-7121265224) では抽象 `held` の変化を dispatch hold 解除時だけに許す意図が記録されている。TS の operator は会話 hold と手動 report hold の論理和で report の物理的な移動を決めるため、物理 queue を抽象 `held` に直接対応させると両者が混ざる。別の候補 `observeDispatchHeld` は operator の `held` を使わず、会話 hold・手動 report hold は実状態から観測し、report の物理的な所在は具体履歴に残す。この候補では operator の resume-watch 前後で抽象 `held` と手動 hold が変わらないことを証明した。項目ごとの保留と eligibility、frozen、全主体・全操作を通じた観測忠実性は別途必要であり、`ReleaseIndependent` 全体を証明したものではない。

初期状態・固定7操作・長さ4以下の2801列では、operator の物理 held queue が非空なら会話 hold または手動 hold が有効であることを確認した。これにより、この範囲では report を止める条件を抽象の二つの hold に分けられるが、全到達状態や frozen / retry を含む eligibility の一致は未証明。

conductor 側では、初期状態から worker 受理・hold 設定・選択試行・hold 解除・dispatch の固定5操作を検査した。選択試行で worker が held に移り、解除後も選択まで held に残り、選択時に取り出されて dispatch 観測を生じる。主体別履歴の `conductorDispatch` は従来、通常 queue からの除去しか見ず held からの dispatch を未対応としていたため、両方の所在からの取り出しを記録するよう修正した。複数項目や permission を含む全遷移の対応ではない。TS 対応は `dispatch-hold.ts` の `bufferDispatchHoldEvents`、`conductor-session-driver.ts` の `waitForDispatchBatch`、`select-dispatch-batch.ts` の選択。固定列の最小性は未検査。

`ObservedHistory.lean` は主体付きの具体履歴を保持し、operator の user・report の受理、batch の dispatch、完了、report 再投入・retry 停止、完了後 ack の試行・待機・終了、reconnect 要求・開始・結果、resume-watch・recovery continue・report hold、conductor の worker 完了・permission stall の受理、追跡済み batch の dispatch・完了と dispatch hold を記録する部分実装である。再投入では report ID を用い、queue の物理 ID と論理 ID を分ける。両主体で同じ数字の ID を使用する例と、初期状態からの reconnect 成功列、主体別の hold 操作列を検査する。完了後に ack が失敗してから待機し、再試行に成功する限定列では send を繰り返さず、観測に ack の期限と operator の時刻を保持する。ack 操作が具体 dispatch 記録を追加しないことも証明した。

入力終了後の loop return は、具体側で停止に移る場合に内部遷移の tick として履歴へ記録する。未処理 user が残る場合には、この限定モデルの return は成立しない。これは `runTtyConversation` の loop 冒頭の終了判定に対応するが、戻った runner が抽象状態で識別できることや、全経路の観測整合性を示すものではない。`internal` に未対応イベントを与えた場合は具体 `step` を適用したうえで `supported := false` とし、観測の欠落を明示する。`supported` が true の全履歴について忠実性を証明したわけではない。

operator の commit・ack の時刻は履歴に保持し、後退する指定を未対応として扱う。これはモデル側の限定であり、TS の `Date.now()` が単調であるとの証明ではない。conductor の時刻や各入力・外部結果の時刻、待機の全順序を接続したわけではない。未対応遷移・空の report ID・conductor の未対応 batch、全履歴の状態射影と観測整合性・公平性は未検査であり、この部分実装によって全性質が成立すると主張しない。

user input の commit 後、send 開始前に停止する初期状態からのモデル列では、入力はモデルの queue と準備中 batch の双方に存在せず、send は始まらない。履歴は dispatch 対象からの不在を保持し、明示的な破棄観測を追加しない。この固定列だけの射影について、`NoEventLoss`、`AcceptedEventRetained`、`ObservationConsistent` の不成立を Lean で証明した。固定した4操作・固定値の長さ3以下の85列には同現象がなく、提示した4操作がその範囲で最短である。

TS では user batch の queue commit の後、待機結果が停止なら runner は return する。reservation の解放は queue への入力復元ではなく、この経路に明示破棄操作もない。合成モデルの当該遷移には runner 停止を反映した。ただし TS 実行時にこの停止が commit 後の await 間で実際に起こるかは未検証である。限定射影の結果を全遷移の観測接続や TS 実行時の反例と同一視しない。

受付時の文字列は queue だけでなく、TUI の表示用 dialogue entries にも追加される。commit 待機中はローカル変数の batch と `operatorInputTexts` にも存在する。recovery inbox の reservation は容量と token を保持するが入力本文は保持せず、停止時に release される。送信前の停止分岐は recovery snapshot の commit や agent send に到達しない。表示用履歴が自動 dispatch に使われることは上記経路では確認できないが、全保管先の不在や内容の完全消失は証明していない。

停止通知は stdin の終了、SIGINT / SIGTERM、TUI の interrupt 等から生じる。queue commit の `notify` は登録済み listener を同期呼び出しする。調査した標準の hold 表示・idle gate と待機解除の listener には停止要求を起こす経路を確認できなかったが、公開 subscribe のすべての利用可能な callback や外部イベント順序を網羅した証明ではない。同期 commit と waiter 継続の間に実際の停止通知が入る根拠は確定しておらず、この列は **モデル反例候補**として扱う。

独立確認で、当初の固定例は「非空入力」としつつ byte 数が既定値 0 だったため、1 byte に修正して証明と限定探索を再実行した。また、限定射影では選択と停止要求をそれぞれ tick に対応させるが、現状の `History.entries` はその tick を保存しない。この証明は固定列の射影についてのものであり、記録済み entries の全遷移接続や観測整合性を証明しない。TS の user commit は同期的に queue を更新してから解決済み Promise を返すため、外部停止イベントが await 後の継続より先に割り込めるかは別途の実行時確認が必要である。

確認待ちの停止例では、初期状態から user failure・保留 input・停止要求による runner return に到達する。停止後の `StoppedRecovery.Action`（recovery continue、resume-watch、report / dispatch hold 解除、reconnect と結果、send / retry 結果、待機）の任意有限列に対し、同じ concrete 履歴上で eligible に戻らない。stop flag は availability に混ぜていない。live 側の同一候補観測では recovery continue 後に eligible となるため、候補 projection は具体履歴を識別できない。`HistoryRecovery.no_fixed_transition_exact_correspondence` はこの限定的な識別不能を示す。一方、`#855 RecoveryPossible` は別途指定する abstract initial / transition の到達状態に対する存在命題である。現在は TS の全履歴をその transition に接続していないため、この concrete no-path や projected witness を元命題の成立／不成立とは分類しない。

operator の具体履歴は batch の選択と send 開始を別々に保持する。選択後の停止要求により send が始まらない限定列も検査した。暫定的な抽象 `schedule` は send 開始時に記録するため、これを具体 scheduler の選択と同一視して弱公平性を移すことはできない。具体選択を抽象 `schedule` に対応させると、その限定列では `ScheduledDispatches` の同一遷移での dispatch という十分条件が成立しない。ただし、この十分条件が成立しなくても進行性の命題自体が成立する可能性は残る。

`ConcreteTrace.concrete_fair_eventually_dispatched` は、具体実行において対象が dispatch まで可能であり続け、具体選択が弱公平で、可能な状態での選択が後の dispatch に至るなら、最終的に dispatch されることを直接証明する。最後の進行条件は公平性とは独立の仮定であり、合成モデルで成立することは未証明である。上記の停止例は選択から send への無条件の進行を否定するが、dispatch まで可能であり続けるという命題の前提まで満たす反例ではない。`ReconnectExploration` の上限待機を繰り返す到達済み無限実行は、限定観測では連続 eligible にもかかわらず対象選択がなく、#855 の弱公平性を満たさない。全体モデルの具体公平性と抽象公平性との対応は未構成である。

`Counterexamples.lean` に限定範囲の反例を記載する。停止例の最小性は未検査。reconnect 例の最小性は、固定した開始状態と4種類の固定操作についてのみ長さ3以下を全探索した結果である。いずれも #855 の元命題自体の反例とは主張しない。

## 全体判定までの未解決点

- operator の send 中断と retry 保存例外を履歴に追加した。send 中断の固定列では結果を捏造せず、lease を保持した停止を観測する。ただし commit 例外、停止した ack、空 report ID、入力・report の全到着条件と各観測の一対一対応は未検査。
- conductor の履歴は worker 完了・permission stall の受理、追跡済み batch の成功経路と hold に限る。その他の項目・batch、reconnect、失敗・例外、operator からの到着を同じ主体別履歴に接続する必要がある。
- 遅延 send 結果、保留中の他イベント、時刻と retry 期限について、各具体遷移の両端と記録したイベントの整合性を証明する必要がある。`supported` は全遷移の忠実性を保証する不変条件として証明されていない。
- session 別 retry を含む観測には、永続 `retryReadyAt`・queue の deadline index・event deadline・session ごとの selector 候補を同時に保持する必要がある。今回の比較列は abstract `retry` / 時刻 / tracked item 値だけでは selector を再現できないことを示すが、全 `State` の不一致や元命題違反は示していない。
- 無限実行では具体 scheduler の選択と dispatch を区別し、具体側の弱公平性、選択後の進行、抽象命題の `Eligible` を結ぶ必要がある。有限探索はこの証明にならない。
- 停止済み具体 runner と #855 の状態・遷移の対応は未構成。今回示したのは一つの候補観測が停止と live を区別できず、二履歴の concrete 回復可能性を同じ fixed Transition で正確に表せないことまでである。別観測、履歴添字付き具体関係、再起動を含む recovery の不可能性は示しておらず、#855 の `RecoveryPossible` 全体の真偽も未判定。

これらは単一の不足定理を補えば解ける段階には至っていない。特に全遷移と無限実行の具体的な接続・証明方法が未確定のまま、同じ全体未判定が続いている。現状の部分結果を完成と扱うことはできず、作業範囲や #855 を独断で変更せずに完了できる見通しは立っていない。

## [#859](https://github.com/otolab/agents-ensemble/issues/859) の受け入れ条件

| 条件 | 現状 |
| --- | --- |
| As-Is 合成モデルを作成し、#855 との対応を示す | **部分達成**。conductor / operator と主体別履歴は合成。TS 対応表・受容済みモデル経路・外部 event を記載したが、全履歴の観測接続と全遷移の refinement は未達。 |
| #855 の全性質を合成モデル上で検査 | **未達**。11 性質を個別分類した。局所定理・固定値有限探索・候補射影での不一致はあるが、全体遷移での判定がない性質、公平な infinite execution を直接判定できていない性質を残す。 |
| 破れる性質ごとの最小反例を `Counterexamples.lean` に記録し build で検査 | **部分達成**。候補射影 / 固定 alphabet 上の検査例と no-path theorem は build 済み。TS 到達性を根拠付きで主張できる全体反例、各性質に対応した全域最小反例は確定していない。min search は各固定 alphabet / 初期状態 / 値域に限る。 |
| 反例ごとの日本語説明（利用者影響・event 意味・TS path / function・性質） | **部分達成**。commit 後停止候補、confirmation 待ち停止、reconnect 上限・hold の列を分けて説明した。確認待ち停止は関連既存 test と静的 driver 経路を分けて記載し、複合 runtime test は未実施。候補射影を実障害と断定しない。 |
| reconnect 後に再開しない系を再現、または探索範囲と限界を記録 | **範囲付きで達成**。上限・hold の no-resume と解除後 resume を個別具体列・範囲内の有限最小性とともに記録。いずれも継続 eligible な公平反例ではなく、全 TS / 弱公平性の判定は未達。 |
| 探索範囲外と抽象化の限界を一覧化 | **部分達成**。ADR §7 の driver / lock / process race、非同期終了、refresh・session retry、外部結果の実行可能性、全保存先、候補観測・公平性の限界を記載。未対応の全列挙ではない。 |
| Phase 1 判断材料を #848 に記録 | **部分達成**。限定結果・反例確度・未達を報告済み。11 性質の完了判定はなく、Phase 1 の最終判断材料とは言えない。 |
| `sorry` と標準外公理がない | **今回の状態で Lean build 成功**。対象 Lean source の `sorry` / 宣言的 `axiom` 検索は空。PR 前には成果物全体を再監査する。 |

## [#848](https://github.com/otolab/agents-ensemble/issues/848) Phase 1 の途中判断材料

以下は判断材料の追加であり、Phase 1 の着手・変更範囲・最終判断を決めるものではない。

- 停止、通信可能、確認待ち、処理中は別々に保持する必要がある。availability が true でも同一 runner が停止していれば再開可能とは限らない。
- reconnect 成功は availability の回復を意味し、dispatch 再開までを保証しない。`ReconnectExploration` では自律ターン上限と dispatch hold を別の停止要因として検査し、operator input / hold 解除後に再開する固定列も確認した。いずれの待機例も対象が eligible ではなく、弱公平な無限実行の反例とは扱えない。
- `FairExecution.lean` の無限 witness は `SchedulerFair` の前提が常時偽となるため、公平性が継続 eligible な対象を選ぶ実例ではない。TS の進行性判断には、継続 eligible を保ったまま選択に至る実行と、選択後に dispatch へ進む条件の接続が残る。
- 同ファイルの `unlinkedSchedulerModel` は、対象を全状態で eligible に保ち、毎回 schedule しても dispatch しない対照例である。`SchedulerFair` はこの例で非空虚に成立するが、`HoldExemptDelivered` は成立しない。これは選択後進行を表す `ScheduledDispatches` が欠けると公平性だけでは配信を導けないことを示す抽象モデルで、TS の到達経路とは主張しない。
- refresh 後の retry A について、queue / watch-pool 層では保存期限 5100・queue deadline 5900 の入力で 5200 に A が選ばれた。Lean では同じ deadline 値を持つ対照列を作り、refresh 前は B、refresh 後は A を選ぶこと、比較した abstract retry / 時刻 / item 状態だけではその差を表せないことを確認した。期限の意味と runner 全体での到達性は未確定で、retry 不具合や #855 の反例とは扱わない。
- commit と send の間の停止時に入力をどこで保持し、運用者が確認・再投入できるかを検討する価値がある。ただし候補列の TS 実行時到達性は未確定で、現時点では障害の発生を断定できない。
- 完了済み send の ack だけを再試行することは、限定モデルの具体列で検査できる。実運用の再起動・永続化・副作用の重複まではこの結果から判断できない。
- 全性質の判定と公平性・観測の接続が未達であるため、Phase 1 の最終判断や変更範囲を確定する材料としては不足する。

### retry 期限と session ごとの選択

`ObservedHistory.retrySessionHistory` は空履歴から report 7（session a）を受理・選択・commit・送信し、未完了結果を保存して frozen report として再投入した後、別 session b の report 22 を受理する固定列である。この Lean fixture は queue deadline を 5000 と置き、時刻 0 / 4999 では 22、5000 では a の frozen report を選ぶ。これはモデル内で保存時と queue 再投入時の時計を同じ値に揃えた境界検査であり、TS の二つの時計が一致することや、保存所要時間を反映する結果ではない。

TS では `run-operator-conversation.ts` が retry deadline を `Date.now() + 5_000` で作って `recordRetry` を await し、その後 queue の `requeue` が独立に `clock.now() + 5_000` を計算する。従って保存の前後で時計を読む時点が違い、Lean の 5000 境界は TS の二つの値の差を確定しない。`retrySessionHistoryWithClockSkew` は保存時 100・再投入時計 900 の二 session 固定履歴で、永続側 5100・queue 側 5900 を保持し、5899 では b、5900 では a を選ぶ。これは別入力の影響を確認する Lean 感度検査であり、TS の実時間差や reconnect 結合 trace を実証しない。`OperatorDispatch.lean` にも保存値 5100・再投入 deadline 5900 の別 fixture がある。

TS の `operator-dispatch.ts` の `selectBatch` と session ごとの候補判定、`run-operator-conversation.ts` の retry 保存後の失敗 report 再投入に対応する。既存 `operator-dispatch.test.ts` の「waits from threshold crossing and keeps a frozen retry ahead of new reports」「keeps a later requested report eligible after the earlier frozen retry is acknowledged」「requeues an unconfirmed report with its stable report id」と同時 session の分離テストは個別に実行し成功した。`run-operator-agent-recovery.test.ts` の retry / reconnect 結合テストも実行して成功した。`run-operator-agent-watch.test.ts` には retry 保存と再起動後の report 再配送、`operator-watch-pool-persistence.test.ts` には複数 poll の永続化を扱う既存テストがあるが、いずれも今回の「session a の期限待ち retry と session b の到着・dispatch」を同じ runner 実行で検査するものではない。

2026-11-26 に `pnpm --filter @agents-ensemble/operator-agent... build` の後、`operator-dispatch.test.ts`、`run-operator-agent-recovery.test.ts`、`run-operator-agent-watch.test.ts`、`operator-watch-pool-persistence.test.ts` を `vitest run --maxWorkers=1` で実行し、4 suite・127 tests が通った。最初の sandbox 内実行は Unix domain socket の `EPERM` で setup 前に止まり、sandbox 外の並列実行は未生成の `dist` と一時 directory の競合で失敗したため、標準 build 後に単一 worker で再実行した。ここで通ったテストも個別経路の確認であり、保存前後の時計差・refresh・二 session の通知・runner wait/wake・agent send を一つに束ねる runtime trace は未検証である。一時 queue API probe は指定した時刻で queue / watch-pool 層の選択を確認した。Lean 例も外部結果とイベント順序を指定した一列で、一般的最小性は示さない。

reviewer の指摘を受け、watch pool の保存・再照合と dispatch queue を使う一時 runtime probe も実行した。retry 保存値を 5100、保存 await 後の `requeue` 時計を 900 とすると、queue の map は 5900 になる。その後 `refreshPendingReports` で永続 state を再照合し、5200 に session b を `pollOnce` すると、queue の実 `selectBatch` は session a の retry report を返した。コード上、`reconcileReports` は `readyAt` に map の 5900 を反映する一方、`Object.assign(queued, persisted.event, { readyAt })` が event の `retryReadyAt` を永続値 5100 に戻す。frozen batch の selector は event の `retryReadyAt` を期限判定に使い、`nextReadyAt` は map の値も見るため、通知があれば 5900 より前の選択が可能になる。probe は `recordRetry`・queue 再投入・`refreshPendingReports`・二つの session の poll と queue 選択までを実行したが、2 秒 timer、`run-operator-conversation` の `dispatchLifecycle` gate、agent send / reconnect までは通していない。これは制御された時刻入力で再現した実装上の queue 挙動であり、5 秒期限のどちらを正本とするかが未決のため、仕様違反や不具合とは断定しない。恒久 TS テストや TS 修正は追加していない。

`OperatorDispatch.lean` に `Queue.reconcileQueuedReport` と固定 `#guard` を追加し、queue の `retryById` に 5900 を残したまま refresh が event の期限を 5100 に戻し、B の到着後に 5200 で A を選ぶ範囲を検査した。さらに `Composition.Event.operatorRefreshReport` と `Composition.step` に refresh を加え、`ObservedHistory.retrySessionAfterRefreshAt900` / `retrySessionAfterRefreshWithClockSkew` で、失敗・保存・再投入・reconnect 成功・refresh・B の受理・A の選択と dispatch を同じ具体履歴に接続した。履歴は保存 retry 値 5100、queue deadline index 5900、refresh 後の event `retryReadyAt` 5100、5200 での A dispatch を保持する。履歴側と `Composition.step` の選択記録にも `Lifecycle.canDispatch` gate を課した。対照の `retrySessionWhileUnavailable` では、gate が閉じた状態で B が到着しても A / B とも pending に残り、新たな選択記録や send は生じない。この report-only 失敗では confirmation gate が立たず、reconnect 後は dispatch 可能であることも guard で確認した。これは外部時刻と refresh・到着順を与えた Lean の有限列であり、TS runner の timer/poll/lifecycle gate/send 経路の到達性を証明しない。

refresh を含まない従来の `retrySessionHistoryWithClockSkew` は、保存期限 5100・queue deadline 5900 を保ったまま B を 5899、A を 5900 に選ぶ。今回追加した 5200 の対照列では、refresh 前の queue event は `retryReadyAt=5900`・`readyAt=0`、queue deadline index は 5900 であり、selector は B を選ぶ。これに対し、refresh 後は同じ report A の event が `retryReadyAt=5100`・`readyAt=5900` となり、selector は A を選ぶ。Lean の guard は両列で abstract `retry` / `now` / 追跡 item 7・22 の値が等しいことも確認する。これは比較したフィールドに per-report deadline と session key がなく、そこから concrete selector の結果を再現できないことを示す。`State` 全体の等価性や遷移同値性、`ObservationConsistent` の反例を証明したわけではない。時刻 900 の refresh 後には `retry=none`・A pending・lifecycle ready を観測する一方、具体 queue は event deadline 5100 まで A を選ばない。これは単一 `retry` と per-report deadline の観測差として扱い、`Eligible` の全条件や公平性に直結する証明とは区別する。

unavailable 中に B が来る対照履歴では `Lifecycle.canDispatch` gate が閉じたままなので、選択・send は起きない。queue selector 層の差は指定時刻の入力で再現でき、reconnect 後に gate が開いているケースを Lean で検査した。一方、永続 retry deadline 5100 と queue 再投入期限 5900 のどちらを契約上の期限とするかは未決である。TS の実 timer・session poll・runner wait / wake・agent send/reconnect を一つの runtime trace には通していないため、選択後に TS runner が A を送ることや、実到達性は未確認である。従ってこの結果から仕様違反や `ReconnectResumes` の反例とは断定しない。

この差により、暫定観測の `Eligible` を具体 scheduler の選択可能性と同一視して弱公平性を移すことはできない。refresh を含まない `retrySessionHistoryWithClockSkew` では availability 回復後に期限前の session b が選ばれるが、refresh を含む履歴では event deadline が戻った A が 5200 に選ばれる。抽象 `Eligible` は retry deadline と session 差を同時に保てず、どちらの有限列からも `ReconnectResumes` の公平な無限実行は推論しない。

`ObservedHistory.frozen_blocks_other_report` は、#855 の `frozen` を両項目についてそのまま保つ場合、ある frozen report が存在すると別の非 frozen pending report は `Eligible` にならないことを一般に証明する。TS の `selectOperatorDispatchBatch` は session ごとに frozen batch の候補と期限を求めるため、別 session の選択可能性を同じ `frozen` と `Eligible` で同時に忠実に表すことはできない。これは物理 frozen の意味と項目別 eligibility の両方を保存する観測に限定した衝突で、#855 の命題全体の不成立や、異なる意味を明示した観測すべての不可能性ではない。期限についても状態の `retry` は一つだが TS の期限は report ごとに保持される。session を絞った限定観測は他 session の同時選択可能性を表さないため、全体の代用にできない。

TS の `run-operator-conversation.ts` は未完了結果について retry の保存が成功した後、各 report を 5 秒遅延で再投入する。`operator-dispatch.test.ts` は同一 session の frozen batch と後着 report の順序、期限前後の選択を検証する。別 session を含む固定列全体を直接検証する既存テストは確認できず、その実行時到達性は静的な対応に留まる。

`retrySessionAfterOtherDispatch` と `retrySessionAfterRetryDispatch` は、ready な session b の report を先に dispatch して ack を終えた後も、session a の frozen retry report が期限まで具体 queue と履歴に残り、期限後の dispatch で追跡を閉じる固定列を検査する。今回追加した `retrySessionHistoryWithAvailability`, `retrySessionAfterReconnect`, `retryReconnectAfterOtherDispatch`, `retryReconnectAfterRetryDispatch` は、send 未完了で unavailable になった同じ session a に operator reconnect を要求・開始・成功させ、その後 b を dispatch、期限後に a を dispatch する。reconnect 成功で availability は戻るが、a の per-report deadline と frozen batch は維持される。Lean では reconnect lease により後続 send attempt ID が進む点も具体履歴に残る。これらはこの固定列における `ReconnectRestoresAvailability` と項目保持・再開の検査であり、一般的な `NoEventLoss` / `RecoveryPossible` / `ReconnectResumes` の証明ではない。

reviewer の独立確認 [#859 comment 7183047774](https://github.com/otolab/agents-ensemble/issues/859#issuecomment-7183047774) を受け、`FairExecution.lean` の意味を限定し直した。実行例は対象 4 が初期状態と二つの hold tool 操作後も eligible で、index 2 で schedule / dispatch される。その後は item が pending でなくなるため、`not_continuously_eligible_from` がすべての suffix で常時 eligible の前提が成り立たないと証明する。従って実行例の `SchedulerFair` はその対象について antecedent が偽で成立しており、公平性が継続 eligible な対象を選ばせる例ではない。`HoldExemptDelivered` の限定定理は、この小モデルが schedule と dispatch を同じ遷移に置く `ScheduledDispatches` と公平性の条件から導く。TS の選択・commit・send 間の進行を検査する結果ではなく、この witness も公平性の非空虚な作動例を与えない。

この無限実行の tail は send 完了後の `set_dispatch_hold(true)` no-op 反復であり、各 hold 操作を外部環境から供給するモデルである。TS driver が次の tool call を自律生成するとは示していない。弱公平性の前提を満たす環境進行には、次の conductor turn を起こす trigger が無限にあり、各 turn で agent が tool call を発行し、その send と tool call が成功して戻り、shutdown しないことが必要になる。TS にこの無限供給を実現する driver 経路や、継続 eligible な item に公平性が作動する全体 trace は未確認である。`conductor-session-driver.test.ts` の `dispatches permission.stall during hold at max turns and releases pending ahead of held work` は有限 prefix の対応に限る。

`unlinkedSchedulerModel` は公平性そのものが空虚でない例だが、TS に対応する遷移としては構成していない。schedule が毎回起きても dispatch がないので `ScheduledDispatches` は満たさず、配信性も成立しない。この対照により `SchedulerFair` が選択を保証することと、選択後に具体 runner が send / dispatch へ進むことは別の条件だと確認できる。`FairExecution.model` の成功 trace は `ScheduledDispatches` を満たす一方、その個別 fair witness では fairness antecedent が偽である。二つのモデルのどちらも、TS の無限実行を証明しない。
