# operator-agent の As-Is モデル

`OperatorDispatch.lean` は、一つの operator-agent process の dispatch 状態と、外部操作の結果を受けた遷移を実行可能にする。共有 lifecycle と recovery inbox は `ConductorDispatchLifecycle.lean` を使う。

## 対応表

| TypeScript のファイル | 関数・状態 | Lean の定義 |
|---|---|---|
| `packages/operator-agent/src/dispatch/operator-dispatch.ts` | `OperatorDispatchEvent`, `OperatorDispatchState`, `OperatorDispatchBatch`, `OperatorDispatchPriority` | `Event`, `SelectionState`, `Batch`, `Event.priority` |
| 同上 | `createOperatorDispatchQueue`, `isHeld`, `updateHold`, `setConversationHold`, `setHold` | `Queue`, `Queue.isHeld`, `Queue.updateHold`, `Queue.setConversationHold`, `Queue.setHold` |
| 同上 | `enqueueUser`, `enqueueReport`, `enqueueReports`, `requeue` | `Queue.enqueueUser`, `Queue.enqueueReport`, `Queue.enqueueReports`, `Queue.requeueUser`, `Queue.requeueReport` |
| 同上 | `requestReports`, `completeReportRequest`, `discardQueuedReports` | `Queue.requestReports`, `Queue.completeReportRequest`, `Queue.discardReports` |
| 同上 | `selectOperatorDispatchBatch`, `eligibleReports`, `selectBatch`, `isBatchCurrent` | `deadline`, `thresholdTime`, `Queue.candidate`, `Queue.selectBatchWith`, `Queue.selectBatch`, `Queue.isBatchCurrent` |
| 同上 | `commitBatch`, `rollbackBatchCommit`, `takeBatch` | `Queue.commitBatch`, `Queue.rollbackBatchCommit`, `Queue.takeBatch` |
| `packages/operator-agent/src/watch/operator-watch-dispatch.ts` | commit の永続化失敗時、`acknowledge` | `Queue.afterCommitError`, `Queue.discardReports` |
| `packages/operator-agent/src/run/run-operator-conversation.ts` | 通常入力、`/resume-watch` | `Queue.handleUser`, `Queue.resumeWatch` |
| 同上 | `pendingReconnects`, `beginReconnect`, `settleReconnect` | `Runner.requestReconnect`, `Runner.beginReconnect`, `Runner.settleReconnect` |
| 同上 | send 開始、commit 前の停止・失敗、中断、send 後の settle | `Runner.beginSend`, `Runner.settleBeforeSend`, `Runner.interruptSend`, `Runner.settleSend` |
| 同上 | 未完了 send 後の `recordRetry` と再投入 | `Runner.retryPending`, `Runner.retryStoredAt`, `Runner.finishRetryRecord` |
| 同上 | `/recovery list`, `/recovery continue`, `/recovery clear` | `Runner.recoveryList`, `Runner.recoveryContinue`, `clearRecoverySnapshot` |
| 同上 | ack 成功後の request 完了と conversation hold 解除 | `Runner.finishAcknowledged` |
| `packages/operator-agent/src/watch/operator-watch-ack.ts` | `retryOperatorWatchAcknowledgement` | `AckState`, `Runner.ackResult`, `Runner.advanceAck` |
| `packages/operator-agent/src/tools/operator-control-tools.ts`, `packages/operator-agent/src/run-operator-agent.ts` | `set_report_hold` の登録と実行 | `Queue.setHold` |

Lean 名はすべて `Ensemble.AsIs.OperatorDispatch` の配下。共有 settle と lease の対応は `ConductorDispatchLifecycle.lean` の対応表にある。

## 抽象化と入力の前提

- 時刻は自然数のミリ秒として各操作に渡す。timer、待機、通知 listener は実行せず、停止・I/O の成否を外部結果として与える。retry の durable な期限と queue の期限は、TS と同じく別々の時刻から計算する。lock、永続化、process 間 handoff は対象外だが、commit が永続化に達したか、retry 保存待ちが停止したかは区別する。
- `Event.id` は TS の object identity、`arrival` は process 内到着順、`arrivalOrder` は保存される report の順序を表す。新規イベントの identity と arrival は呼び出し側が TS の採番結果と整合するよう一意に供給し、retry では別 identity を発行する。空の report ID の truthiness はモデル内で扱う。watch state が受け入れる frozen batch ID は空ではない（`watch-state-store.ts` の検証）。
- report type は、選択に使う `question`、priority、weight に射影する。priority の 0 / 1 / 2 は open question / normal / idle。enqueue 時に TS が決定する既定 priority、report type ごとの weight、focus の期限切れ後の値は呼び出し側が与える。本文は選択に使わないため保持せず、UTF-8 byte 数、空白判定、batch ID、整形済み payload を与える。payload は凍結後に保持する。
- selection reason、deadline reason、eligibility は scheduling event の診断出力に使われ、後続の選択や hold・retry の制御には使われないため省略する。`usedContinuation` は次の選択に影響するため保持し、`isBatchCurrent` の成功時も更新する。focus 操作と timeout の時計は対象 queue 操作の外から反映する。
- `/recovery` の構文解析、本文表示、snapshot 容量・期限の計算は外部に置く。list で表示した attempt と continue の原子的照合、clear が attention を解除しないことはモデル化する。snapshot の固定 prefix は共有 inbox モデルと同じく attempt ID に射影する。
- ack の保存が成功したときだけ、同じ ID の pending / held / request / in-flight / retry index を取り除く。停止・枯渇では再 send や conversation hold の解除を行わない。durable state の内容と再起動後の重複配信は別 process の扱いとして抽象化する。

`#guard` は主な分岐の期待値を検査し、`#eval` は user 入力と send 完了、`/resume-watch`、手動 hold の併用、send 失敗後の reconnect を評価する。性質全体の検査と反例記録は #859 の対象である。
