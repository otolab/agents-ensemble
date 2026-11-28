# Flow の batch recovery 契約

この文書と `BatchRecovery.lean` は、delivery-unknown となった logical batch を同じ ID・member で再送開始する抽象契約を記述する。根拠は Issue #918 と accepted ADR 0088 §4、#855 の Flow property である。

## 抽象 send-start と既存 schedule

既存の `Event.schedule`、`ScheduledDispatches`、`SchedulerFair`、`HoldExemptDelivered`、`ReconnectResumes` は変更していない。これらは現状どおり、schedule の遷移と dispatch 観測を結び付ける既存の抽象境界である。ADR 0087 が候補として挙げる具体 selection / send-start 列への refinement は、この変更でも証明しない。

batch 初回送信は `Event.batchSendStarted` で記録する。この event は Flow 上の抽象 send-start を表し、同じ一遷移で batch record を作り、全 member の `.dispatched` 観測と `lastAttempt` を更新する。batch を選んだだけの状態や、選択から send-start までの中間状態は追加していない。従って、この event は実際の `ConductorAgent.send()` 呼び出しや永続化を示さない。

## membership・attempt・result

`State.batchHistory` は `BatchId` から `BatchRecord` への抽象 ledger である。record には初回 send-start 時の member 列と、時系列順の `BatchAttempt` 列を持たせる。`BatchAttempt.result = none` は結果未確定、`some .unknown` / `.failed` / `.completed` はその attempt の確定結果を表す。結果は既存履歴を置き換えず、recovery attempt を末尾に追加する。

member 列は ID 重複のない非空列に限る。順序は初回 request の内容を記録するため保持するが、ADR 0088 は recovery observation の列挙順までは指定していない。このため coverage は `List.Perm` で照合する。これは ID・attempt の個数も含めて全 member と観測の一対一対応を求める。member の kind は observation 自体には含めず、record と state の kind が一致し、recovery 後も同じ kind / ID の item が `dispatched` のままであることを検査する。

`Event.batchSendResult batch attempt result` は結果を batch と attempt の両方に結び付ける。recovery はその batch の直近 attempt が `.unknown` の場合だけ許し、全 member の `lastAttempt` が同じ source attempt を指すことを求める。recovery event は member list を受け取らず、record に保存された同一 membership を使う。新 attempt による全 member の observation と state 更新は一つの Transition で行うため、途中まで反映した有限 prefix は completed recovery ではない。

## request envelope と input replay

`BatchRecoveryEnvelope.processRestartNotice` は再開通知を同じ request の envelope に含める印であり、batch member や dispatch observation には数えない。envelope の本文・formatter は対象外である。

既存の `NoAutomaticInputReplay` 定義は変更していない。`BatchInputReplayProjection` は trace 全体の変換ではなく、operator input member 一つに対する batch event の項目単位の射影である。初回 dispatch 観測をその ID に絞り、batch result を既存の `.sendResult` に、batch recovery dispatch を既存の `.restartRecoveryDispatch` に写す。worker member はこの射影から除く。`mixed_input_recovery_is_valid_existing_exception` は、実際に到達可能な batch recovery 遷移と input 射影が同じ attempt 1 の unknown から attempt 2 の既存例外へつながることを確認する。

さらに `batch_recovery_input_projection_preserves_existing_exception` は任意の `BatchRecoveryStep` について、record に属する各 input member の dispatch が実際の観測列に含まれ、その一件が同じ ID / 新 attempt の `.restartRecoveryDispatch` に射影されることを示す。`batch_result_projection_preserves_attempt_and_result` は batch result の attempt と分類を既存 `.sendResult` に保つ。

| 既存の input 条件 | batch model / 既存 property での扱い |
|---|---|
| 通常送信の `failed` 後 | `failed` は `LastUnknownBatchAttempt` を満たさず、この process-restart recovery を開始できない。既存 `NoAutomaticInputReplay` の failed 条件も変更していない。 |
| `unknown` 後 | unknown result を同じ source attempt の `.sendResult` に射影し、batch recovery の input 観測を `.restartRecoveryDispatch` に射影する。 |
| 明示 `.operatorResend` 後の `failed` | 既存 property が後続 dispatch を `.operatorResend` に限る条件をそのまま保つ。この batch relation は operator resend 操作自体の再実装・検証はしない。 |
| `completed` 後 | completed attempt は recovery source にならない。既存 Flow の ack-only 説明・性質を維持し、再投入を追加しない。 |

この射影は operator input ID に限る既存 property との event 対応であり、worker に input replay 制約を広げない。event tag から process 再開や TTY operator の選択が実際に起きたとは推論しない。

## 証明と反例

`BatchRecoveryObservationConsistent` は transition relation に対する全称 property で、記録済み batch・unknown source・全 member の状態保持・完全な observation coverage を要求する。`batch_recovery_observation_consistent` が `BatchRecoveryStep` についてこれを証明する。

空虚な含意だけに頼らないよう、`mixed_batch_recovery_reachable` は次の実行で最終状態へ到達することを構成する。

1. operator input ID 10 と worker ID 20 の非空 batch 7 を attempt 1 で send-start する。
2. batch 7 / attempt 1 の結果を unknown と記録する。
3. 同じ batch 7 の attempt 1 を source として recovery を開始し、ID 10・20 の両方を attempt 2 で一度ずつ観測する。

`recovery_accepts_reordered_members` は観測順を入れ替えても成立する。全域証明と明示的な境界例は次のとおり。

- `recovery_rejects_missing_member`、`recovery_rejects_extra_member`: member coverage の欠落・追加。
- `recovery_rejects_replaced_or_mismatched_attempt`: ID 差し替え・member ごとの attempt 不一致。
- `recovery_rejects_wrong_source_attempt`: record にない source attempt。
- `failed_attempt_cannot_start_recovery`、`completed_attempt_cannot_start_recovery`: failed / completed と unknown の区別。
- `recovery_rejects_wrong_member_kind`: record と item state の kind 不一致。
- `prefix_before_recovery_is_incomplete`: recovery event 前に終わる prefix は未完了。

これらは bounded exploration ではなく Lean theorem であり、`sorry` / `native_decide` は使わない。axiom 依存は `BatchRecoveryAxioms.lean` の `#print axioms` で個別に確認する。

## 保証の境界

この model が示す atomicity は Flow の一段遷移内の論理的一括更新だけである。process が途中で落ちても batch record が復元されること、実際の send invocation、provider が request を受け取ったか、agent の部分実行、外部副作用の重複・deduplication、電源断後の保持、producer outbox handoff、ack、最終配信は証明しない。`BatchId` と `EventId` はこの model 内の識別子で runtime の永続 ID との同一性はない。

初回 selection から send-start までの crash 境界も表現しない。#897 の To-Be core が本契約を使う際の state/event refinement と、ADR 0088 が要求する永続 store / recovery 実装は別途検証が必要である。fairness、有限時間内の再開、eventual dispatch / delivery もこの issue では追加しない。
