# 合成モデルの検査状況

この文書は作業途中の対応表であり、TS 全体の形式化や #855 の全命題の判定を示すものではない。TS を現状の基準とし、抽象仕様との違いは検査結果として扱う。

## TS の関数と Lean 定義の対応

パスはリポジトリルートから記す。Lean の名前は `Ensemble.AsIs.` を省略する。
`Composition.step` は主体別の既存モデルを合成する部分モデルで、TS の driver 全体との等価性は未証明である。
`ObservedHistory` の列は具体状態を保持する観測接続の試作であり、全遷移の写像ではない。

| TS ファイル | 関数・操作 | Lean 定義 | 接続範囲と未対応 |
| --- | --- | --- | --- |
| `packages/core/src/conductor/session/session-event-queue.ts` | `enqueue` | `Composition.step` の `conductorEnqueue`、`ObservedHistory.conductorAcceptWorker` | 履歴の受理観測は単一 worker 完了に限定。waiter への直接配送は未接続。 |
| `packages/core/src/conductor/session/select-dispatch-batch.ts` | `selectDispatchBatch` | `ConductorQueue.chooseDispatch`、`Composition.step` の `conductorBeginSend`、`ObservedHistory.conductorDispatch` | 履歴は単一 worker のみ。複数項目、permission stall、予約・時刻の全条件は未接続。 |
| `packages/core/src/conductor/session/dispatch-hold.ts` | `bufferDispatchHoldEvents` | `ConductorQueue.bufferHold`、`Composition.step` の `conductorHold`、`ObservedHistory.conductorDispatchHold` | held の操作を部分的に接続。permission の失効・通知と全項目の観測は未検査。 |
| `packages/core/src/dispatch/set-dispatch-hold-tool.ts` | `createSetDispatchHoldTool` 内の `execute` | `ConductorQueue.setHold`、`ObservedHistory.conductorDispatchHold` | hold 切替の結果のみ。ツール出力・通知は対象外。 |
| `packages/core/src/conductor/conductor-session-driver.ts` | `runConductorSessionDriver` 内の reconnect 選択・結果 | `Composition.step` の `conductorBeginReconnect` / `conductorReconnectResult` | 成功 settle の局所定理あり。conductor の主体別履歴への接続、非同期中断は未実装。 |
| `packages/core/src/conductor/conductor-session-driver.ts` | `runConductorSessionDriver` 内の send・結果処理 | `Composition.step` の `conductorBeginSend` / `conductorSendResult`、`ObservedHistory.conductorCompleted` | 観測履歴は単一 worker の成功のみ。失敗・例外と driver の全停止境界は未接続。 |
| `packages/core/src/conductor/conductor-dispatch-lifecycle.ts` | `settleConductorDispatch` | `ConductorDispatchLifecycle.settleConductorDispatch`、`Composition.step` の send 結果 | lease と結果を合成。inbox の実容量・期限・dispose は外部結果で過大近似。 |
| `packages/core/src/conductor/conductor-recovery-inbox.ts` | `ConductorRecoveryInbox.reserve` / `release` | `Composition.Reservation`、`Composition.step` の `operatorBeginCommit` / `operatorCommitStopped` | token と byte 数は保持。容量・期限・dispose は `reservationOk` で外部から与え、実行可能性は別途確認が必要。 |
| `packages/core/src/conductor/session-policy.ts` | `canDispatchConductorSend` / `autonomousTurnsAfterConductorBatch` | `ConductorQueue.canSend`、`Composition.step` の `conductorBeginSend` / `conductorSendResult` | 自律ターン数と上限を保持。全セッション制御の実行順は未接続。 |
| `packages/operator-agent/src/run/run-operator-conversation.ts` | `runTtyConversation` 内の `handleSubmittedInput` | `Composition.step` の `operatorInput`、`ObservedHistory.accept` | 通常入力の受理を記録。入力文字列の表示、全コマンドと外部 I/O は未接続。 |
| `packages/operator-agent/src/dispatch/operator-dispatch.ts` | `selectOperatorDispatchBatch`、`createOperatorDispatchQueue` の `selectBatch` | `OperatorDispatch.Queue.selectBatch`、`Composition.step` の `operatorBeginCommit`、`ObservedHistory.internal` | 選択と send 開始を分離。全 focus・時刻・入力条件との履歴対応は未証明。 |
| `packages/operator-agent/src/watch/operator-watch-dispatch.ts` | `createWatchDispatchOperations` の `commitBatch` | `Composition.step` の `operatorBeginCommit` / `operatorCommitApply` | user・凍結 batch と未凍結 report の commit 境界を区別。lock 競合・永続化例外の全順序は未接続。 |
| `packages/operator-agent/src/dispatch/operator-dispatch.ts` | `createOperatorDispatchQueue` の `commitBatch` / `rollbackBatchCommit` | `OperatorDispatch.Queue.commitBatch` / `afterCommitError`、`Composition.step` の `operatorCommitException` | queue 更新と rollback をモデル化。例外の実到達性と全保存先は未証明。 |
| `packages/operator-agent/src/run/run-operator-waiters.ts` | `createOperatorWaiters` の `retryWatchLock` | `Composition.step` の `operatorCommitStopped` / `operatorRetryStopped` / `operatorRetryException`、`ObservedHistory.retryStopped` / `retryException` | 停止・例外を区別。同期 user commit 後に停止通知が先行する候補の TS 実到達性は未確認。 |
| `packages/operator-agent/src/run/run-operator-conversation.ts` | `runTtyConversation` 内の send 開始・結果・中断 | `Composition.step` の `operatorCommitSuccess` / `operatorSendResult` / `operatorInterruptSend`、`ObservedHistory.dispatch` / `sendResult` / `interruptSend` | 正常・未完了・中断の限定列。race の全実行順序は未証明。 |
| `packages/operator-agent/src/dispatch/operator-dispatch.ts` | `createOperatorDispatchQueue` の `requeue` | `OperatorDispatch.Queue.requeueReport`、`Composition.step` の `operatorRetryResult`、`ObservedHistory.retrySaved` | 非空 report ID のみ論理 ID を保持。空 ID・重複や時刻の全組合せは未接続。 |
| `packages/operator-agent/src/watch/operator-watch-ack.ts` | `retryOperatorWatchAcknowledgement` | `OperatorDispatch.Runner.ackResult` / `advanceAck` / `finishAcknowledged`、`ObservedHistory.operatorAckStep` | ack 待機と再試行の限定列。実時間の単調性・全例外順序は未証明。 |
| `packages/operator-agent/src/run/run-operator-conversation.ts` | `runTtyConversation` 内の `handleInputEnd` / `requestStop`、`/reconnect` | `Composition.step` の `operatorInputEnd` / `operatorRequestStop` / reconnect 各操作、`ObservedHistory.operatorRequestReconnect` / `operatorBeginReconnect` / `operatorReconnectResult` | 入力終了と停止要求を分離。reconnect・idle 待機中の停止 signal や全 callback 順序は未接続。 |
| `packages/operator-agent/src/run/run-operator-conversation.ts` | `runTtyConversation` 内の `/resume-watch` | `Composition.step` の `operatorResumeWatch`、`ObservedHistory.operatorResumeWatch` | report hold 保持を局所的に証明。全解除操作の観測接続は未証明。 |

## 現行 TS の idle・停止・終了・通信・回復

調査対象のコードは開始時の commit `8657a347ae6a8e63295513dfacf3e98102e369f8`。Issue #881 本文・履歴を基準にし、#855 / #859 / #848 の Issue 記録、PR #879 の差分・説明・レビュー、ADR 0086、`Flow/Spec.lean` と As-Is モジュール、関連する TS 関数を照合した。調査中に `origin/main` が3 commit進んでいたため、PR #880 で入った TUI clock 表示変更も確認した。この変更は表示更新・cursor 維持の範囲で、ここで扱う session lifecycle / harness idle state の更新ではない。以下は関数と分岐の静的な読み取りであり、runtime trace、Lean build、非同期順序の実測は今回行っていない。根拠となるコードパスはリポジトリルートから記す。

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
| Issue-session TUI の conductor status 時計 | `IssueSessionTui` / `IssueSessionTuiStream` (`packages/cli/src/tui/issue-session-tui.tsx`, `packages/cli/src/tui/issue-session-tui-stream.tsx`) が `conductorStatus.since` からの経過秒を定期再描画する。 | 秒表示の更新は status 本体の更新や harness phase の遷移ではない。 |
| watch の idle candidate | `evaluateOperatorIdleCandidate` (`packages/operator-agent/src/dispatch/operator-idle-candidates.ts`) が live UDS 観測の `harnessPhase: idle` が閾値を超えた場合等に作る確認 report。`running` の古い statusLine も別 candidate になる。 | worker 停止・失敗・停滞、Issue 作業の未完了の証拠ではない。長い正常処理もあり得る。 |
| operator-agent の `inputEnded` | `runTtyConversation` (`packages/operator-agent/src/run/run-operator-conversation.ts`) の stdin `end` または `/exit` 後に、新しい入力を受け付けない状態。loop は pending user と reconnect がなくなると return 可能。 | send suppression、process teardown、`/exit` であること、pending report の処理完了と同義ではない。 |
| operator-agent の `requestStop` / `stopping` | `runTtyConversation` (`packages/operator-agent/src/run/run-operator-conversation.ts`) の SIGINT・SIGTERM・TUI interrupt 等による send 抑止。input を無効化し、`sendSuppression` を abort して競合待機を起こす。 | stdin の end や `/exit` と同じ意味ではない。send 結果を得ないまま return し、lifecycle lease が残る経路もある。 |
| Issue loop の停止 | `shouldStopIssueLoop` (`packages/core/src/conductor/session-policy.ts`) と `shouldBreakAfterLoopState` (`packages/core/src/conductor/conductor-session-driver.ts`) が Issue conductor の自律ループを抜けるか判定する。 | conductor session 全体や harness process の終了ではない。`continueAfterIssueLoopStop` や pending event により待機を続ける場合がある。 |
| session の close / exit / interrupted | `conductor-session.ts` (`packages/core/src/conductor/conductor-session.ts`) の要求・shutdown signal と teardown が作る session lifecycle。 | Issue loop の stop reason や operator-agent の会話 return 値だけからは決まらない。 |

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

### operator-agent 側の状態遷移と非同期境界

| TS 関数・操作 | trigger / guard | 状態更新・次の境界 | Lean との関係 |
| --- | --- | --- | --- |
| `handleSubmittedInput` (`packages/operator-agent/src/run/run-operator-conversation.ts`) | 空白でなく `inputEnded` 前。通常入力は recovery byte limit を queue 側でも検査。 | UI に表示し、user event を queue へ加え、conversation hold を設定する。`/exit` は `inputEnded` と `exitContinuity` を設定し、hold 解除や新規入力は受け付けない。`/reconnect` は pending count を増やす。`/resume-watch` は conversation hold のみ解除する。 | `operatorInput` / `operatorInputEnd` / reconnect / resume-watch。表示、command parsing、全 input guard は未接続。 |
| `selectBatch` (`packages/operator-agent/src/dispatch/operator-dispatch.ts`) | lifecycle が dispatch 可。selection clock で deadline を評価。 | user が report より優先。focus、Open Question、continuation、normal / aged idle / FIFO 等で report を選ぶ。戻り値は選択に過ぎず、queue commit も send もまだ行わない。 | `OperatorDispatch.Queue.selectBatch`。実 `Date.now`、focus timeout、全重み設定は限定抽象。 |
| reserve → `beginSend` → `commitBatch` (`packages/operator-agent/src/run/run-operator-conversation.ts`, `packages/operator-agent/src/watch/operator-watch-dispatch.ts`) | 選択 batch に対する recovery reservation を確保できる。 | lease を取ってから `retryWatchLock` 経由で commit を await。user / frozen report は同期 queue commit。通常 report は lock 取得後に再検証し、queue と manifest を更新する。commit 後、`agent.send` 呼び出しまでは同期区間として実装されている。 | `operatorBeginCommit` / `operatorCommitApply` / `operatorCommitSuccess` 等。lock・永続化・event-loop 順序は未接続。 |
| `retryWatchLock` (`packages/operator-agent/src/run/run-operator-waiters.ts`) が停止を返す | `sendSuppression` abort、または操作開始後の `inputEnded`（retry 保存時は終了前からの inputEnded も停止条件）。 | commit 待機後に停止と判定すると reservation を release し lease を completed として settle して return。queue commit 済みなら user item を queue に戻す処理はない。 | `operatorCommitStopped` / `operatorRetryStopped` に対応。同期 commit 直後の停止が実際に await 継続より先行するかは未確認。 |
| send race → `settleConductorDispatch` (`packages/operator-agent/src/run/run-operator-conversation.ts`) | commit 成功後に `sendConductorWithReconnect` と `stopping` を race。 | send 結果が先なら通常 settle。停止側が先なら result は未定義で return し、reservation を release するが、この経路では active lease を settle しない。send の外部完了順は未確認。 | `operatorSendResult` / `operatorInterruptSend`。実 Promise race 全順序は未証明。 |
| send 結果後の report ack / retry (`packages/operator-agent/src/watch/operator-watch-ack.ts`, `packages/operator-agent/src/run/run-operator-conversation.ts`) | send 完了時は report acknowledgement。未完了時は report retry 時刻保存と requeue。 | ack は最大 4 回試行し、成功 send 自体を再送しない。ack retry 枯渇では runner を止め、pending report を保持。再起動で同 report ID を再配送する場合がある。user input の失敗は queue に戻さず、条件に応じ recovery snapshot を保存する。 | `operatorAckResult` / `operatorAdvanceAck` / `operatorRetryResult`。永続化・再起動の replay は対象外。 |
| `handleInputEnd` / loop top (`packages/operator-agent/src/run/run-operator-conversation.ts`) | stdin `end`。または `/exit` が `inputEnded` にする。 | `inputEnding` を abort して queue を wake。loop は `inputEnded && pendingUserCount === 0 && pendingReconnects === 0` で return 可能。条件式に pending report 数は含まれない。 | `operatorFinishInput` はモデル上の return 条件を抽象化するが、全 control point の照合は未完了。 |
| `requestStop` / outer `finally` (`packages/operator-agent/src/run/run-operator-conversation.ts`, `packages/operator-agent/src/run-operator-agent.ts`) | SIGINT、SIGTERM、TUI interrupt、ack retry 枯渇など。 | `sendSuppression` を abort し、input を無効化する。`runTtyConversation` return 後は watch pool / agent を閉じる。`/exit` のみ `exitContinuity` を通じ operator-agent state を削除し、通常 return は次回選択用 state を残す。 | `operatorRequestStop` / `stopped` は簡略な抽象状態。保存 state、外部 resource teardown、再起動との連続性はモデル外。 |

### 二つの主体の通信は明示的な handoff を通る

| 向き | TS の経路 | 状態変化と境界 |
| --- | --- | --- |
| harness / operator → Issue conductor | UDS `operator.message.send` (`packages/core/src/session/open-question-control.ts`) → callback `sendOperatorMessage` (`packages/core/src/conductor/conductor-session.ts`) → `enqueueOperatorMessage` → `SessionEventQueue.enqueue`。 | UDS handler は callback を await し、text / delivery を検証する。この method は queue 受理専用で、Open Question を参照・更新しない。queue API は waiter への直接 resolve も持つが、現行 driver は queue change を待ち、batch を選択する。 |
| operator → Open Question 回答 | UDS `open_questions.answer` (`packages/core/src/session/open-question-control.ts`) → `answerOpenQuestion` (`packages/core/src/conductor/conductor-session.ts`)。 | YAML へ回答を durable write した後、`submitOperatorMessage` / `submitOperatorInput` で回答を適用し、`operator.message` を enqueue。dispatch receipt が完了するまで待つ別経路。 |
| operator-agent 内の利用者 → operator-agent model | `handleSubmittedInput` (`packages/operator-agent/src/run/run-operator-conversation.ts`) → operator dispatch queue → commit → `agentHandle.send`。 | これは operator-agent 自身の model turn。上記 UDS method を自動呼出しせず、Issue conductor event も自動生成しない。conductor への発話は別の明示 tool / UDS call が必要。 |
| Issue conductor / watched session → operator-agent | watch pool の UDS poll / live observation → report persistence / dispatch queue → operator-agent model。 | report 到着、保存、ack は複数 await と lock を通る外部通信。watch report の受理を conductor の send 成功や利用者への到達確認と同一視しない。 |

この分離は `Composition.lean` の冒頭コメントとも一致する。`operatorMessageDelivered` と watch report は外部入力として与え、operator model の send から conductor への自動 handoff は仮定していない。

### 事実・モデル上の仮定・未確認事項

| 区分 | 内容 |
| --- | --- |
| TS から確認できる事実 | lifecycle は lease / availability / attention を別々に保持する。reconnect settle は availability しか更新しない。operator-agent は選択、commit、send、settle、report ack を別の処理段階に分ける。入力表示、queue、recovery inbox、report manifest も別の保持先である。 |
| Lean に置いたモデル上の仮定 | reconnect 結果、send 結果、到着、tick、reservation 可否、retry lock の停止・例外等を環境 event として選ぶ。`RecoveryPossible` は回復 event だけからなる有限列の存在を要求する。これらの環境 event が TS でいつ・どの状態から可能かは、現在の全体モデルでは制約されていない。 |
| 未確認 | 同期 user commit の queue 更新後、解決済み Promise の await 継続より外部 stop callback が先行して `retryWatchLock` の停止分岐に入る実行があるか。停止通知が他の全 callback / poll / lock 競合に対しどの順序で起き得るか。保存と process teardown の race が再起動後に何を再配送するか。 |
| 有限探索からは言えない | 固定操作・固定値・有限深さで candidate が見つからないことは、無限実行での弱公平性や全 parameter の到達不能を示さない。有限実行だけのモデルで「いつか dispatch」の性質が空虚に真となる可能性もある。 |

### 回復可能性と「見かけ上の回復経路」

現行 TS に process 停止後も同じ runner を再起動する単一の `stopped` field はない。回復を論じるには、(1) runner / process が生きているか、(2) lifecycle lease が空か、(3) agent が available か、(4) attention が解除されたか、(5) pending item と hold / retry / frozen 条件が dispatch 可能か、(6) transport が実際に次の send を受けるかを分けて確認する必要がある。Lean の `State` にある `LifecycleReady` はこのうち lifecycle 条件、`Eligible` は item 条件を加えたモデル上の述語であり、TS 全体の生存性を表す述語ではない。

- conductor の `/reconnect` 成功は availability を true にし得るが、pending attention を消さず、turn 上限や hold も解除しない。したがって成功 callback だけを dispatch 再開の証拠にしない。
- operator-agent の `/reconnect` は同じ session 内の pending reconnect を処理する。send / commit の停止や `requestStop` 後に return 済みの runner を復活させる命令ではない。
- `confirmRecovery`、`/recovery continue`、`/resume-watch`、hold 解除はそれぞれ別 gate に作用する。対象外の gate、queue の不在、期限待ち、停止済み runner を一括して回復させない。
- operator-agent の commit 後停止 candidate では、TUI に表示された文字列とローカル batch がある一方、queue から user event が除かれ、recovery reservation は本文 snapshot ではなく容量枠で、停止分岐は snapshot commit / `agent.send` に到達しない。これは「全ての記録から入力が消えた」と確認された事実ではない。固定 Lean 射影の反例と、それに対応する TS の関数分岐は確認済みだが、当該 stop 順序の TS runtime 到達性は未確認なので、実障害ではなく反例候補として扱う。
- `StoppedRecovery` の限定操作集合では、停止済み runner に `recoveryContinue` 等を適用しても stopped が保たれ、同じ暫定観測から live 状態なら eligible になる例を示す。これは #855 `RecoveryPossible` の反例ではなく、停止状態を区別しない射影で回復経路を splice してしまう危険の例である。

以上の静的照合は関数・状態・遷移候補を絞る根拠であり、await 境界の runtime 順序、全 event の状態写像、プロセス再起動を含む end-to-end の回復を証明しない。

## PR #879 の結果と確度

[PR #879](https://github.com/otolab/agents-ensemble/pull/879) は #859 の完了報告ではなく、現在の合成モデル接続と限定証明を積んだ途中成果である。レビューの承認も、この部分成果に対するもので #859 全体の完了判定ではない。以下は PR の差分・説明・レビューと、この worktree の Lean 定義・証明を対応させた読み方であり、PR の検証コマンドを今回再実行したという意味ではない。

| 結果 | 確度 | ここからは言えないこと |
| --- | --- | --- |
| commit 後停止の固定 Lean 射影で `NoEventLoss`、`AcceptedEventRetained`、`ObservationConsistent` が成立しない。固定した4操作・固定値で長さ3以下の85列を調べ、その範囲では提示列が最短。 | その固定モデル列と固定探索範囲に対する定理・探索結果として確定。 | TS がその停止順序へ到達すること、合成モデル全体や #855 の三性質が不成立なこと、全入力の内容が消失することは示さない。 |
| TS の user `commitBatch` は queue を同期更新した後に Promise を返し、caller は `await retryWatchLock(...)` の後で stopped 分岐を判定する。 | 関数の制御順序として確認済み。固定射影を調べるべき根拠になる。 | queue 通知や他 callback が await 継続より前に停止を届ける実際の runtime trace は確認されていない。したがって stop-before-send は **TS 到達性未確認の反例候補**。TUI dialogue 等の別保持先もあり、全記録から入力が失われたとの結論ではない。 |
| stopped operator を限定操作集合で回復できず、同じ暫定観測を持つ live operator なら回復後に eligible となる列がある。 | `StoppedRecovery` の定義した操作集合と射影の範囲で確認済み。 | #855 `RecoveryPossible` の反例ではない。実装にある全回復操作を列挙した証明でもない。live state と stopped state を同じ観測に潰すと存在しない回復経路を splice し得る、という接続上の問題を示す。 |
| reconnect・上限待機を繰り返す限定無限列が対象選択を行わない。 | その限定列が #855 の弱公平性前提を満たさないことを確認済み。 | `ReconnectResumes` の反例ではない。有限探索や有限 prefix だけでは公平な無限実行の有無・到達不能を決められない。 |

したがって PR #879 の反例候補は「Lean の固定射影では確かな結果」と「TS の実行可能性が未確認」を分けて扱う。TS 全体から抽象状態への対応を示せない限り、後者を実障害または #855 の反例として報告しない。

## TS と Lean の対応

| TS の対象 | 合成モデルの状況と限界 |
| --- | --- |
| conductor の batch 選択・send・reconnect | `ConductorQueue` と lifecycle を接続。非同期 driver の全停止・割り込み・予約失敗は未対応。 |
| operator の input、hold、send、retry 保存、ack、reconnect | `OperatorDispatch` を接続。commit 待機を分離し、成功後の同期的な send 開始までを同じ遷移とする。永続化と外部通信の詳細は未対応。 |
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

| 性質 | 現時点の検査 |
| --- | --- |
| `ObservationConsistent` | **限定例・未判定**。`DelayedRetry` の限定例は成立する一方、commit 後停止の固定射影は不成立。後者の TS 到達性と全体の観測接続は未確認。 |
| `RecoveryPossible` | **到達反例・未判定**。停止後に限定回復操作の任意長の列で具体回復しない例がある。残作業は停止・実行可能性と元命題の量化の対応を構成すること。元命題自体の反例ではない。 |
| `ReconnectRestoresAvailability` | **局所証明・未判定**。operator の有効な成功結果は主体別履歴の観測でも availability を回復する。conductor は具体状態の局所定理まで。残作業は両主体の全結果イベントの観測条件を接続すること。 |
| `ResumeWatchPreservesReportHold` | **局所証明・未判定**。任意の主体別履歴で resume-watch 前後の観測が report hold を保持することを証明。残作業は全体遷移との対応を証明すること。 |
| `ReleaseIndependent` | **局所証明・未判定**。個別操作の一部を証明。残作業は全解除操作の項目・hold・lease・retry の観測を主体別に検査すること。 |
| `NoEventLoss` | **限定射影の到達反例**。commit 後停止の固定具体列で受理済み入力が dispatch・明示破棄なく pending でなくなる。全体接続と TS 実行時の到達性は未検証。 |
| `AcceptedEventRetained` | **限定射影の到達反例**。同じ固定列の受理直後からの保持が成立しない。全体接続と TS 実行時の到達性は未検証。 |
| `NoAutomaticInputReplay` | **限定例・未判定**。有限例と条件付き含意のみ。残作業は失敗 attempt と input ID を履歴上で対応付け、以後の全遷移で再 dispatch されないことを証明すること。 |
| `ScheduledDispatches` | **到達例・未判定**。operator は選択後の停止で send に至らない。残作業は抽象 schedule の対応を定め、元命題を直接検査すること。選択との同時対応では十分条件を満たさない。 |
| `HoldExemptDelivered` | **条件付き証明・未判定**。抽象上の含意と、選択・dispatch を分けた具体実行の条件付き定理がある。残作業は permission stall の具体到達列と無限実行で公平性・選択後進行を検査すること。 |
| `ReconnectResumes` | **限定探索・未判定**。上限待機の到達済み無限列は限定観測では弱公平でなく、元命題の反例にならない。残作業は具体公平性と抽象公平性の対応、選択後進行、対象ごとの無限実行の検査。 |

ここでいう具体履歴への片方向の含意は、具体遷移の両端を射影した遷移で**元命題が成立する場合**の一般定理である。全履歴の観測・イベント対応を構成したという意味でも、抽象経路を具体経路へ逆向きに持ち上げられるという意味でもない。

`ObservedHistory.lean` は主体付きの具体履歴を保持し、operator の user・report の受理、batch の dispatch、完了、report 再投入・retry 停止、完了後 ack の試行・待機・終了、reconnect 要求・開始・結果、resume-watch・recovery continue・report hold、conductor の単一 worker の受理・dispatch・完了と dispatch hold を記録する部分実装である。再投入では report ID を用い、queue の物理 ID と論理 ID を分ける。両主体で同じ数字の ID を使用する例と、初期状態からの reconnect 成功列、主体別の hold 操作列を検査する。完了後に ack が失敗してから待機し、再試行に成功する限定列では send を繰り返さず、観測に ack の期限と operator の時刻を保持する。ack 操作が具体 dispatch 記録を追加しないことも証明した。

operator の commit・ack の時刻は履歴に保持し、後退する指定を未対応として扱う。これはモデル側の限定であり、TS の `Date.now()` が単調であるとの証明ではない。conductor の時刻や各入力・外部結果の時刻、待機の全順序を接続したわけではない。未対応遷移・空の report ID・conductor の複数項目 batch、全履歴の状態射影と観測整合性・公平性は未検査であり、この部分実装によって全性質が成立すると主張しない。

user input の commit 後、send 開始前に停止する初期状態からのモデル列では、入力はモデルの queue と準備中 batch の双方に存在せず、send は始まらない。履歴は dispatch 対象からの不在を保持し、明示的な破棄観測を追加しない。この固定列だけの射影について、`NoEventLoss`、`AcceptedEventRetained`、`ObservationConsistent` の不成立を Lean で証明した。固定した4操作・固定値の長さ3以下の85列には同現象がなく、提示した4操作がその範囲で最短である。

TS では user batch の queue commit の後、待機結果が停止なら runner は return する。reservation の解放は queue への入力復元ではなく、この経路に明示破棄操作もない。合成モデルの当該遷移には runner 停止を反映した。ただし TS 実行時にこの停止が commit 後の await 間で実際に起こるかは未検証である。限定射影の結果を全遷移の観測接続や TS 実行時の反例と同一視しない。

受付時の文字列は queue だけでなく、TUI の表示用 dialogue entries にも追加される。commit 待機中はローカル変数の batch と `operatorInputTexts` にも存在する。recovery inbox の reservation は容量と token を保持するが入力本文は保持せず、停止時に release される。送信前の停止分岐は recovery snapshot の commit や agent send に到達しない。表示用履歴が自動 dispatch に使われることは上記経路では確認できないが、全保管先の不在や内容の完全消失は証明していない。

停止通知は stdin の終了、SIGINT / SIGTERM、TUI の interrupt 等から生じる。queue commit の `notify` は登録済み listener を同期呼び出しする。調査した標準の hold 表示・idle gate と待機解除の listener には停止要求を起こす経路を確認できなかったが、公開 subscribe のすべての利用可能な callback や外部イベント順序を網羅した証明ではない。同期 commit と waiter 継続の間に実際の停止通知が入る根拠は確定しておらず、この列は **モデル反例候補**として扱う。

独立確認で、当初の固定例は「非空入力」としつつ byte 数が既定値 0 だったため、1 byte に修正して証明と限定探索を再実行した。また、限定射影では選択と停止要求をそれぞれ tick に対応させるが、現状の `History.entries` はその tick を保存しない。この証明は固定列の射影についてのものであり、記録済み entries の全遷移接続や観測整合性を証明しない。TS の user commit は同期的に queue を更新してから解決済み Promise を返すため、外部停止イベントが await 後の継続より先に割り込めるかは別途の実行時確認が必要である。

停止済み report 失敗例では、具体側の dispatch に必要な条件に停止していないことを含める。初期状態からの具体列で停止に到達した後、`StoppedRecovery.Action` に列挙した回復操作の任意の有限列では、この必要条件を満たせず、新しい commit も開始できない。再起動や対象外イベントは含まない。一方、同じ履歴の暫定観測では後続入力が #855 の `Eligible` に該当する。これは #855 の `RecoveryPossible` の反例ではなく、抽象経路の存在と具体回復可能性を同一視できないことを示す。停止を availability に織り込むことはしていない。

operator の具体履歴は batch の選択と send 開始を別々に保持する。選択後の停止要求により send が始まらない限定列も検査した。暫定的な抽象 `schedule` は send 開始時に記録するため、これを具体 scheduler の選択と同一視して弱公平性を移すことはできない。具体選択を抽象 `schedule` に対応させると、その限定列では `ScheduledDispatches` の同一遷移での dispatch という十分条件が成立しない。ただし、この十分条件が成立しなくても進行性の命題自体が成立する可能性は残る。

`ConcreteTrace.concrete_fair_eventually_dispatched` は、具体実行において対象が dispatch まで可能であり続け、具体選択が弱公平で、可能な状態での選択が後の dispatch に至るなら、最終的に dispatch されることを直接証明する。最後の進行条件は公平性とは独立の仮定であり、合成モデルで成立することは未証明である。上記の停止例は選択から send への無条件の進行を否定するが、dispatch まで可能であり続けるという命題の前提まで満たす反例ではない。`ReconnectExploration` の上限待機を繰り返す到達済み無限実行は、限定観測では連続 eligible にもかかわらず対象選択がなく、#855 の弱公平性を満たさない。全体モデルの具体公平性と抽象公平性との対応は未構成である。

`Counterexamples.lean` に限定範囲の反例を記載する。停止例の最小性は未検査。reconnect 例の最小性は、固定した開始状態と4種類の固定操作についてのみ長さ3以下を全探索した結果である。いずれも #855 の元命題自体の反例とは主張しない。

## 全体判定までの未解決点

- operator の send 中断と retry 保存例外を履歴に追加した。send 中断の固定列では結果を捏造せず、lease を保持した停止を観測する。ただし commit 例外、停止した ack、空 report ID、入力・report の全到着条件と各観測の一対一対応は未検査。
- conductor の履歴は単一 worker の成功経路と hold に限る。複数項目 batch、permission stall、reconnect、失敗・例外、operator からの到着を同じ主体別履歴に接続する必要がある。
- 遅延 send 結果、保留中の他イベント、時刻と retry 期限について、各具体遷移の両端と記録したイベントの整合性を証明する必要がある。`supported` は全遷移の忠実性を保証する不変条件として証明されていない。
- 無限実行では具体 scheduler の選択と dispatch を区別し、具体側の弱公平性、選択後の進行、抽象命題の `Eligible` を結ぶ必要がある。有限探索はこの証明にならない。
- 停止済み具体 runner と #855 の停止フラグを持たない状態の間では、具体回復可能性と `RecoveryPossible` の存在量化が一致する一般的な接続を構成できていない。既存の限定観測の反例は全ての観測方法の不可能性までは示さない。候補となる観測の全項目・全遷移の忠実性を示す作業が残る。

これらは単一の不足定理を補えば解ける段階には至っていない。特に全遷移と無限実行の具体的な接続・証明方法が未確定のまま、同じ全体未判定が続いている。現状の部分結果を完成と扱うことはできず、作業範囲や #855 を独断で変更せずに完了できる見通しは立っていない。

## [#859](https://github.com/otolab/agents-ensemble/issues/859) の受け入れ条件

| 条件 | 現状 |
| --- | --- |
| #855 の全性質を合成モデル上で検査 | 未達。主体別の全履歴の観測接続がなく、上表の未判定を残す。 |
| 破れる性質ごとの最小反例と日本語説明 | 部分的。commit 後停止の**固定射影**では #855 の3命題の不成立を証明し、固定4操作・固定値では提示列が最短。一方、合成モデル全体・TS 実行時での命題違反と一般的な最小性は未確定。別の retry 保存待ち停止例は最小性未検査。 |
| reconnect 後の再開 | 限定された具体列と、その範囲での最小性を記録済み。弱公平な無限実行の命題に対する判定は未達。 |
| 探索範囲外と抽象化の限界の一覧 | 本文書に記載。追加の未対応が見つかれば更新する。 |
| #848 の Phase 1 判断材料 | 途中経過を記録済み。全性質の判定・重大度を欠き、最終材料は未達。 |
| `sorry` と標準外公理がない | 現在の追加モジュールについて build と公理監査を実施。成果物全体の最終確認は PR 前に再実施する。 |

## [#848](https://github.com/otolab/agents-ensemble/issues/848) Phase 1 の途中判断材料

以下は判断材料の追加であり、Phase 1 の着手・変更範囲・最終判断を決めるものではない。

- 停止、通信可能、確認待ち、処理中は別々に保持する必要がある。availability が true でも同一 runner が停止していれば再開可能とは限らない。
- reconnect 成功は availability の回復を意味し、dispatch 再開までを保証しない。自律ターン上限など別の条件を含めて確認する必要がある。上限待機の到達例を弱公平な無限実行の反例とは扱えない。
- commit と send の間の停止時に入力をどこで保持し、運用者が確認・再投入できるかを検討する価値がある。ただし候補列の TS 実行時到達性は未確定で、現時点では障害の発生を断定できない。
- 完了済み send の ack だけを再試行することは、限定モデルの具体列で検査できる。実運用の再起動・永続化・副作用の重複まではこの結果から判断できない。
- 全性質の判定と公平性・観測の接続が未達であるため、Phase 1 の最終判断や変更範囲を確定する材料としては不足する。
