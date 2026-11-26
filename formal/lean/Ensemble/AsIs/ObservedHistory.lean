import Ensemble.AsIs.Composition
import Ensemble.AsIs.StoppedRecovery

/-! # 具体操作と観測履歴の接続（operator の初期部分）

TS の `run-operator-conversation.ts` と `operator-watch-dispatch.ts` に対応する。
具体 `System` を各段階で更新し、観測項目は論理 ID と report ID を別に保持する。
operator の report は空でない report ID を持つものに限定する。未対応の具体遷移、
conductor の複数項目 batch および全履歴の抽象状態への接続は含まない。
-/
namespace Ensemble.AsIs.ObservedHistory

open Ensemble.AsIs.Composition
open Ensemble.AsIs.ConductorDispatchLifecycle
open Ensemble.Flow

/-- 個々の観測と、その観測を生じた具体側の主体。 -/
inductive Actor where
  | conductor | operator
  deriving Repr, BEq, DecidableEq

/-- 同一 report の再投入時に queue の数値 ID が変わっても保持する論理項目。 -/
structure TrackedItem where
  actor : Actor
  logicalId : Nat
  concreteId : Nat
  kind : ItemKind
  reportId : Option String := none
  pending : Bool := true
  lastAttempt : Option Nat := none
  missingFromDispatch : Bool := false
  deriving BEq, DecidableEq

/-- 一つの抽象イベントと、同じ具体履歴から得た観測。 -/
structure Entry where
  actor : Actor
  event : Ensemble.Flow.Event
  observations : List Observation
  deriving DecidableEq

/-- 実際の batch 選択と send 開始は別の時点に記録する。ID は具体 queue の ID。 -/
inductive ConcreteMark where
  | selected (actor : Actor) (ids : List Nat)
  | dispatched (actor : Actor) (ids : List Nat) (attempt : Nat)
  deriving BEq, DecidableEq

/-- 具体状態と operator の論理項目、未完了 attempt、および観測履歴。 -/
structure History where
  concrete : System := {}
  items : List TrackedItem := []
  entries : List Entry := []
  delayedFailure : Option Nat := none
  completed : List (Actor × Nat) := []
  concreteMarks : List ConcreteMark := []
  operatorNow : Nat := 0
  supported : Bool := true

/-- 空の履歴から、入力または report を受け付ける。ID は履歴中で一意とする。 -/
def accept (h : History) (event : Ensemble.AsIs.OperatorDispatch.Event) (kind : ItemKind) : History :=
  if (kind != .operatorInput && kind != .watchReport) ||
      (kind == .watchReport && event.usableReportId.isNone) ||
      h.items.any (fun item => item.actor == .operator && item.logicalId == event.id) ||
      (h.concrete.operator.queue.pending ++ h.concrete.operator.queue.held).any (fun item => item.id == event.id) then h else
  let next := if kind == .operatorInput then
      step h.concrete (.operatorInput event true 1048576)
    else step h.concrete (.operatorReport event h.operatorNow 0 0)
  let accepted := (next.operator.queue.pending ++ next.operator.queue.held).any (fun item => item.id == event.id)
  if !accepted then { h with concrete := next } else
  let item : TrackedItem := ⟨.operator, event.id, event.id, kind, event.reportId, true, none, false⟩
  let abstractEvent := if kind == .operatorInput then Ensemble.Flow.Event.operation (.input event.id)
    else Ensemble.Flow.Event.arrival kind event.id
  { h with concrete := next, items := h.items ++ [item], entries := h.entries ++ [⟨.operator, abstractEvent, [.accepted event.id kind]⟩] }

/-- commit などの中間具体操作。抽象 dispatch は send 開始まで発行しない。 -/
def internal (h : History) (event : Ensemble.AsIs.Composition.Event) : History :=
  match event with
  | .operatorBeginCommit _ cfg now _ canInspect =>
    if now < h.operatorNow then { h with supported := false } else
    let next := step h.concrete event
    let s := h.concrete
    let maySelect := !s.operator.stopped && !s.operator.retryPending &&
      s.operator.pendingReconnects == 0 && s.operator.ack == .idle &&
      s.operatorPreparing.isNone && canInspect == s.operatorCanInspectRecovery
    let (_, selected) := s.operator.queue.selectBatch s.operator.selection cfg now
    match if maySelect then selected else none with
    | some batch =>
      { h with concrete := next, operatorNow := now, concreteMarks := h.concreteMarks ++ [.selected .operator (batch.events.map (·.id))] }
    | none => { h with concrete := next, operatorNow := now }
  | .operatorCommitApply _ _ now =>
    if now < h.operatorNow then { h with supported := false }
    else { h with concrete := step h.concrete event, operatorNow := now }
  | .operatorCommitStopped .. =>
    let next := step h.concrete event
    if next.operator.stopped && !h.concrete.operator.stopped then
      let committed := h.concrete.operatorCommitApplied == some true
      let ids := h.concrete.operatorPreparing.toList.flatMap fun batch =>
        batch.events.filterMap fun item => if item.user && committed then some item.id else none
      let items := h.items.map fun item =>
        if item.actor == .operator && ids.contains item.concreteId then { item with missingFromDispatch := true }
        else item
      { h with concrete := next, items, entries := h.entries ++ [⟨.operator, .tick 0, []⟩] }
    else { h with concrete := next }
  | .operatorInputEnd | .operatorRequestStop =>
    { h with concrete := step h.concrete event }
  | _ => { h with supported := false }

/-- 実際の send 開始を確認して batch の schedule と dispatch を記録する。 -/
def dispatch (h : History) (batchId payload : String) : History :=
  let next := step h.concrete (.operatorCommitSuccess batchId payload)
  match h.concrete.operatorSend, next.operatorSend, next.operator.batch with
  | none, some lease, event :: events =>
    let selected := (event :: events).filterMap fun e =>
      h.items.find? (fun item => item.actor == .operator && item.pending && item.concreteId == e.id)
    if selected.length != events.length + 1 then { h with concrete := next, supported := false } else
    match selected with
    | [] => { h with concrete := next }
    | item :: _ =>
      let items := h.items.map fun x => if x.actor == .operator && selected.any (fun y => y.logicalId == x.logicalId) then
        { x with pending := false, lastAttempt := some lease.id } else x
      let observations := selected.map fun selectedItem => Observation.dispatched selectedItem.logicalId lease.id
      { h with concrete := next, items, entries := h.entries ++ [⟨.operator, .schedule item.logicalId, observations⟩], concreteMarks := h.concreteMarks ++ [.dispatched .operator ((event :: events).map (·.id)) lease.id] }
  | _, _, _ => { h with concrete := next }

/-- send 完了を観測し、失敗は report の再投入または停止まで遅延する。 -/
def sendResult (h : History) (input : SettlementInput) : History :=
  let next := step h.concrete (.operatorSendResult input h.operatorNow)
  match h.concrete.operatorSend, next.operatorSend with
  | some lease, none =>
    if next.operator.retryPending then { h with concrete := next, delayedFailure := some lease.id }
    else if next.operator.ack != .idle then
      { h with concrete := next, completed := h.completed ++ [(.operator, lease.id)], entries := h.entries ++ [⟨.operator, .sendResult lease.id .completed, []⟩] }
    else { h with concrete := next, supported := false }
  | _, _ => { h with concrete := next }

/-- 保存成功後、元の report ID で論理項目を見つけ、同一項目の再投入を記録する。 -/
def retrySaved (h : History) : History :=
  let next := step h.concrete (.operatorRetryResult (fun _ => h.operatorNow) true)
  match h.delayedFailure with
  | none => { h with concrete := next }
  | some attempt =>
    if next.operator.retryPending || next.operator.stopped then { h with concrete := next } else
    let updates := h.items.filterMap fun item =>
      if item.actor != .operator || item.kind != .watchReport || item.lastAttempt != some attempt then none else
      (next.operator.queue.pending ++ next.operator.queue.held).find? (fun e => e.reportId.isSome && e.reportId == item.reportId) |>.map (fun event => (item.logicalId, event.id))
    let expected := h.items.filter fun item =>
      item.actor == .operator && item.kind == .watchReport && item.lastAttempt == some attempt
    let items := h.items.map fun item => match if item.actor == .operator then updates.find? (fun x => x.1 == item.logicalId) else none with
      | none => item
      | some (_, concreteId) => { item with concreteId, pending := true }
    { h with concrete := next, items, entries := h.entries ++ [⟨.operator, .sendResult attempt .failed, updates.map (fun x => .requeued x.1)⟩], delayedFailure := none, supported := h.supported && updates.length == expected.length }

/-- retry 保存待ちの停止後、遅延した失敗結果を再投入なしで記録する。 -/
def retryStopped (h : History) : History :=
  let next := step h.concrete .operatorRetryStopped
  match h.delayedFailure with
  | some attempt => if next.operator.stopped && !h.concrete.operator.stopped then
      { h with concrete := next, entries := h.entries ++ [⟨.operator, .sendResult attempt .failed, []⟩], delayedFailure := none }
    else { h with concrete := next }
  | none => { h with concrete := next }

/-- 保存の例外終了も未完了結果を記録するが、停止理由は具体状態に残す。 -/
def retryException (h : History) : History :=
  let next := step h.concrete .operatorRetryException
  match h.delayedFailure with
  | some attempt => if next.operator.stopped && !h.concrete.operator.stopped then
      { h with concrete := next, entries := h.entries ++ [⟨.operator, .sendResult attempt .failed, []⟩], delayedFailure := none }
    else { h with concrete := next }
  | none => { h with concrete := next }

/-- send 待機中断は結果を捏造せず、lease を保持した停止として記録する。 -/
def interruptSend (h : History) : History :=
  let next := step h.concrete .operatorInterruptSend
  if next.operator.stopped && !h.concrete.operator.stopped then
    { h with concrete := next, entries := h.entries ++ [⟨.operator, .tick h.operatorNow, []⟩] }
  else { h with concrete := next }

/-- reconnect 要求が具体側で受理された場合に操作を記録する。 -/
def operatorRequestReconnect (h : History) : History :=
  let next := step h.concrete .operatorRequestReconnect
  if next.operator.pendingReconnects > h.concrete.operator.pendingReconnects then
    { h with concrete := next, entries := h.entries ++ [⟨.operator, .operation .reconnect, []⟩] }
  else { h with concrete := next }

/-- lease 取得は内部遷移として記録する。#855 の tick は内部遷移も許す。 -/
def operatorBeginReconnect (h : History) (token : Nat) : History :=
  let next := step h.concrete (.operatorBeginReconnect token)
  if h.concrete.operatorReconnect.isNone && next.operatorReconnect.isSome then
    { h with concrete := next, entries := h.entries ++ [⟨.operator, .tick 0, []⟩] }
  else { h with concrete := next }

/-- 実際に lease が決済された場合だけ結果を記録する。 -/
def operatorReconnectResult (h : History) (success : Bool) : History :=
  let next := step h.concrete (.operatorReconnectResult success)
  if h.concrete.operatorReconnect.isSome && next.operatorReconnect.isNone then
    { h with concrete := next, entries := h.entries ++ [⟨.operator, .reconnectResult success, []⟩] }
  else { h with concrete := next }

/-- operator の解除操作は、停止・入力終了による受付拒否を区別して記録する。 -/
def operatorResumeWatch (h : History) : History :=
  let next := step h.concrete .operatorResumeWatch
  if h.concrete.operator.stopped || h.concrete.operatorInputEnded then
    { h with concrete := next }
  else
    { h with concrete := next, entries := h.entries ++ [⟨.operator, .operation .resumeWatch, []⟩] }

/-- operator の recovery continue を具体状態と履歴に反映する。 -/
def operatorRecoveryContinue (h : History) : History :=
  let next := step h.concrete .operatorRecoveryContinue
  if h.concrete.operator.stopped || h.concrete.operatorInputEnded then
    { h with concrete := next }
  else
    { h with concrete := next, entries := h.entries ++ [⟨.operator, .operation .recoveryContinue, []⟩] }

/-- operator の report hold 操作を主体別に記録する。 -/
def operatorReportHold (h : History) (enabled : Bool) : History :=
  let next := step h.concrete (.operatorHold enabled)
  if h.concrete.operator.stopped then { h with concrete := next }
  else
    { h with concrete := next, entries := h.entries ++ [⟨.operator, .operation (.setReportHold enabled), []⟩] }

/-- conductor の hold は operator と別の主体に記録する。 -/
def conductorDispatchHold (h : History) (enabled : Bool) : History :=
  let next := step h.concrete (.conductorHold enabled)
  { h with concrete := next, entries := h.entries ++ [⟨.conductor, .operation (.setDispatchHold enabled), []⟩] }

/-- 送信済み batch の ack 成否・待機・後処理。send の再実行は行わない。 -/
def operatorAckStep (h : History) (event : Ensemble.AsIs.Composition.Event) : History :=
  match event with
  | .operatorAckResult _ now | .operatorAdvanceAck now _ =>
    if now < h.operatorNow then { h with supported := false } else
    let next := step h.concrete event
    if next.operator.ack != h.concrete.operator.ack then
      { h with concrete := next, operatorNow := now, entries := h.entries ++ [⟨.operator, .tick now, []⟩] }
    else { h with concrete := next, operatorNow := now }
  | .operatorFinishAcknowledged =>
    let next := step h.concrete event
    if next.operator.ack != h.concrete.operator.ack then
      { h with concrete := next, entries := h.entries ++ [⟨.operator, .tick h.operatorNow, []⟩] }
    else { h with concrete := next }
  | _ => { h with supported := false }

/-- ack の対象とする各操作は dispatch の具体記録を追加しない。 -/
theorem operatorAckStep_preserves_dispatch_marks (h : History)
    (event : Ensemble.AsIs.Composition.Event) :
    (operatorAckStep h event).concreteMarks = h.concreteMarks := by
  cases event <;> simp [operatorAckStep] <;> split <;> (try split) <;> rfl

/-- conductor が worker 完了を受理し、その主体に属する項目として記録する。 -/
def conductorAcceptWorker (h : History) (event : Ensemble.AsIs.ConductorQueue.Event) : History :=
  if event.kind != .workerCompleted ||
      h.items.any (fun item => item.actor == .conductor && item.logicalId == event.id) ||
      h.concrete.conductor.queue.any (fun item => item.id == event.id) then h else
  let next := step h.concrete (.conductorEnqueue event)
  let item : TrackedItem := ⟨.conductor, event.id, event.id, .worker, none, true, none, false⟩
  { h with concrete := next, items := h.items ++ [item], entries := h.entries ++ [⟨.conductor, .arrival .worker event.id, [.accepted event.id .worker]⟩] }

/-- 単一 worker が queue から選ばれ lease を取得した場合だけ観測を記録する。 -/
def conductorDispatch (h : History) (token : Nat) : History :=
  let next := step h.concrete (.conductorBeginSend token 0 none none true)
  match h.concrete.conductorSend, next.conductorSend with
  | none, some lease =>
    let removed := h.items.filter fun item =>
      item.actor == .conductor && item.pending &&
        h.concrete.conductor.queue.any (fun e => e.id == item.concreteId) &&
        !(next.conductor.queue.any (fun e => e.id == item.concreteId)) &&
        !(next.conductor.hold.held.any (fun e => e.id == item.concreteId))
    match removed with
    | [item] =>
      let items := h.items.map fun x => if x.actor == .conductor && x.logicalId == item.logicalId then
        { x with pending := false, lastAttempt := some lease.id } else x
      { h with concrete := next, items, entries := h.entries ++ [⟨.conductor, .schedule item.logicalId, [.dispatched item.logicalId lease.id]⟩], concreteMarks := h.concreteMarks ++ [.selected .conductor [item.concreteId], .dispatched .conductor [item.concreteId] lease.id] }
    | _ => { h with concrete := next, supported := false }
  | _, _ => { h with concrete := next }

/-- conductor の成功結果を観測する。失敗や settlement 例外は未接続。 -/
def conductorCompleted (h : History) : History :=
  let input : SettlementInput :=
    { lease := ⟨0, "", .send, 0⟩, workflow := .issue, status := .completed, failureClass := .transport }
  let next := step h.concrete (.conductorSendResult input)
  match h.concrete.conductorSend, next.conductorSend with
  | some lease, none =>
    { h with concrete := next, completed := h.completed ++ [(.conductor, lease.id)], entries := h.entries ++ [⟨.conductor, .sendResult lease.id .completed, []⟩] }
  | _, _ => { h with concrete := next }

/-- 対象主体の具体 lifecycle と追跡履歴を #855 の状態へ写す試作。 -/
def observe (h : History) (actor : Actor) : State :=
  let lifecycle := if actor == .operator then h.concrete.operator.lifecycle else h.concrete.conductor.lifecycle
  let itemAt := fun id => h.items.find? (fun item => item.actor == actor && item.logicalId == id && !item.missingFromDispatch)
  { lease := lifecycle.activeLease.map (fun lease => if lease.kind == .send then .send lease.id else .reconnect)
    available := lifecycle.available
    attention := lifecycle.pendingAttemptId.isSome
    dispatchHold := if actor == .conductor then h.concrete.conductor.hold.active else false
    conversationHold := if actor == .operator then h.concrete.operator.queue.conversationHold else false
    reportHold := if actor == .operator then h.concrete.operator.queue.reportHold else false
    held := fun id => match itemAt id with
      | none => False
      | some item => if actor == .operator then
          h.concrete.operator.queue.held.any (fun event => event.id == item.concreteId) = true
        else h.concrete.conductor.hold.held.any (fun event => event.id == item.concreteId) = true
    pendingReconnects := if actor == .operator then h.concrete.operator.pendingReconnects else 0
    retry := if actor == .operator && h.concrete.operator.retryPending then .send (h.concrete.operator.retryStoredAt.getD 0)
      else if actor == .operator then match h.concrete.operator.ack with
        | .waiting _ _ readyAt => .ack readyAt
        | _ => .none
      else .none
    frozen := fun id => match itemAt id with
      | none => False
      | some item => actor == .operator ∧
          (h.concrete.operator.queue.pending ++ h.concrete.operator.queue.held).any
            (fun event => event.id == item.concreteId && event.frozenBatchId.isSome) = true
    items := fun id => (itemAt id).map fun item => ⟨item.kind, if item.pending then .pending else .dispatched⟩
    lastAttempt := fun id => (itemAt id).bind (·.lastAttempt)
    completed := fun attempt => (actor, attempt) ∈ h.completed
    now := if actor == .operator then h.operatorNow else 0 }

/-- 有効な成功結果を記録する履歴では、観測上の availability も回復する。 -/
theorem observed_operator_reconnect_success (h : History) (lease : Ensemble.AsIs.ConductorDispatchLifecycle.Lease)
    (running : h.concrete.operator.stopped = false)
    (pending : h.concrete.operatorReconnect = some lease)
    (matching : h.concrete.operator.lifecycle.matches lease .reconnect = true) :
    (observe (operatorReconnectResult h true) .operator).available = true := by
  have available := operator_reconnect_success_available h.concrete lease running pending matching
  have same : (operatorReconnectResult h true).concrete = step h.concrete (.operatorReconnectResult true) := by
    simp only [operatorReconnectResult]
    split <;> rfl
  change (operatorReconnectResult h true).concrete.operator.lifecycle.available = true
  rw [same]
  exact available

/-- 履歴上の resume-watch も、手動 report hold を変えない。 -/
theorem observed_resume_preserves_reportHold (h : History) :
    (observe (operatorResumeWatch h) .operator).reportHold =
      (observe h .operator).reportHold := by
  have same : (operatorResumeWatch h).concrete = step h.concrete .operatorResumeWatch := by
    simp only [operatorResumeWatch]
    split <;> rfl
  change (operatorResumeWatch h).concrete.operator.queue.reportHold = h.concrete.operator.queue.reportHold
  rw [same]
  exact resumeWatch_preserves_reportHold h.concrete

/- それぞれの hold を別主体の操作として保持し、resume-watch は report hold を維持する。 -/
#guard (decide (
  let h := operatorReportHold {} true
  let h := conductorDispatchHold h true
  let h := operatorResumeWatch h
  let h := conductorDispatchHold h false
  (observe h .operator).reportHold &&
    !(observe h .conductor).dispatchHold &&
    h.entries = [
      ⟨.operator, .operation (.setReportHold true), []⟩,
      ⟨.conductor, .operation (.setDispatchHold true), []⟩,
      ⟨.operator, .operation .resumeWatch, []⟩,
      ⟨.conductor, .operation (.setDispatchHold false), []⟩
    ]
))

/- 完了後の ack 失敗・待機・成功は send を繰り返さず、期限を観測する。 -/
#guard (decide (
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let input : SettlementInput :=
    { lease := ⟨0, "", .send, 0⟩, workflow := .operatorAgent,
      status := .completed, failureClass := .transport }
  let h := accept {} { id := 7, user := true, bytes := 1 } .operatorInput
  let h := internal h (.operatorBeginCommit 10 cfg 0 true false)
  let h := dispatch h "" ""
  let h := sendResult h input
  let waiting := operatorAckStep h (.operatorAckResult false 0)
  let retrying := operatorAckStep waiting (.operatorAdvanceAck 5000 false)
  let acknowledged := operatorAckStep retrying (.operatorAckResult true 5000)
  let done := operatorAckStep acknowledged .operatorFinishAcknowledged
  (observe waiting .operator).retry == .ack 5000 &&
    (observe retrying .operator).now == 5000 &&
    done.concrete.operator.ack == .idle &&
    done.concreteMarks == h.concreteMarks &&
    done.completed == h.completed
))

/- send 開始後の中断では、結果の有無と lease を区別する。 -/
#guard (decide (
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let h := accept {} { id := 7, user := true, bytes := 1 } .operatorInput
  let h := internal h (.operatorBeginCommit 10 cfg 0 true false)
  let h := dispatch h "" ""
  let h := internal h .operatorRequestStop
  let h := interruptSend h
  h.concrete.operator.stopped && h.concrete.operatorSend.isSome &&
    (observe h .operator).lease.isSome &&
    h.entries = [
      ⟨.operator, .operation (.input 7), [.accepted 7 .operatorInput]⟩,
      ⟨.operator, .schedule 7, [.dispatched 7 1]⟩,
      ⟨.operator, .tick 0, []⟩
    ]
))

/- 同じ ID を別主体で保持しても、conductor の観測は operator の項目を変更しない。 -/
#guard (decide (
  let h := accept {} { id := 7, user := true } .operatorInput
  let h := conductorAcceptWorker h { id := 7, kind := .workerCompleted, name := "worker" }
  let h := conductorDispatch h 10
  let h := conductorCompleted h
  h.items.any (fun item => item.actor == .operator && item.logicalId == 7 && item.pending) &&
  h.items.any (fun item => item.actor == .conductor && item.logicalId == 7 && !item.pending) &&
  h.entries = [
    ⟨.operator, .operation (.input 7), [.accepted 7 .operatorInput]⟩,
    ⟨.conductor, .arrival .worker 7, [.accepted 7 .worker]⟩,
    ⟨.conductor, .schedule 7, [.dispatched 7 1]⟩,
    ⟨.conductor, .sendResult 1 .completed, []⟩
  ]
))

/- 正常実行で #855 の項目状態・attempt・完了が受理、dispatch、結果に対応する。
   これはこの固定列の検査であり、全遷移の観測整合性ではない。 -/
#guard (decide (
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let input : SettlementInput :=
    { lease := ⟨0, "", .send, 0⟩, workflow := .operatorAgent,
      status := .completed, failureClass := .transport }
  let accepted := accept {} { id := 7, user := true } .operatorInput
  let ready := internal accepted (.operatorBeginCommit 10 cfg 0 true false)
  let sending := dispatch ready "" ""
  let completed := sendResult sending input
  ((observe accepted .operator).items 7).map (fun x => x.kind == .operatorInput && x.status == .pending) == some true &&
  ((observe sending .operator).items 7).map (fun x => x.kind == .operatorInput && x.status == .dispatched) == some true &&
  (observe sending .operator).lastAttempt 7 == some 1 &&
  completed.completed.contains (Actor.operator, 1) && completed.supported
))

/- 空履歴から user を受理し、具体的な lease と単一 batch から schedule と
   dispatch を記録して send 完了を観測する。 -/
#guard (decide (
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let input : SettlementInput :=
    { lease := ⟨0, "", .send, 0⟩, workflow := .operatorAgent,
      status := .completed, failureClass := .transport }
  let h := accept {} { id := 7, user := true } .operatorInput
  let h := internal h (.operatorBeginCommit 10 cfg 0 true false)
  let h := dispatch h "" ""
  let h := sendResult h input
  h.entries = [
    ⟨.operator, .operation (.input 7), [.accepted 7 .operatorInput]⟩,
    ⟨.operator, .schedule 7, [.dispatched 7 1]⟩,
    ⟨.operator, .sendResult 1 .completed, []⟩
  ] && h.concrete.operator.ack != .idle
))

/- report 再投入は新たな物理 ID を得るが論理 ID を保ち、未完了結果と
   同じ観測上の遷移に requeue を記録する。 -/
#guard (decide (
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let input : SettlementInput :=
    { lease := ⟨0, "", .send, 0⟩, workflow := .operatorAgent,
      status := .other, failureClass := .transport }
  let h := accept {} { id := 7, user := false, session := "s", reportId := some "r" } .watchReport
  let h := internal h (.operatorBeginCommit 10 cfg 0 true false)
  let h := internal h (.operatorCommitApply "batch" "payload" 0)
  let h := dispatch h "batch" "payload"
  let h := sendResult h input
  let h := retrySaved h
  h.entries = [
    ⟨.operator, .arrival .watchReport 7, [.accepted 7 .watchReport]⟩,
    ⟨.operator, .schedule 7, [.dispatched 7 1]⟩,
    ⟨.operator, .sendResult 1 .failed, [.requeued 7]⟩
  ] && h.items.any (fun item => item.logicalId == 7 && item.pending && item.concreteId != 7)
))

/- retry 保存待ちで入力終了すると、同じ失敗 attempt を requeue なしで
   記録し、後から受理した入力は保留状態を保つ。 -/
#guard (decide (
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let input : SettlementInput :=
    { lease := ⟨0, "", .send, 0⟩, workflow := .operatorAgent,
      status := .other, failureClass := .transport }
  let h := accept {} { id := 7, user := true } .operatorInput
  let h := internal h (.operatorBeginCommit 10 cfg 0 true false)
  let h := dispatch h "" ""
  let h := sendResult h input
  let h := accept h { id := 8, user := true } .operatorInput
  let h := internal h .operatorInputEnd
  let h := retryStopped h
  h.entries = [
    ⟨.operator, .operation (.input 7), [.accepted 7 .operatorInput]⟩,
    ⟨.operator, .schedule 7, [.dispatched 7 1]⟩,
    ⟨.operator, .operation (.input 8), [.accepted 8 .operatorInput]⟩,
    ⟨.operator, .sendResult 1 .failed, []⟩
  ] && h.concrete.operator.stopped && h.items.any (fun item => item.logicalId == 8 && item.pending)
))

/-- report 失敗後に入力終了して停止した、初期状態からの具体履歴。 -/
def stoppedReportHistory : History :=
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let input : SettlementInput :=
    { lease := ⟨0, "", .send, 0⟩, workflow := .operatorAgent,
      status := .other, failureClass := .transport }
  let h := accept {} { id := 7, user := false, session := "s", reportId := some "r" } .watchReport
  let h := internal h (.operatorBeginCommit 10 cfg 0 true false)
  let h := internal h (.operatorCommitApply "batch" "payload" 0)
  let h := dispatch h "batch" "payload"
  let h := sendResult h input
  let h := accept h { id := 8, user := true } .operatorInput
  let h := internal h .operatorInputEnd
  retryStopped h

deriving instance DecidableEq for Item

/- 空の具体状態から要求・lease 取得・成功決済までの限定列。 -/
#guard (decide (
  let h := operatorRequestReconnect {}
  let h := operatorBeginReconnect h 3
  let h := operatorReconnectResult h true
  h.entries = [
    ⟨.operator, .operation .reconnect, []⟩,
    ⟨.operator, .tick 0, []⟩,
    ⟨.operator, .reconnectResult true, []⟩
  ] && h.concrete.operator.lifecycle.available &&
    h.concrete.operatorReconnect.isNone
))

/- 選択と send は同時ではない。停止要求で選択済み batch が send に至らない列。 -/
#guard (decide (
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let h := accept {} { id := 7, user := true } .operatorInput
  let selected := internal h (.operatorBeginCommit 10 cfg 0 true false)
  let requested := internal selected .operatorRequestStop
  let after := dispatch requested "" ""
  selected.concrete.operatorPreparing.isSome &&
    selected.concrete.operatorSend.isNone &&
    after.concrete.operatorSend.isNone &&
    after.concreteMarks = [.selected .operator [7]] &&
    after.entries = h.entries
))

/- user batch は send 開始前の commit で queue から外れ、停止後は失われた
   項目として履歴に残る。明示破棄を観測したことにはしない。 -/
#guard (decide (
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let h := accept {} { id := 7, user := true } .operatorInput
  let h := internal h (.operatorBeginCommit 10 cfg 0 true false)
  let h := internal h .operatorRequestStop
  let h := internal h (.operatorCommitStopped "" "" true)
  h.items.any (fun item => item.logicalId == 7 && item.missingFromDispatch) &&
    ((observe h .operator).items 7).isNone &&
    !(h.concrete.operator.queue.pending.any (fun item => item.id == 7)) &&
    h.concrete.operatorSend.isNone && h.concrete.operator.stopped &&
    h.concrete.operatorPreparing.isNone
))

/-- 停止済み runner の後続入力を暫定観測が eligible と判定する。 -/
theorem stopped_report_observed_eligible :
    stoppedReportHistory.concrete.operator.stopped = true ∧
      Eligible (observe stoppedReportHistory .operator) 8 := by
  constructor
  · decide +kernel
  · refine ⟨.operatorInput, ?_, ?_, Or.inl rfl, Or.inl (by decide)⟩
    · unfold Pending
      decide +kernel
    · constructor <;> first | decide +kernel | constructor
      all_goals decide +kernel

/-- 停止した同じ runner では、どの指定値でも新しい commit は開始できない。 -/
theorem stopped_report_no_commit (token now : Nat) (cfg : Ensemble.AsIs.OperatorDispatch.Scheduling)
    (reservationOk canInspect : Bool) :
    step stoppedReportHistory.concrete (.operatorBeginCommit token cfg now reservationOk canInspect) =
      stoppedReportHistory.concrete := by
  simp [step, stopped_report_observed_eligible.1]

/-- 具体 runner の dispatch に必要な条件。availability とは別に停止を保持する。
    これは十分条件ではなく、batch 選択や予約の成功は含まない。 -/
def operatorDispatchReady (s : System) : Prop :=
  s.operator.stopped = false ∧ s.operator.lifecycle.available = true ∧
    s.operator.retryPending = false ∧ s.operator.pendingReconnects = 0 ∧
    s.operator.ack = .idle ∧ s.operatorPreparing = none

/-- 指定された回復操作の任意の有限列では、停止済み runner は必要条件を満たさない。
    対象操作は StoppedRecovery.Action に限り、再起動は含まない。 -/
theorem stopped_report_not_ready_after_recovery
    (events : List Ensemble.AsIs.StoppedRecovery.Action) :
    ¬ operatorDispatchReady
      (Ensemble.AsIs.StoppedRecovery.runActions stoppedReportHistory.concrete events) := by
  intro ready
  have same := Ensemble.AsIs.StoppedRecovery.actions_preserve_stopped_operator
    stoppedReportHistory.concrete stopped_report_observed_eligible.1 events
  have stopped :
      (Ensemble.AsIs.StoppedRecovery.runActions stoppedReportHistory.concrete events).operator.stopped = true := by
    rw [same]
    exact stopped_report_observed_eligible.1
  have running := ready.1
  rw [stopped] at running
  contradiction

/-- 同じ具体操作列の後も、新しい commit は開始できない。 -/
theorem stopped_report_no_commit_after_recovery
    (events : List Ensemble.AsIs.StoppedRecovery.Action)
    (token now : Nat) (cfg : Ensemble.AsIs.OperatorDispatch.Scheduling)
    (reservationOk canInspect : Bool) :
    let s := Ensemble.AsIs.StoppedRecovery.runActions stoppedReportHistory.concrete events
    step s (.operatorBeginCommit token cfg now reservationOk canInspect) = s := by
  have same := Ensemble.AsIs.StoppedRecovery.actions_preserve_stopped_operator
    stoppedReportHistory.concrete stopped_report_observed_eligible.1 events
  have stopped :
      (Ensemble.AsIs.StoppedRecovery.runActions stoppedReportHistory.concrete events).operator.stopped = true := by
    rw [same]
    exact stopped_report_observed_eligible.1
  simp [step, stopped]

end Ensemble.AsIs.ObservedHistory
