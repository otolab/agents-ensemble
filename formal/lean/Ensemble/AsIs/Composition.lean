import Ensemble.AsIs.ConductorQueue
import Ensemble.AsIs.OperatorDispatch
import Ensemble.Flow.Spec
import Ensemble.AsIs.RecoveryProjection

/-! # conductor と operator の具体状態

両者は別プロセスの状態を保持し、同じ lifecycle の定義をそれぞれ使用する。
`operatorMessageDelivered` は UDS が通常 message を受け付けた結果を外部から与える。
operator 自身の agent send が conductor への message を自動生成するとは仮定しない。
watch report の到着も外部入力であり、poll、永続化、通信の成否は表さない。
このファイルは操作の接続を作る途中段階であり、全イベントや抽象仕様をまだ網羅しない。
TS との対応状況と各性質の検査範囲は `Composition.md` を参照する。
-/
namespace Ensemble.AsIs.Composition

open Ensemble.AsIs.ConductorDispatchLifecycle

/-- retry 保存待ちから抜けた理由。timeout は継続であり終了理由ではない。 -/
inductive RetryExit where
  | stopped | exception
  deriving Repr, BEq, DecidableEq

/-- process 内で払い出す reservation の識別子と入力 byte 数。 -/
structure Reservation where
  id : Nat
  bytes : Nat
  deriving Repr, BEq, DecidableEq

/-- 二つの独立した実行主体と、各主体が保有する reconnect lease。 -/
structure System where
  conductor : Ensemble.AsIs.ConductorQueue.Driver := {}
  operator : Ensemble.AsIs.OperatorDispatch.Runner := {}
  conductorReconnect : Option Lease := none
  operatorReconnect : Option Lease := none
  operatorSend : Option Lease := none
  operatorInbox : Inbox := {}
  conductorSend : Option Lease := none
  conductorInbox : Inbox := {}
  conductorError : Option SettlementError := none
  autonomousTurns : Nat := 0
  maxTurns : Nat := 0
  nextAutonomousTurns : Option Nat := none
  operatorRetryExit : Option RetryExit := none
  /-- TTY の入力終了。送信の停止や lifecycle の availability とは別。 -/
  operatorInputEnded : Bool := false
  /-- requestStop による送信抑止。入力終了とは独立する。 -/
  operatorStopRequested : Bool := false
  /-- commit 待機中に保持する batch と、その予約。 -/
  operatorPreparing : Option Ensemble.AsIs.OperatorDispatch.Batch := none
  operatorReservation : Option Reservation := none
  operatorNextReservationId : Nat := 0
  operatorCanInspectRecovery : Bool := false
  operatorCommitLease : Option Lease := none
  operatorCommitInputEndedAtStart : Bool := false
  operatorCommitApplied : Option Bool := none
  operatorCommitConfig : Option Ensemble.AsIs.OperatorDispatch.Scheduling := none

/-- それぞれの実行主体に渡す操作と外部から返る reconnect の結果。 -/
inductive Event where
  | conductorEnqueue (event : Ensemble.AsIs.ConductorQueue.Event)
  | operatorMessageDelivered (id : Nat) (bytes : Nat)
  | conductorHold (enabled : Bool)
  | conductorBeginReconnect (token : Nat)
  | conductorReconnectResult (success aborted : Bool)
  | conductorBeginSend (token running : Nat)
      (pending : Option (List String)) (byteLimit : Option Nat) (reservationOk : Bool)
  | conductorSendResult (input : SettlementInput)
  | operatorInput (event : Ensemble.AsIs.OperatorDispatch.Event) (nonblank : Bool) (limit : Nat)
  | operatorInputEnd
  | operatorRequestStop
  | operatorWaitStopped
  | operatorFinishInput
  | operatorReport (event : Ensemble.AsIs.OperatorDispatch.Event) (now delay maxWait : Nat)
  | operatorHold (enabled : Bool)
  | operatorResumeWatch
  | operatorRecoveryContinue
  | operatorRequestReconnect
  | operatorBeginReconnect (token : Nat)
  | operatorReconnectResult (success : Bool)
  | operatorBeginCommit (token : Nat) (config : Ensemble.AsIs.OperatorDispatch.Scheduling)
      (now : Nat) (reservationOk hasReservation : Bool)
  | operatorCommitSuccess (batchId payload : String)
  | operatorCommitApply (batchId payload : String) (now : Nat)
  | operatorCommitStopped (batchId payload : String) (committed : Bool)
  | operatorCommitException (batchId payload : String) (committed durable : Bool)
  | operatorSendResult (input : SettlementInput) (now : Nat)
  | operatorInterruptSend
  | operatorRetryResult (readTime : Nat → Nat) (success : Bool)
  | operatorRefreshReport (persisted : Ensemble.AsIs.OperatorDispatch.Event) (persistedReadyAt : Nat)
  | operatorRetryStopped
  | operatorRetryException
  | operatorAckResult (success : Bool) (now : Nat)
  | operatorAdvanceAck (now : Nat) (stopped : Bool)
  | operatorFinishAcknowledged

/-- 状態を共有せず、指定した主体の既存モデルを呼び出す同期遷移。 -/
def step (s : System) : Event → System
  | .conductorEnqueue event =>
    { s with conductor := { s.conductor with queue := Ensemble.AsIs.ConductorQueue.enqueue s.conductor.queue event } }
  | .operatorMessageDelivered id bytes =>
    let event : Ensemble.AsIs.ConductorQueue.Event := { id, kind := .operator, bytes }
    { s with conductor := { s.conductor with queue := Ensemble.AsIs.ConductorQueue.enqueue s.conductor.queue event } }
  | .conductorHold enabled =>
    let (hold, queue) := Ensemble.AsIs.ConductorQueue.setHold s.conductor.hold s.conductor.queue enabled
    { s with conductor := { s.conductor with hold, queue } }
  | .conductorBeginReconnect token =>
    if s.conductorError.isSome then s else
    let (d, selected) := Ensemble.AsIs.ConductorQueue.chooseDispatch s.conductor 0 0 0 none none true
    match selected with
    | some dispatch =>
      if dispatch.batch.source == .reconnect then
        let (d, lease) := Ensemble.AsIs.ConductorQueue.beginDispatch d dispatch token
        { s with conductor := d, conductorReconnect := lease.orElse (fun _ => s.conductorReconnect) }
      else { s with conductor := d }
    | none => { s with conductor := d }
  | .conductorReconnectResult success aborted =>
    if s.conductorError.isSome then s else
    match s.conductorReconnect with
    | none => s
    | some lease =>
      match Ensemble.AsIs.ConductorQueue.settleReconnect s.conductor lease success aborted with
      | .error _ => s
      | .ok d => { s with conductor := d, conductorReconnect := none }
  | .conductorBeginSend token running pending byteLimit reservationOk =>
    if s.conductorError.isSome then s else
    let (d, selected) := Ensemble.AsIs.ConductorQueue.chooseDispatch s.conductor s.autonomousTurns s.maxTurns running pending byteLimit reservationOk
    match selected with
    | none => { s with conductor := d }
    | some dispatch =>
      if dispatch.batch.source == .reconnect then { s with conductor := d } else
      let (d, lease) := Ensemble.AsIs.ConductorQueue.beginDispatch d dispatch token
      match lease with
      | none => { s with conductor := d }
      | some lease =>
        let events := dispatch.batch.events
        let nextTurns :=
          if events.all (fun e => e.kind == .reconnect || e.kind == .recoveryReport) then s.autonomousTurns
          else if events.any (fun e => e.kind == .operator) then 0
          else s.autonomousTurns + 1
        { s with conductor := Ensemble.AsIs.ConductorQueue.recordSend d dispatch, conductorSend := some lease, nextAutonomousTurns := some nextTurns }
  | .conductorSendResult input =>
    if s.conductorError.isSome then s else
    match s.conductorSend with
    | none => s
    | some lease =>
      let result := settleConductorDispatch s.conductor.lifecycle { input with lease, workflow := .issue } s.conductorInbox
      let conductor := { s.conductor with lifecycle := result.lifecycle }
      match result.result with
      | .ok _ => { s with conductor, conductorInbox := result.inbox, conductorSend := none, autonomousTurns := s.nextAutonomousTurns.getD s.autonomousTurns, nextAutonomousTurns := none }
      | .error error => { s with conductor, conductorInbox := result.inbox, conductorError := some error }
  | .operatorInput event nonblank limit =>
    if s.operator.stopped || s.operatorInputEnded then s else
    let (queue, _) := s.operator.queue.handleUser event nonblank limit
    { s with operator := { s.operator with queue } }
  | .operatorInputEnd =>
    { s with operatorInputEnded := true }
  | .operatorRequestStop =>
    { s with operatorStopRequested := true }
  | .operatorWaitStopped =>
    if s.operatorStopRequested && s.operatorSend.isNone &&
        s.operatorPreparing.isNone && !s.operator.retryPending &&
        s.operator.ack == .idle then
      { s with operator := { s.operator with stopped := true } }
    else s
  | .operatorFinishInput =>
    if s.operatorInputEnded && !s.operator.stopped &&
        !(s.operator.queue.pending.any (·.user)) &&
        s.operator.pendingReconnects == 0 &&
        s.operatorSend.isNone && !s.operator.retryPending &&
        s.operatorPreparing.isNone &&
        s.operatorReconnect.isNone && s.operator.ack == .idle then
      { s with operator := { s.operator with stopped := true } }
    else s
  | .operatorReport event now delay maxWait =>
    if s.operator.stopped then s else
    let queue := s.operator.queue.enqueueReport event now delay maxWait
    { s with operator := { s.operator with queue } }
  | .operatorHold enabled =>
    if s.operator.stopped then s else
    let (queue, _) := s.operator.queue.setHold enabled
    { s with operator := { s.operator with queue } }
  | .operatorResumeWatch =>
    if s.operator.stopped || s.operatorInputEnded then s else
    let (queue, _) := s.operator.queue.resumeWatch
    { s with operator := { s.operator with queue } }
  | .operatorRecoveryContinue =>
    if s.operatorInputEnded then s else
    { s with operator := (s.operator.recoveryContinue none).1 }
  | .operatorRequestReconnect =>
    if s.operatorInputEnded then s else
    { s with operator := s.operator.requestReconnect }
  | .operatorBeginReconnect token =>
    let (operator, lease) := s.operator.beginReconnect token
    { s with operator, operatorReconnect := lease.orElse (fun _ => s.operatorReconnect) }
  | .operatorReconnectResult success =>
    if s.operator.stopped then s else
    match s.operatorReconnect with
    | none => s
    | some lease =>
      match s.operator.settleReconnect lease success with
      | .error _ => s
      | .ok operator => { s with operator, operatorReconnect := none }
  | .operatorBeginCommit token config now reservationOk canInspect =>
    if s.operator.stopped || !s.operator.lifecycle.canDispatch || s.operator.retryPending || s.operator.pendingReconnects > 0 ||
        s.operator.ack != .idle || s.operatorPreparing.isSome ||
        canInspect != s.operatorCanInspectRecovery then s else
    let (queue, selected) := s.operator.queue.selectBatch s.operator.selection config now
    let s := { s with operator := { s.operator with queue } }
    match selected with
    | none => s
    | some batch =>
      let users := batch.events.filter (·.user)
      let bytes := users.foldl (fun n event => n + event.bytes) 0
      if canInspect && (!reservationOk || (!users.isEmpty && bytes > 1048576)) then s else
      let (operator, lease) := s.operator.beginSend token
      match lease with
      | none => { s with operator }
      | some lease =>
        let reservation := if canInspect && !users.isEmpty then some ⟨s.operatorNextReservationId, bytes⟩ else none
        let (operator, batch, applied) := if batch.session.isNone || batch.batchId.isSome then
          let (queue, batch, current) := if batch.batchId.isSome then operator.queue.isBatchCurrent operator.selection config now batch else (operator.queue, batch, true)
          if current then
            let (queue, batch, applied) := queue.commitBatch batch "" ""
            ({ operator with queue }, batch, some applied)
          else ({ operator with queue }, batch, some false)
          else (operator, batch, none)
        { s with operator, operatorPreparing := some batch, operatorCommitLease := some lease, operatorReservation := reservation, operatorNextReservationId := s.operatorNextReservationId + if reservation.isSome then 1 else 0, operatorCommitInputEndedAtStart := s.operatorInputEnded, operatorCommitApplied := applied, operatorCommitConfig := some config }
  | .operatorCommitApply batchId payload now =>
    match s.operatorPreparing, s.operatorCommitLease, s.operatorCommitConfig with
    | some batch, some _, some config =>
      if s.operatorCommitApplied.isSome then s else
      let (queue, batch, current) := s.operator.queue.isBatchCurrent s.operator.selection config now batch
      let (queue, batch, applied) := if current then queue.commitBatch batch batchId payload else (queue, batch, false)
      { s with operator := { s.operator with queue }, operatorPreparing := some batch, operatorCommitApplied := some applied }
    | _, _, _ => s
  | .operatorCommitSuccess batchId payload =>
    match s.operatorPreparing, s.operatorCommitLease with
    | some batch, some lease =>
      if s.operator.stopped || s.operatorStopRequested ||
          (s.operatorInputEnded && !s.operatorCommitInputEndedAtStart) then s else
      let _ := (batchId, payload)
      match s.operatorCommitApplied with
      | none => s
      | some committed =>
      let operator := s.operator
      if !committed then
        match operator.settleBeforeSend lease .rejected with
        | .ok operator => { s with operator, operatorPreparing := none, operatorCommitLease := none, operatorReservation := none, operatorCommitApplied := none }
        | .error _ => s
      else
        let operator := { operator with batch := batch.events, batchUsedContinuation := batch.usedContinuation }
        { s with operator, operatorPreparing := none, operatorCommitLease := none, operatorSend := some lease, operatorCommitApplied := none }
    | _, _ => s
  | .operatorCommitStopped batchId payload committed =>
    match s.operatorPreparing, s.operatorCommitLease with
    | some batch, some lease =>
      if !(s.operatorStopRequested || (s.operatorInputEnded && !s.operatorCommitInputEndedAtStart)) then s else
      let _ := (batchId, payload, batch)
      if (committed && s.operatorCommitApplied != some true) ||
          (!committed && s.operatorCommitApplied == some true) then s else
      let queue := s.operator.queue
      match ({ s.operator with queue }).settleBeforeSend lease .stopped with
      | .ok operator => { s with operator := { operator with stopped := true }, operatorPreparing := none, operatorCommitLease := none, operatorReservation := none, operatorCommitApplied := none }
      | .error _ => s
    | _, _ => s
  | .operatorCommitException batchId payload committed durable =>
    match s.operatorPreparing, s.operatorCommitLease with
    | some batch, some lease =>
      if s.operatorCommitApplied.isSome && s.operatorCommitApplied != some committed then s else
      let (queue, batch) := if committed && s.operatorCommitApplied.isNone then
        let (q, b, _) := s.operator.queue.commitBatch batch batchId payload
        (q, b)
        else (s.operator.queue, batch)
      let (queue, _) := queue.afterCommitError batch committed durable
      match ({ s.operator with queue }).settleBeforeSend lease .error with
      | .ok operator => { s with operator, operatorPreparing := none, operatorCommitLease := none, operatorReservation := none, operatorCommitApplied := none }
      | .error _ => s
    | _, _ => s
  | .operatorSendResult input now =>
    match s.operatorSend with
    | none => s
    | some lease =>
      if s.operator.stopped then s else
      let (operator, result) := s.operator.settleSend
        { input with lease, hasInbox := true, hasReservation := s.operatorReservation.isSome, inputTooLarge := false, captureFailure := s.operatorCanInspectRecovery } s.operatorInbox now
      match result with
      | none => { s with operator }
      | some result =>
        { s with operator, operatorInbox := result.inbox, operatorSend := none, operatorReservation := if result.inboxEffect == .none then s.operatorReservation else none }
  | .operatorInterruptSend =>
    if s.operatorSend.isNone || !s.operatorStopRequested then s else
    { s with operator := s.operator.interruptSend, operatorReservation := none }
  | .operatorRetryResult readTime success =>
    if !success || s.operatorInputEnded || s.operatorStopRequested then s else
    { s with operator := s.operator.finishRetryRecord readTime true }
  | .operatorRefreshReport persisted persistedReadyAt =>
    { s with operator := { s.operator with
        queue := s.operator.queue.reconcileQueuedReport persisted persistedReadyAt } }
  | .operatorRetryStopped =>
    if s.operator.stopped || !s.operator.retryPending ||
        !(s.operatorInputEnded || s.operatorStopRequested) then s else
    { s with operator := s.operator.finishRetryRecord (fun _ => 0) false, operatorRetryExit := some .stopped }
  | .operatorRetryException =>
    if s.operator.stopped || !s.operator.retryPending then s else
    { s with operator := s.operator.finishRetryRecord (fun _ => 0) false, operatorRetryExit := some .exception }
  | .operatorAckResult success now =>
    { s with operator := s.operator.ackResult success now }
  | .operatorAdvanceAck now stopped =>
    if stopped && !s.operatorStopRequested then s else
    { s with operator := s.operator.advanceAck now stopped }
  | .operatorFinishAcknowledged =>
    { s with operator := s.operator.finishAcknowledged }

/-- 初期状態から操作列を順に実行する。 -/
def run (s : System) (events : List Event) : System := events.foldl step s

/- 予約の有無を send 結果から偽装できない。input の失敗は同じ予約を消費し、
   report のみの batch は予約を作らない。 -/
#guard (decide (
  let config : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let dummy : Lease := ⟨0, "", .send, 0⟩
  let failure : SettlementInput :=
    { lease := dummy, workflow := .operatorAgent, status := .other,
      failureClass := .transport, hasReservation := false, captureFailure := false }
  let sending := run { operatorCanInspectRecovery := true } [
    .operatorInput { id := 1, user := true, bytes := 12 } true 100,
    .operatorBeginCommit 1 config 0 true true,
    .operatorCommitApply "batch" "payload" 0,
    .operatorCommitSuccess "batch" "payload"]
  let settled := step sending (.operatorSendResult failure 0)
  let reportOnly := run { operatorCanInspectRecovery := true } [
    .operatorReport { id := 2, user := false, session := "s", reportId := some "r" } 0 0 0,
    .operatorBeginCommit 2 config 0 true true]
  sending.operatorReservation == some ⟨0, 12⟩ &&
    settled.operatorReservation.isNone && settled.operatorInbox.snapshots.length == 1 &&
    reportOnly.operatorCommitLease.isSome && reportOnly.operatorReservation.isNone
))

/- report の lock 待機中に user が到着すると、commit 時の再選択で
   元の report batch が最新でない場合は commit を拒否する。 -/
#guard (decide (
  let config : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let waiting := run {} [
    .operatorReport { id := 1, user := false, session := "s", reportId := some "r" } 0 0 0,
    .operatorBeginCommit 1 config 0 true false,
    .operatorInput { id := 2, user := true } true 100,
    .operatorCommitApply "batch" "payload" 0]
  waiting.operatorCommitApplied == some false &&
    waiting.operator.queue.pending.any (fun e => e.user && e.id == 2) &&
    waiting.operator.queue.held.any (fun e => e.reportId == some "r")
))

/- user batch は await より前に queue から取り除かれ、待機中に受けた
   次の入力は先行 batch の commit に取り込まれない。 -/
#guard (decide (
  let config : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let beforeCallback := run {} [
    .operatorInput { id := 1, user := true } true 100,
    .operatorBeginCommit 1 config 0 true false]
  let afterCallback := step beforeCallback (.operatorInput { id := 2, user := true } true 100)
  beforeCallback.operatorCommitApplied == some true &&
    !(beforeCallback.operator.queue.pending.any (fun e => e.id == 1)) &&
    afterCallback.operator.queue.pending.any (fun e => e.id == 2) &&
    (step afterCallback (.operatorCommitStopped "" "" false)).operatorCommitApplied == some true
))

/- commit 待機の途中停止では、commit の成否にかかわらず reservation と lease を
   解放する。commit 済みの queue 更新は取り消さない。 -/
#guard (decide (
  let config : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let prepared := run { operatorCanInspectRecovery := true } [
    .operatorInput { id := 1, user := true } true 100,
    .operatorBeginCommit 1 config 0 true true]
  let requested := step prepared .operatorRequestStop
  let reportWaiting := run {} [
    .operatorReport { id := 2, user := false, session := "s", reportId := some "r" } 0 0 0,
    .operatorBeginCommit 2 config 0 true false,
    .operatorRequestStop]
  let beforeCommit := step reportWaiting (.operatorCommitStopped "batch" "payload" false)
  let afterCommit := step requested (.operatorCommitStopped "batch" "payload" true)
  prepared.operatorReservation.isSome && prepared.operatorCommitLease.isSome &&
    prepared.operator.lifecycle.activeLease.isSome &&
    beforeCommit.operatorReservation.isNone && beforeCommit.operatorCommitLease.isNone &&
    beforeCommit.operator.lifecycle.activeLease.isNone && beforeCommit.operator.stopped &&
    beforeCommit.operator.queue.pending.any (fun e => e.id == 2) &&
    afterCommit.operatorReservation.isNone && afterCommit.operator.lifecycle.activeLease.isNone &&
    afterCommit.operator.stopped && !(afterCommit.operator.queue.pending.any (fun e => e.id == 1))
))

/- 入力終了時は新規入力とコマンドを受け付けず、保留 user があれば
   ループを終了しない。retry 保存の停止には終了または停止要求が必要。 -/
#guard (decide (
  let ended := step ({} : System) .operatorInputEnd
  let pending := run ({} : System) [
    .operatorInput { id := 7, user := true } true 100, .operatorInputEnd]
  (step ended (.operatorInput { id := 8, user := true } true 100)).operator.queue.pending.isEmpty &&
  (step ended .operatorRequestReconnect).operator.pendingReconnects == 0 &&
  (step ended .operatorFinishInput).operator.stopped &&
  !(step pending .operatorFinishInput).operator.stopped
))

/- dispatch 不可の待機中に requestStop が届くと runner は return する。
   confirmation と後続入力はそのまま残る。 -/
#guard (decide (
  let config : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let failure : SettlementInput :=
    { lease := ⟨0, "", .send, 0⟩, workflow := .operatorAgent,
      status := .other, failureClass := .transport, captureFailure := false }
  let waiting := run {} [
    .operatorInput { id := 1, user := true, bytes := 1 } true 100,
    .operatorBeginCommit 1 config 0 true false,
    .operatorCommitApply "batch" "payload" 0,
    .operatorCommitSuccess "batch" "payload",
    .operatorInput { id := 2, user := true, bytes := 1 } true 100,
    .operatorSendResult failure 0,
    .operatorRetryResult (fun _ => 0) true
  ]
  let stopped := run waiting [.operatorRequestStop, .operatorWaitStopped]
  waiting.operator.lifecycle.pendingAttemptId.isSome &&
    waiting.operator.queue.pending.any (fun e => e.user && e.id == 2) &&
    !waiting.operator.lifecycle.canDispatch &&
    stopped.operator.stopped &&
    stopped.operator.lifecycle.pendingAttemptId.isSome &&
    stopped.operator.queue.pending.any (fun e => e.user && e.id == 2)
))

/- 独立した二主体は同時に send lease を持てる。共有 lease への射影には
   対象主体の限定などが必要で、両方を単一 lease にそのまま保存することはできない。 -/
#guard (decide (
  let config : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let both := run {} [
    .conductorEnqueue { id := 1, kind := .workerCompleted, name := "worker" },
    .conductorBeginSend 1 0 none none true,
    .operatorInput { id := 2, user := true } true 100,
    .operatorBeginCommit 2 config 0 true false,
    .operatorCommitApply "batch" "payload" 0,
    .operatorCommitSuccess "batch" "payload"
  ]
  both.conductor.lifecycle.activeLease.isSome &&
    both.operator.lifecycle.activeLease.isSome
))

/-- 入力終了後は TTY 由来の recovery、reconnect、resume-watch を受け付けない。 -/
theorem input_end_rejects_commands (s : System) (ended : s.operatorInputEnded = true) :
    step s .operatorRecoveryContinue = s ∧
    step s .operatorRequestReconnect = s ∧
    step s .operatorResumeWatch = s := by
  simp [step, ended]

/-- 停止契機がない retry 保存待ちは、停止結果を選んでも状態を変えない。 -/
theorem retry_stop_requires_signal (s : System)
    (inputOpen : s.operatorInputEnded = false)
    (notRequested : s.operatorStopRequested = false) :
    step s .operatorRetryStopped = s := by
  simp [step, inputOpen, notRequested]

/-- `/resume-watch` は任意の具体状態で手動 report hold を変えない。 -/
theorem resumeWatch_preserves_reportHold (s : System) :
    (step s .operatorResumeWatch).operator.queue.reportHold = s.operator.queue.reportHold := by
  simp only [step]
  split
  · rfl
  · simp [Ensemble.AsIs.OperatorDispatch.Queue.resumeWatch,
      Ensemble.AsIs.OperatorDispatch.Queue.setConversationHold,
      Ensemble.AsIs.OperatorDispatch.Queue.updateHold]
    split <;> simp_all
    split <;> rfl

/-- `/resume-watch` は conductor 側の状態を変更しない。 -/
theorem resumeWatch_preserves_conductor (s : System) :
    (step s .operatorResumeWatch).conductor = s.conductor := by
  simp only [step]
  split <;> rfl

/-- `/resume-watch` は lifecycle と retry・ack・reconnect 待ちを変えない。 -/
theorem resumeWatch_preserves_lifecycle_and_waits (s : System) :
    let next := step s .operatorResumeWatch
    next.operator.lifecycle = s.operator.lifecycle ∧
      next.operator.retryPending = s.operator.retryPending ∧
      next.operator.ack = s.operator.ack ∧
      next.operator.pendingReconnects = s.operator.pendingReconnects := by
  simp only [step]
  split <;> simp

/-- recovery continue は operator の queue、retry、reconnect 要求を変えない。 -/
theorem recoveryContinue_preserves_queue_and_waits (s : System) :
    let next := step s .operatorRecoveryContinue
    next.operator.queue = s.operator.queue ∧
      next.operator.retryPending = s.operator.retryPending ∧
      next.operator.pendingReconnects = s.operator.pendingReconnects ∧
      next.conductor = s.conductor := by
  simp only [step, Ensemble.AsIs.OperatorDispatch.Runner.recoveryContinue]
  split
  · simp
  · split
    · simp
    · split <;> simp

/-- 停止済み operator は回復操作や reconnect の要求・結果を処理しない。 -/
theorem stopped_operator_recovery_noop (s : System) (stopped : s.operator.stopped = true) :
    (step s .operatorRecoveryContinue).operator = s.operator ∧
    (step s .operatorResumeWatch).operator = s.operator ∧
    (step s (.operatorHold false)).operator = s.operator ∧
    (step s .operatorRequestReconnect).operator = s.operator ∧
    (step s (.operatorBeginReconnect 1)).operator = s.operator ∧
    (step s (.operatorReconnectResult true)).operator = s.operator := by
  simp [step, stopped, Ensemble.AsIs.OperatorDispatch.Runner.recoveryContinue,
    Ensemble.AsIs.OperatorDispatch.Runner.requestReconnect,
    Ensemble.AsIs.OperatorDispatch.Runner.beginReconnect]

/-- 一致する reconnect lease の成功結果は availability を true にする。 -/
theorem reconnect_success_available
    (before after : Lifecycle) (lease : Lease)
    (h : before.settleReconnect lease true = .ok after) : after.available = true := by
  simp only [Lifecycle.settleReconnect] at h
  split at h
  · contradiction
  · cases h
    rfl

/-- operator の有効な reconnect 成功は、合成状態の availability を回復する。 -/
theorem operator_reconnect_success_available (s : System) (lease : Lease)
    (running : s.operator.stopped = false)
    (pending : s.operatorReconnect = some lease)
    (matching : s.operator.lifecycle.matches lease .reconnect = true) :
    (step s (.operatorReconnectResult true)).operator.lifecycle.available = true := by
  simp [step, running, pending, Ensemble.AsIs.OperatorDispatch.Runner.settleReconnect,
    Lifecycle.settleReconnect, matching, Functor.map, Except.map]

/-- conductor も有効な reconnect 成功で availability を回復する。 -/
theorem conductor_reconnect_success_available (s : System) (lease : Lease) (aborted : Bool)
    (running : s.conductorError = none)
    (pending : s.conductorReconnect = some lease)
    (matching : s.conductor.lifecycle.matches lease .reconnect = true) :
    (step s (.conductorReconnectResult true aborted)).conductor.lifecycle.available = true := by
  simp [step, running, pending, Ensemble.AsIs.ConductorQueue.settleReconnect,
    Lifecycle.settleReconnect, matching, Functor.map, Except.map]

/- 有効な lease がない成功結果は no-op。抽象の成功観測として一律には扱えない。 -/
#guard (decide (
  let s : System := { operator := { lifecycle := { available := false } }, conductor := { lifecycle := { available := false } } }
  !(step s (.operatorReconnectResult true)).operator.lifecycle.available &&
    !(step s (.conductorReconnectResult true false)).conductor.lifecycle.available
))

/-- `/resume-watch` の手動 hold に限った抽象観測。項目と履歴の一般的な写像ではない。 -/
def resumeObservation (s : System) : Ensemble.Flow.State :=
  { Ensemble.AsIs.RecoveryProjection.observe s.operator with dispatchHold := s.conductor.hold.active }

/-- `/resume-watch` のみを持つ具体遷移。 -/
def resumeModel : Ensemble.AsIs.ConcreteTrace.Model System where
  observe := resumeObservation
  step := fun s e obs t =>
    e = .operation .resumeWatch ∧ obs = [] ∧ t = step s .operatorResumeWatch

/-- 限定した `/resume-watch` 遷移は、元の手動 hold 保持命題を満たす。 -/
theorem resumeModel_preserves_reportHold :
    Ensemble.Flow.ResumeWatchPreservesReportHold
      (Ensemble.AsIs.ConcreteTrace.projectedStep resumeModel) := by
  intro s t obs ⟨a, b, ha, hb, _, _, hstep⟩
  subst s
  subst t
  subst b
  exact resumeWatch_preserves_reportHold a

/-- worker の send で上限1に到達し、次の worker を保留して reconnect した状態。 -/
def turnLimitBlocked : System :=
  let dummy : Lease := ⟨0, "", .send, 0⟩
  let completed : SettlementInput :=
    { lease := dummy, workflow := .issue, status := .finished, failureClass := .transport }
  run { maxTurns := 1 } [
    .conductorEnqueue { id := 1, kind := .workerCompleted, name := "first" },
    .conductorBeginSend 1 0 none none true,
    .conductorSendResult completed,
    .conductorEnqueue { id := 2, kind := .workerCompleted, name := "second" },
    .conductorEnqueue { id := 3, kind := .reconnect },
    .conductorBeginReconnect 2,
    .conductorReconnectResult true false
  ]

/-- 通常入力を含まない解除操作と reconnect の探索用イベント集合。 -/
def limitedRecoveryAlphabet : List Event :=
  [ .conductorHold false,
    .conductorEnqueue { id := 10, kind := .reconnect },
    .conductorBeginReconnect 3,
    .conductorReconnectResult true false,
    .operatorHold false,
    .operatorResumeWatch,
    .operatorRecoveryContinue,
    .operatorRequestReconnect,
    .operatorBeginReconnect 3,
    .operatorReconnectResult true ]

/-- reconnect の可用性を調べる有限探索用の操作集合。 -/
def reconnectAlphabet : List Event :=
  [ .conductorEnqueue { id := 0, kind := .reconnect },
    .conductorBeginReconnect 1, .conductorReconnectResult true false, .conductorReconnectResult false false,
    .operatorRequestReconnect, .operatorBeginReconnect 1, .operatorReconnectResult true, .operatorReconnectResult false ]

/-- 指定された操作列で、受理された成功結果が availability を回復するか。 -/
def reconnectResultsRestore (events : List Event) : Bool := Id.run do
  let mut state : System := {}
  for event in events do
    let next := step state event
    match event with
    | .conductorReconnectResult true _ =>
      if state.conductorReconnect.isSome && state.conductorError.isNone &&
          !next.conductor.lifecycle.available then return false
    | .operatorReconnectResult true =>
      if state.operatorReconnect.isSome && !state.operator.stopped &&
          !next.operator.lifecycle.available then return false
    | _ => pure ()
    state := next
  return true

/-- 操作集合から、長さが指定値以下の列をすべて生成する。 -/
def tracesUpTo (alphabet : List Event) : Nat → List (List Event)
  | 0 => [[]]
  | n + 1 =>
    let shorter := tracesUpTo alphabet n
    shorter ++ (shorter.filter (fun trace => trace.length == n)).flatMap
      (fun trace => alphabet.map (fun event => trace ++ [event]))

/-- 会話・手動 hold と終了を含む resume-watch の固定探索操作。 -/
def resumeAlphabet : List Event :=
  [ .operatorInput { id := 1, user := true, bytes := 1 } true 100,
    .operatorReport { id := 2, user := false, session := "s", reportId := some "r" } 0 0 0,
    .operatorHold true, .operatorHold false, .operatorResumeWatch,
    .operatorInputEnd, .operatorRequestStop ]

/-- resume-watch の対象外となる具体状態が保たれるかを検査する。 -/
def resumePreservesConcrete (events : List Event) : Bool :=
  let before := run {} events
  let after := step before .operatorResumeWatch
  after.operator.queue.reportHold == before.operator.queue.reportHold &&
    after.operator.lifecycle == before.operator.lifecycle &&
    after.operator.pendingReconnects == before.operator.pendingReconnects &&
    after.operator.retryPending == before.operator.retryPending &&
    after.operator.retryStoredAt == before.operator.retryStoredAt &&
    after.operator.ack == before.operator.ack &&
    after.conductor.hold.active == before.conductor.hold.active

/- 初期状態・固定7操作・長さ3以下の400列で resume-watch の対象外状態を検査する。 -/
#guard ((tracesUpTo resumeAlphabet 3).length == 400)
#guard ((tracesUpTo resumeAlphabet 3).all resumePreservesConcrete)

/- 対象範囲で operator の物理 held report があるとき、会話か手動の hold が有効。 -/
#guard ((tracesUpTo resumeAlphabet 4).length == 2801)
#guard ((tracesUpTo resumeAlphabet 4).all fun trace =>
  let queue := (run {} trace).operator.queue
  queue.held.isEmpty || queue.conversationHold || queue.reportHold)

/- hold 中の worker を保留し、permission stall を send 開始する固定具体列。 -/
#guard (decide (
  let before := run {} [
    .conductorHold true,
    .conductorEnqueue { id := 3, kind := .workerCompleted, name := "w" },
    .conductorEnqueue { id := 4, kind := .stall }
  ]
  let after := step before (.conductorBeginSend 1 0 none none true)
  after.conductor.hold.active &&
    after.conductor.hold.held.any (fun event => event.id == 3) &&
    !(after.conductor.queue.any (fun event => event.id == 4)) &&
    after.conductorSend.isSome
))

/- 上限に達した後、指定した10種類の解除・reconnect 操作の長さ4以下では上限が残る。 -/
#guard ((tracesUpTo limitedRecoveryAlphabet 4).length == 11111)
#guard ((tracesUpTo limitedRecoveryAlphabet 4).all fun trace =>
  let s := run turnLimitBlocked trace
  s.autonomousTurns == 1 && s.conductor.queue.any (fun event => event.id == 2))

/- 8種類の操作からなる長さ4以下の全4681列で成功結果を検査する。 -/
#guard ((tracesUpTo reconnectAlphabet 4).length == 4681)
#guard ((tracesUpTo reconnectAlphabet 4).all reconnectResultsRestore)

/- operator の失敗後に再要求して成功すると availability が回復する。 -/
#guard (decide (
  let failed := run {} [.operatorRequestReconnect, .operatorBeginReconnect 1, .operatorReconnectResult false]
  let restored := run failed [.operatorRequestReconnect, .operatorBeginReconnect 2, .operatorReconnectResult true]
  !failed.operator.lifecycle.available && restored.operator.lifecycle.available
))

/- 手動 hold を保ったまま resume しても、監視報告は保留されたまま。 -/
#guard (decide (
  let s := run {} [
    .operatorInput { id := 0, user := true } true 100,
    .operatorReport { id := 1, user := false } 0 0 10,
    .operatorHold true,
    .operatorResumeWatch
  ]
  !s.operator.queue.conversationHold && s.operator.queue.reportHold &&
    s.operator.queue.held.length == 1 && !s.conductor.hold.active
))

/- operator の reconnect 成功は conductor の lifecycle を変更しない。 -/
#guard (decide (
  let s : System := { operator := { lifecycle := { available := false } }, conductor := { lifecycle := { available := false } } }
  let s := run s [.operatorRequestReconnect, .operatorBeginReconnect 1, .operatorReconnectResult true]
  s.operator.lifecycle.available && !s.conductor.lifecycle.available
))

/- conductor の reconnect 成功後、残った worker event を選択できる。 -/
#guard (decide (
  let initial : System := { conductor := { lifecycle := { available := false } } }
  let s := run initial [
    .conductorEnqueue { id := 1, kind := .workerCompleted, name := "worker" },
    .conductorEnqueue { id := 2, kind := .reconnect },
    .conductorBeginReconnect 1,
    .conductorReconnectResult true false
  ]
  let (_, selected) := Ensemble.AsIs.ConductorQueue.chooseDispatch s.conductor 0 0 0 none none true
  s.conductor.lifecycle.available && s.conductor.queue.length == 1 &&
    selected.map (fun dispatch => dispatch.batch.events.map (·.id)) == some [1]
))

/- 受理された通常 message は conductor queue に入り、send 開始で除去される。 -/
#guard (decide (
  let s := run {} [
    .operatorMessageDelivered 4 12,
    .conductorBeginSend 1 0 none none true
  ]
  s.conductor.queue.isEmpty && s.conductorSend.isSome &&
    s.conductor.lifecycle.activeLease == s.conductorSend
))

/- 未完了の入力後、reconnect は確認待ちを解除せず、continue で確認を解く。 -/
#guard (decide (
  let config : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 10, idleAging := 10, maxUserBytes := 100 }
  let dummy : Lease := ⟨0, "", .send, 0⟩
  let failure : SettlementInput :=
    { lease := dummy, workflow := .operatorAgent, status := .other,
      failureClass := .transport, captureFailure := false, agentAvailable := some false }
  let failed := run {} [
    .operatorInput { id := 0, user := true } true 100,
    .operatorBeginCommit 1 config 0 true false,
    .operatorCommitApply "" "" 0,
    .operatorCommitSuccess "" "",
    .operatorSendResult failure 0,
    .operatorRetryResult (fun _ => 0) true,
    .operatorRequestReconnect,
    .operatorBeginReconnect 2,
    .operatorReconnectResult true
  ]
  let resumed := step failed .operatorRecoveryContinue
  failed.operator.lifecycle.available && failed.operator.lifecycle.confirmationRequired &&
    failed.operator.queue.pending.isEmpty && resumed.operator.lifecycle.canDispatch
))

/- 未完了 send と retry 保存は別の操作で、report は保存完了後に再投入される。 -/
#guard (decide (
  let config : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let dummy : Lease := ⟨0, "", .send, 0⟩
  let failure : SettlementInput :=
    { lease := dummy, workflow := .operatorAgent, status := .other,
      failureClass := .transport, captureFailure := false }
  let failed := run {} [
    .operatorReport { id := 1, user := false, session := "session", reportId := some "report" } 0 0 0,
    .operatorBeginCommit 1 config 0 true false,
    .operatorCommitApply "batch" "payload" 0,
    .operatorCommitSuccess "batch" "payload",
    .operatorSendResult failure 0
  ]
  let retried := step failed (.operatorRetryResult (fun _ => 100) true)
  failed.operator.retryPending && failed.operator.queue.pending.isEmpty &&
    !retried.operator.retryPending && retried.operator.queue.pending.length == 1 &&
    retried.operator.queue.pending.head!.reportId == some "report" &&
    retried.operator.queue.pending.head!.id != 1
))

/-- report の send 中に到達する具体状態。 -/
def reportSending : System :=
  let config : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  run {} [
    .operatorReport { id := 1, user := false, session := "session", reportId := some "report" } 0 0 0,
    .operatorBeginCommit 1 config 0 true false,
    .operatorCommitApply "batch" "payload" 0,
    .operatorCommitSuccess "batch" "payload"
  ]

/-- report の send が未完了となり、retry 保存を待つ具体状態。 -/
def reportAwaitingRetry : System :=
  let dummy : Lease := ⟨0, "", .send, 0⟩
  let failure : SettlementInput :=
    { lease := dummy, workflow := .operatorAgent, status := .other,
      failureClass := .transport, captureFailure := false }
  step reportSending (.operatorSendResult failure 0)

/- retry 保存は停止契機がない限り停止できず、入力終了後は成功として処理しない。 -/
#guard (decide (
  !(step reportAwaitingRetry .operatorRetryStopped).operator.stopped &&
  (run reportAwaitingRetry [.operatorRequestStop, .operatorRetryStopped]).operator.stopped &&
  (run reportAwaitingRetry [.operatorInputEnd, .operatorRetryResult (fun _ => 0) true]).operator.retryPending
))

/- 停止は通常 return、timeout 以外の保存エラーは例外伝播として区別する。
   両方とも同じ runner の停止状態に至るが、出口の理由は異なる。 -/
#guard (decide (
  let stopped := run reportAwaitingRetry [.operatorInputEnd, .operatorRetryStopped]
  let exception := step reportAwaitingRetry .operatorRetryException
  stopped.operator == exception.operator &&
    stopped.operator.stopped &&
    stopped.operatorRetryExit == some .stopped &&
    exception.operatorRetryExit == some .exception
))

/- send 結果で lease が解放され、availability が false になる場合がある。 -/
#guard (decide (
  let dummy : Lease := ⟨0, "", .send, 0⟩
  let failure : SettlementInput :=
    { lease := dummy, workflow := .operatorAgent, status := .other,
      failureClass := .transport, captureFailure := false, agentAvailable := some false }
  let after := step reportSending (.operatorSendResult failure 0)
  reportSending.operator.lifecycle.activeLease.isSome &&
    reportSending.operator.lifecycle.available &&
    after.operator.lifecycle.activeLease.isNone &&
    !after.operator.lifecycle.available && after.operator.retryPending
))

/- send 待ち中断と retry 保存中の停止は、異なる lifecycle 状態を残す。 -/
#guard (decide (
  let interrupted := run reportSending [.operatorRequestStop, .operatorInterruptSend]
  let stopped := run reportAwaitingRetry [.operatorInputEnd, .operatorRetryStopped]
  reportSending.operatorSend.isSome && interrupted.operator.stopped &&
    interrupted.operator.lifecycle.activeLease.isSome &&
    reportAwaitingRetry.operator.retryPending &&
    reportAwaitingRetry.operator.lifecycle.activeLease.isNone &&
    stopped.operator.stopped && stopped.operator.lifecycle.activeLease.isNone &&
    stopped.operator.queue.pending.isEmpty
))

/- retry 保存の待機中にも user 入力を受け、再投入時の hold が変わる。 -/
#guard (decide (
  let withoutInput := step reportAwaitingRetry (.operatorRetryResult (fun _ => 100) true)
  let withInput := run reportAwaitingRetry [
    .operatorInput { id := 2, user := true } true 100,
    .operatorRetryResult (fun _ => 100) true
  ]
  withoutInput.operator.queue.pending.any (fun e => e.reportId == some "report") &&
    withInput.operator.queue.held.any (fun e => e.reportId == some "report") &&
    withInput.operator.queue.pending.any (fun e => e.user)
))

/- retry 保存待ちに user 入力を受けても、runner は新たな send を始めない。 -/
#guard (decide (
  let config : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let accepted := step reportAwaitingRetry (.operatorInput { id := 2, user := true } true 100)
  let attempted := run accepted [.operatorBeginCommit 2 config 0 true false, .operatorCommitApply "unused" "unused" 0, .operatorCommitSuccess "unused" "unused"]
  accepted.operator.retryPending && accepted.operator.lifecycle.canDispatch &&
    accepted.operator.queue.pending.any (fun e => e.user && e.id == 2) &&
    attempted.operatorSend.isNone && attempted.operator.retryPending &&
    attempted.operator.queue.pending.any (fun e => e.user && e.id == 2)
))

/- 受理した user 入力だけを送信し、未完了後に retry 保存が成功しても再投入しない。
   この一例は入力の一般的な非再送を証明せず、停止や再起動後も対象にしない。 -/
#guard (decide (
  let config : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let dummy : Lease := ⟨0, "", .send, 0⟩
  let failure : SettlementInput :=
    { lease := dummy, workflow := .operatorAgent, status := .other,
      failureClass := .transport, captureFailure := false }
  let sending := run {} [
    .operatorInput { id := 7, user := true } true 100,
    .operatorBeginCommit 1 config 0 true false,
    .operatorCommitApply "batch" "payload" 0,
    .operatorCommitSuccess "batch" "payload"
  ]
  let waiting := step sending (.operatorSendResult failure 0)
  let retried := step waiting (.operatorRetryResult (fun _ => 100) true)
  sending.operator.batch.any (fun e => e.user && e.id == 7) &&
    waiting.operator.retryPending && !retried.operator.retryPending &&
    !(retried.operator.queue.pending ++ retried.operator.queue.held).any
      (fun e => e.user && e.id == 7)
))

/- 未完了の user send 後、retry 保存待ちに別入力を受けて停止すると、
   確認待ちと保留入力が残る。停止後の回復操作は上の定理により効かない。 -/
#guard (decide (
  let config : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let dummy : Lease := ⟨0, "", .send, 0⟩
  let failure : SettlementInput :=
    { lease := dummy, workflow := .operatorAgent, status := .other,
      failureClass := .transport, captureFailure := false }
  let stopped := run {} [
    .operatorInput { id := 1, user := true } true 100,
    .operatorBeginCommit 1 config 0 true false,
    .operatorCommitApply "batch" "payload" 0,
    .operatorCommitSuccess "batch" "payload",
    .operatorSendResult failure 0,
    .operatorInput { id := 2, user := true } true 100,
    .operatorInputEnd,
    .operatorRetryStopped
  ]
  stopped.operator.stopped &&
    stopped.operator.lifecycle.pendingAttemptId.isSome &&
    stopped.operator.queue.pending.any (fun e => e.user && e.id == 2)
))

/- 自律ターン上限到達後は、reconnect 成功だけでは worker event を送れない。 -/
#guard (decide (
  let dummy : Lease := ⟨0, "", .send, 0⟩
  let completed : SettlementInput :=
    { lease := dummy, workflow := .issue, status := .finished, failureClass := .transport }
  let afterFirst := run { maxTurns := 1 } [
    .conductorEnqueue { id := 1, kind := .workerCompleted, name := "first" },
    .conductorBeginSend 1 0 none none true,
    .conductorSendResult completed
  ]
  let afterReconnect := run afterFirst [
    .conductorEnqueue { id := 2, kind := .workerCompleted, name := "second" },
    .conductorEnqueue { id := 3, kind := .reconnect },
    .conductorBeginReconnect 2,
    .conductorReconnectResult true false
  ]
  let blocked := step afterReconnect (.conductorBeginSend 3 0 none none true)
  let recovered := run blocked [
    .operatorMessageDelivered 4 1,
    .conductorBeginSend 4 0 none none true,
    .conductorSendResult completed
  ]
  let sent := step recovered (.conductorBeginSend 5 0 none none true)
  afterFirst.autonomousTurns == 1 && afterFirst.conductor.queue.isEmpty &&
    afterFirst.conductor.lifecycle.canDispatch &&
    afterReconnect.autonomousTurns == 1 &&
    afterReconnect.conductor.lifecycle.canDispatch &&
    blocked.conductorSend.isNone &&
    blocked.conductor.queue.map (·.id) == [2] &&
    recovered.autonomousTurns == 0 && recovered.conductor.queue.map (·.id) == [2] &&
    sent.conductorSend.isSome && sent.conductor.queue.isEmpty
))

/-- 上限以外の停止要因がなく、worker event 2 を保留する抽象観測。 -/
def workerObservation : Ensemble.Flow.State where
  lease := none
  available := true
  attention := false
  dispatchHold := false
  conversationHold := false
  reportHold := false
  held := fun _ => False
  pendingReconnects := 0
  retry := .none
  frozen := fun _ => False
  items := fun id => if id = 2 then some ⟨.worker, .pending⟩ else none
  lastAttempt := fun _ => none
  completed := fun _ => False
  now := 0

/-- 上限を持たない抽象状態では、保留 worker は eligible である。 -/
theorem workerObservation_eligible : Ensemble.Flow.Eligible workerObservation 2 := by
  refine ⟨.worker, ?_, ?_, ?_, ?_⟩
  · rfl
  · exact ⟨rfl, rfl, rfl, rfl⟩
  · exact Or.inr (Or.inr ⟨rfl, id⟩)
  · exact Or.inl (by decide)

/-- retry が存在しても、抽象仕様では user 入力の eligibility を妨げない。 -/
theorem user_eligible_during_retry :
    Ensemble.Flow.Eligible
      { workerObservation with
        items := fun id => if id = 2 then some ⟨.operatorInput, .pending⟩ else none
        retry := .send 5000 } 2 := by
  refine ⟨.operatorInput, ?_, ?_, ?_, ?_⟩
  · rfl
  · exact ⟨rfl, rfl, rfl, rfl⟩
  · exact Or.inl rfl
  · exact Or.inl (by decide)

/-- 通常入力は、仕様が回復列に許す操作には含まれない。 -/
theorem normalInput_not_recovery :
    ¬ Ensemble.Flow.RecoveryEvent (.operation (.input 4)) := by
  simp [Ensemble.Flow.RecoveryEvent]

end Ensemble.AsIs.Composition
