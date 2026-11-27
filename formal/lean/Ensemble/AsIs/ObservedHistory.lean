import Ensemble.AsIs.Composition
import Ensemble.AsIs.StoppedRecovery

/-! # 具体操作と観測履歴の接続（operator の初期部分）

TS の `run-operator-conversation.ts` と `operator-watch-dispatch.ts` に対応する。
具体 `System` を各段階で更新し、観測項目は論理 ID と report ID を別に保持する。
operator の report は空でない report ID を持つものに限定する。未対応の具体遷移、
conductor の未追跡項目を含む batch および全履歴の抽象状態への接続は含まない。
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
      s.operatorPreparing.isNone && s.operator.lifecycle.canDispatch &&
      canInspect == s.operatorCanInspectRecovery
    let (_, selected) := s.operator.queue.selectBatch s.operator.selection cfg now
    match if maySelect then selected else none with
    | some batch =>
      { h with concrete := next, operatorNow := now, concreteMarks := h.concreteMarks ++ [.selected .operator (batch.events.map (·.id))] }
    | none => { h with concrete := next, operatorNow := now }
  | .operatorCommitApply _ _ now =>
    if now < h.operatorNow then { h with supported := false }
    else { h with concrete := step h.concrete event, operatorNow := now }
  | .operatorRefreshReport persisted _persistedReadyAt =>
    let present := (h.concrete.operator.queue.pending ++ h.concrete.operator.queue.held).any
      (fun queued => !queued.user && persisted.usableReportId.isSome &&
        queued.usableReportId == persisted.usableReportId)
    let next := step h.concrete event
    if !present then { h with concrete := next, supported := false }
    else { h with concrete := next, entries := h.entries ++
      [⟨.operator, .tick h.operatorNow, []⟩] }
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
  | .operatorWaitStopped =>
    let next := step h.concrete event
    if next.operator.stopped && !h.concrete.operator.stopped then
      { h with concrete := next, entries := h.entries ++
        [⟨.operator, .tick h.operatorNow, []⟩] }
    else { h with concrete := next, supported := false }
  | .operatorFinishInput =>
    let next := step h.concrete event
    if next.operator.stopped && !h.concrete.operator.stopped then
      { h with concrete := next, entries := h.entries ++ [⟨.operator, .tick h.operatorNow, []⟩] }
    else { h with concrete := next }
  | _ => { h with concrete := step h.concrete event, supported := false }

/- 入力終了後の loop return を履歴に残す。pending user がある間は return しない。 -/
#guard (decide (
  let ended := internal {} .operatorInputEnd
  let finished := internal ended .operatorFinishInput
  let pending := accept {} { id := 7, user := true } .operatorInput
  let pending := internal pending .operatorInputEnd
  let waiting := internal pending .operatorFinishInput
  finished.supported && finished.concrete.operator.stopped &&
    finished.entries = [⟨.operator, .tick 0, []⟩] &&
    waiting.supported && !waiting.concrete.operator.stopped &&
    waiting.entries = pending.entries
))

/- 未対応の観測は明示しつつ、具体遷移自体は履歴から落とさない。 -/
#guard (decide (
  let h := internal {} (.operatorHold true)
  !h.supported && h.concrete.operator.queue.reportHold && h.entries.isEmpty
))

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

/-- 保存成功後、再投入時計を別入力として受け、同一 report の再投入を記録する。 -/
def retrySavedWithReadTime (h : History) (readTime : Nat → Nat) : History :=
  let next := step h.concrete (.operatorRetryResult readTime true)
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

/-- 時計を揃える既定 fixture。TS の保存時刻と再投入時刻が一致するとは主張しない。 -/
def retrySaved (h : History) : History :=
  retrySavedWithReadTime h (fun _ => h.operatorNow)

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

/-- permission stall を conductor の独立した受理項目として記録する。 -/
def conductorAcceptStall (h : History) (event : Ensemble.AsIs.ConductorQueue.Event) : History :=
  if event.kind != .stall ||
      h.items.any (fun item => item.actor == .conductor && item.logicalId == event.id) ||
      h.concrete.conductor.queue.any (fun item => item.id == event.id) then h else
  let next := step h.concrete (.conductorEnqueue event)
  let item : TrackedItem := ⟨.conductor, event.id, event.id, .permissionStall, none, true, none, false⟩
  { h with concrete := next, items := h.items ++ [item], entries := h.entries ++
    [⟨.conductor, .arrival .permissionStall event.id, [.accepted event.id .permissionStall]⟩] }

/-- conductor が追跡済み項目を batch として dispatch した場合に観測を記録する。 -/
def conductorDispatch (h : History) (token : Nat) : History :=
  let next := step h.concrete (.conductorBeginSend token 0 none none true)
  match h.concrete.conductorSend, next.conductorSend with
  | none, some lease =>
    let removed := h.items.filter fun item =>
      item.actor == .conductor && item.pending &&
        (h.concrete.conductor.queue.any (fun e => e.id == item.concreteId) ||
          h.concrete.conductor.hold.held.any (fun e => e.id == item.concreteId)) &&
        !(next.conductor.queue.any (fun e => e.id == item.concreteId)) &&
        !(next.conductor.hold.held.any (fun e => e.id == item.concreteId))
    let removedConcrete := (h.concrete.conductor.queue ++ h.concrete.conductor.hold.held).filter fun e =>
      !(next.conductor.queue.any (fun x => x.id == e.id)) &&
        !(next.conductor.hold.held.any (fun x => x.id == e.id))
    if removed.length != removedConcrete.length then { h with concrete := next, supported := false } else
    match removed with
    | item :: _ =>
      let items := h.items.map fun x => if x.actor == .conductor &&
          removed.any (fun item => item.logicalId == x.logicalId) then
        { x with pending := false, lastAttempt := some lease.id } else x
      let ids := removed.map (·.concreteId)
      let observations := removed.map fun item => Observation.dispatched item.logicalId lease.id
      { h with concrete := next, items, entries := h.entries ++ [⟨.conductor, .schedule item.logicalId, observations⟩], concreteMarks := h.concreteMarks ++ [.selected .conductor ids, .dispatched .conductor ids lease.id] }
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

/-- `held` を conductor の dispatch hold に対応させる別の試作観測。
    operator の会話 hold と手動 hold は独立した field に残し、物理 queue の所在は
    具体履歴で保持する。全遷移での忠実性はまだ示していない。 -/
def observeDispatchHeld (h : History) (actor : Actor) : State :=
  { observe h actor with
    held := fun id => if actor == .operator then False else (observe h actor).held id }

/-- この観測では operator の会話・手動 hold を元の具体状態から読む。 -/
theorem dispatchHeld_operator_holds (h : History) :
    (observeDispatchHeld h .operator).conversationHold = h.concrete.operator.queue.conversationHold ∧
    (observeDispatchHeld h .operator).reportHold = h.concrete.operator.queue.reportHold := by
  exact ⟨rfl, rfl⟩

/-- operator の物理 queue 移動は、conductor の dispatch-held 観測を変えない。 -/
theorem dispatchHeld_resume_operator_held (h : History) :
    (observeDispatchHeld (operatorResumeWatch h) .operator).held =
      (observeDispatchHeld h .operator).held := by
  rfl

/-- operator の physical held queue は、この観測の抽象 `held` に入れない。 -/
theorem dispatchHeld_operator_held_false (h : History) (id : EventId) :
    (observeDispatchHeld h .operator).held id = False := by
  rfl

/-- hold・入力終了を含む固定 prefix を、同じ具体履歴に適用する。 -/
def releasePrefix (events : List Ensemble.AsIs.Composition.Event) : History :=
  events.foldl (fun h event => match event with
    | .operatorInput input _ _ => accept h input .operatorInput
    | .operatorReport report _ _ _ => accept h report .watchReport
    | .operatorHold enabled => operatorReportHold h enabled
    | .operatorResumeWatch => operatorResumeWatch h
    | .operatorRecoveryContinue => operatorRecoveryContinue h
    | .operatorRequestReconnect => operatorRequestReconnect h
    | other => internal h other) {}

/-- #855 ReleaseIndependent の各 operator 操作に対応する具体履歴。 -/
def releaseOperation (h : History) (op : Ensemble.Flow.Operation) : History :=
  match op with
  | .resumeWatch => operatorResumeWatch h
  | .recoveryContinue => operatorRecoveryContinue h
  | .reconnect => operatorRequestReconnect h
  | .setDispatchHold false => conductorDispatchHold h false
  | .setReportHold false => operatorReportHold h false
  | _ => h

/-- 観測対象 item の report frozen 状態を concrete queue から bool で読む。 -/
def concreteReportFrozen (h : History) (id : Nat) : Bool :=
  match h.items.find? (fun item => item.actor == .operator && item.logicalId == id) with
  | none => false
  | some item =>
      (h.concrete.operator.queue.pending ++ h.concrete.operator.queue.held).any
        (fun event => event.id == item.concreteId && event.frozenBatchId.isSome)

/-- 限定履歴上で ReleaseIndependent が保護する抽象 field を比較する。 -/
def releaseFieldsPreserved (h : History) (op : Ensemble.Flow.Operation) : Bool := Id.run do
  let before := observeDispatchHeld h .operator
  let nextHistory := releaseOperation h op
  let after := observeDispatchHeld nextHistory .operator
  let ids := h.items.map (·.logicalId)
  let retained := ids.all fun id =>
    decide (before.items id = after.items id) &&
    (concreteReportFrozen h id == concreteReportFrozen nextHistory id)
  let shared := decide (before.retry = after.retry) && retained
  if !shared then return false
  match op with
  | .resumeWatch =>
      before.lease == after.lease &&
        before.pendingReconnects == after.pendingReconnects &&
        before.reportHold == after.reportHold &&
        before.dispatchHold == after.dispatchHold &&
        before.available == after.available &&
        before.attention == after.attention
  | .recoveryContinue =>
      before.lease == after.lease &&
        before.pendingReconnects == after.pendingReconnects &&
        before.reportHold == after.reportHold &&
        before.conversationHold == after.conversationHold &&
        before.dispatchHold == after.dispatchHold &&
        before.available == after.available
  | .reconnect =>
      before.reportHold == after.reportHold &&
        before.conversationHold == after.conversationHold &&
        before.dispatchHold == after.dispatchHold &&
        before.attention == after.attention
  | .setDispatchHold false =>
      before.reportHold == after.reportHold &&
        before.conversationHold == after.conversationHold &&
        before.available == after.available &&
        before.attention == after.attention
  | .setReportHold false =>
      before.conversationHold == after.conversationHold &&
        before.dispatchHold == after.dispatchHold &&
        before.available == after.available &&
        before.attention == after.attention
  | _ => true

/-- 固定探索で対象にする解除操作。 -/
def releaseOperations : List Ensemble.Flow.Operation :=
  [.resumeWatch, .recoveryContinue, .reconnect, .setReportHold false]

/- 初期状態・固定7操作の長さ4以下2801 prefix それぞれで、operator 側の4種類を検査する。
   operator item の held は候補観測で隠しているため、物理的な held の検査ではない。 -/
#guard ((tracesUpTo resumeAlphabet 4).length == 2801)
#guard ((tracesUpTo resumeAlphabet 4).all fun events =>
  (releaseOperations.all fun op => releaseFieldsPreserved (releasePrefix events) op))

/-- dispatch hold で実際に held へ移した conductor worker の具体履歴。 -/
def heldConductorReleaseHistory : History :=
  conductorDispatch
    (conductorDispatchHold
      (conductorAcceptWorker {} { id := 31, kind := .workerCompleted, name := "held" })
      true)
    1

/-- conductor の hold 解除後、held worker は次の選択まで buffer に残る。 -/
def conductorReleaseFieldsPreserved : Bool := Id.run do
  let h := heldConductorReleaseHistory
  let released := releaseOperation h (.setDispatchHold false)
  let sent := conductorDispatch released 2
  let heldBefore := h.concrete.conductor.hold.held.any (fun event => event.id == 31)
  let heldAfterRelease := released.concrete.conductor.hold.held.any (fun event => event.id == 31)
  let heldAfterSend := sent.concrete.conductor.hold.held.any (fun event => event.id == 31)
  return heldBefore &&
    h.concrete.conductor.hold.active && !released.concrete.conductor.hold.active &&
    heldAfterRelease && !heldAfterSend &&
    released.concrete.conductor.lifecycle == h.concrete.conductor.lifecycle &&
    released.concrete.conductor.batchState == h.concrete.conductor.batchState &&
    released.concrete.conductorSend == h.concrete.conductorSend &&
    released.concrete.conductorReconnect == h.concrete.conductorReconnect &&
    released.concrete.operator == h.concrete.operator &&
    released.concrete.autonomousTurns == h.concrete.autonomousTurns &&
    released.concrete.maxTurns == h.concrete.maxTurns &&
    sent.concrete.conductorSend.isSome &&
    sent.concreteMarks.any (fun mark => mark == .dispatched .conductor [31] 1)

#guard (conductorReleaseFieldsPreserved)

/- 会話 hold だけで保留された report は resume-watch で held から戻る。
   これは本ファイルの暫定観測であり、抽象 held の唯一の解釈を主張しない。 -/
/-- user 入力後の report は会話 hold に入る。 -/
def resumeHeldExample : History :=
  let h := accept {} { id := 1, user := true, bytes := 1 } .operatorInput
  accept h { id := 2, user := false, session := "s", reportId := some "r" } .watchReport

/- 同じ具体履歴で report の所在が held から pending に移る。 -/
#guard (decide (
  let h := resumeHeldExample
  let next := operatorResumeWatch h
  h.concrete.operator.queue.held.any (fun event => event.id == 2) &&
    !(next.concrete.operator.queue.held.any (fun event => event.id == 2)) &&
    next.concrete.operator.queue.pending.any (fun event => event.id == 2) &&
    next.concrete.operator.queue.reportHold == h.concrete.operator.queue.reportHold
))

/- hold 中の stall は held に移らず、具体 dispatch と受理観測を保つ。 -/
#guard (decide (
  let h := conductorDispatchHold {} true
  let h := conductorAcceptStall h { id := 4, kind := .stall }
  let sent := conductorDispatch h 1
  sent.supported && sent.concrete.conductor.hold.active &&
    sent.concreteMarks.any (fun mark => mark == .dispatched .conductor [4] 1) &&
    sent.entries.any (fun entry => entry.actor == .conductor &&
      entry.observations.contains (.accepted 4 .permissionStall)) &&
    sent.entries.any (fun entry => entry.actor == .conductor &&
      entry.observations.contains (.dispatched 4 1))
))

/- 同じ worker の複数項目を一束で dispatch し、各項目を同じ attempt に記録する。 -/
#guard (decide (
  let h := conductorAcceptWorker {} { id := 1, kind := .workerCompleted, name := "w" }
  let h := conductorAcceptWorker h { id := 2, kind := .workerCompleted, name := "w" }
  let sent := conductorDispatch h 1
  sent.supported &&
    h.items.all (fun item => item.pending) &&
    sent.items.all (fun item => !item.pending && item.lastAttempt == some 1) &&
    sent.concreteMarks.any (fun mark => mark == .dispatched .conductor [1, 2] 1) &&
    sent.entries.any (fun entry =>
      entry.observations.contains (.dispatched 1 1) &&
        entry.observations.contains (.dispatched 2 1))
))

/- 手動 hold も有効なら会話 hold の解除後も report は held に残る。 -/
#guard (decide (
  let h := operatorReportHold resumeHeldExample true
  let next := operatorResumeWatch h
  !next.concrete.operator.queue.conversationHold &&
    next.concrete.operator.queue.reportHold &&
    next.concrete.operator.queue.held.any (fun event => event.id == 2) &&
    !(next.concrete.operator.queue.pending.any (fun event => event.id == 2))
))

/- conductor の worker は hold 中に held に移り、解除後の dispatch で観測される。 -/
#guard (decide (
  let h := conductorAcceptWorker {} { id := 3, kind := .workerCompleted, name := "w" }
  let h := conductorDispatchHold h true
  let held := conductorDispatch h 1
  let released := conductorDispatchHold held false
  let sent := conductorDispatch released 2
  held.concrete.conductor.hold.held.any (fun event => event.id == 3) &&
    held.items.any (fun item => item.actor == .conductor && item.logicalId == 3 && item.pending) &&
    !(released.concrete.conductor.hold.active) &&
    released.concrete.conductor.hold.held.any (fun event => event.id == 3) &&
    !(sent.concrete.conductor.hold.held.any (fun event => event.id == 3)) &&
    sent.concrete.conductorSend.isSome && sent.supported &&
    sent.items.any (fun item => item.actor == .conductor && item.logicalId == 3 && !item.pending) &&
    sent.concreteMarks.any (fun mark => mark == .dispatched .conductor [3] 1)
))

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

/-- dispatch-held 観測でも resume-watch は手動 report hold を保持する。 -/
theorem dispatchHeld_resume_preserves_reportHold (h : History) :
    (observeDispatchHeld (operatorResumeWatch h) .operator).reportHold =
      (observeDispatchHeld h .operator).reportHold :=
  observed_resume_preserves_reportHold h

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

/-- 通常入力を送信して、指定した未完了結果を受けた固定の具体履歴。 -/
def failedInputHistoryFor
    (id : Nat) (status : SendStatus) (failureClass : FailureClass)
    (agentAvailable : Option Bool) : History :=
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let failure : SettlementInput :=
    { lease := ⟨0, "", .send, 0⟩, workflow := .operatorAgent,
      status, failureClass, agentAvailable }
  let h := accept {} { id, user := true, bytes := 1 } .operatorInput
  let h := internal h (.operatorBeginCommit 10 cfg 0 true false)
  let h := dispatch h "" ""
  sendResult h failure

/-- 既存の代表的な transport 失敗履歴。 -/
def failedInputHistory : History := failedInputHistoryFor 7 .other .transport none

/-- 未完了 input の再送抑止を調べる有限探索用の具体操作。 -/
inductive InputReplayAction where
  | nextInput | saveRetry | continueRecovery | select | dispatch
  deriving BEq, DecidableEq

/-- 固定操作を同じ具体履歴へ適用する。新しい入力には異なる abstract ID を使う。 -/
def inputReplayStepFor (id : Nat) (h : History) : InputReplayAction → History
  | .nextInput => accept h { id := id + 1, user := true, bytes := 1 } .operatorInput
  | .saveRetry => retrySaved h
  | .continueRecovery => operatorRecoveryContinue h
  | .select => internal h (.operatorBeginCommit 11
      { maxWait := 0, idleAging := 10, maxUserBytes := 100 } 0 true false)
  | .dispatch => dispatch h "" ""

/-- 固定5操作から指定長以下の列を列挙する。 -/
def inputReplayTraces : Nat → List (List InputReplayAction)
  | 0 => [[]]
  | n + 1 =>
    let shorter := inputReplayTraces n
    shorter ++ (shorter.filter (fun trace => trace.length == n)).flatMap
      (fun trace => [.nextInput, .saveRetry, .continueRecovery, .select, .dispatch].map
        (fun event => trace ++ [event]))

/- 固定探索する結果値。`.other` は operator runner で再送されない失敗結果をまとめた値、
   `.running` は未完了の status を表す。failure class と status の積はモデル上の入力域であり、
   すべての組合せが TS runtime で観測されたと主張しない。 -/
def inputReplayOutcomes : List (SendStatus × FailureClass × Option Bool) :=
  [(.other, .auth, none), (.other, .transport, none),
    (.other, .providerError, none), (.other, .cancelled, none),
    (.other, .sendRejected, some false), (.running, .incompleteStatus, none)]

/-- 固定失敗後の操作列で、最初の入力 ID の dispatch は一回だけか。 -/
def noRepeatedInputDispatchFor
    (id : Nat) (status : SendStatus) (failureClass : FailureClass)
    (agentAvailable : Option Bool)
    (events : List InputReplayAction) : Bool :=
  let initial := failedInputHistoryFor id status failureClass agentAvailable
  let h := events.foldl (inputReplayStepFor id) initial
  (h.concreteMarks.filter fun mark => match mark with
    | .dispatched .operator ids _ => ids.contains id
    | _ => false).length == 1

/- 入力 ID 7 / 8、6種類の未完了結果 profile、固定5操作の長さ4以下781列を検査する。
   新規 ID id+1 の入力・retry 保存・recovery continue・選択・send 開始を含む。
   failureClass は auth / transport / providerError / cancelled / sendRejected / incompleteStatus。
   `sendRejected` だけ `agentAvailable=false` とし、他は省略して既存状態を保つ。
   これは #855 の広い履歴量化や TS の runtime 到達性を証明するものではない。 -/
#guard (failedInputHistory.delayedFailure.isSome)
#guard ((inputReplayTraces 4).length == 781)
#guard ([7, 8].all fun id =>
  inputReplayOutcomes.all fun (status, failureClass, agentAvailable) =>
    (inputReplayTraces 4).all fun events =>
      noRepeatedInputDispatchFor id status failureClass agentAvailable events)

/- retry 保存後、期限前の frozen batch と別 session の ready report を
   同じ具体履歴に保持し、選択を検査する。 -/
def retrySessionHistoryAfterSaveWithClocks
    (agentAvailable : Option Bool) (sendNow queueReadNow : Nat) : History := Id.run do
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let input : SettlementInput :=
    { lease := ⟨0, "", .send, 0⟩, workflow := .operatorAgent,
      status := .other, failureClass := .transport, agentAvailable }
  let mut h := accept {} { id := 7, user := false, session := "a", reportId := some "r" } .watchReport
  h := internal h (.operatorBeginCommit 10 cfg 0 true false)
  h := internal h (.operatorCommitApply "batch" "payload" 0)
  h := dispatch h "batch" "payload"
  h := { h with operatorNow := sendNow }
  h := sendResult h input
  return retrySavedWithReadTime h (fun _ => queueReadNow)

def retrySessionHistoryWithClocks
    (agentAvailable : Option Bool) (sendNow queueReadNow : Nat) : History :=
  accept
    (retrySessionHistoryAfterSaveWithClocks agentAvailable sendNow queueReadNow)
    { id := 22, user := false, session := "b", reportId := some "s" } .watchReport

def retrySessionHistoryWithAvailability (agentAvailable : Option Bool) : History :=
  retrySessionHistoryWithClocks agentAvailable 0 0

def retrySessionHistory : History := retrySessionHistoryWithAvailability none

/- 保存時 100+5秒と、保存後に再読した queue 時計 900+5秒を別々に保つ。 -/
def retrySessionHistoryWithClockSkew : History :=
  retrySessionHistoryWithClocks (some false) 100 900

/- retry deadline の再照合を、実際の履歴の内部 transition として保持する。 -/
def retrySessionReconnectedNoRefreshAt900 : History := Id.run do
  let mut h := retrySessionHistoryAfterSaveWithClocks (some false) 100 900
  h := operatorRequestReconnect h
  h := operatorBeginReconnect h 40
  return operatorReconnectResult h true

/- retry deadline の再照合を、実際の履歴の内部 transition として保持する。 -/
def retrySessionAfterRefreshAt900 : History := Id.run do
  let mut h := retrySessionReconnectedNoRefreshAt900
  let persisted := ((h.concrete.operator.queue.pending ++ h.concrete.operator.queue.held).find?
    (fun event => event.reportId == some "r")).get!
  h := { h with operatorNow := 900 }
  h := internal h (.operatorRefreshReport { persisted with retryReadyAt := some 5100 } persisted.readyAt)
  return h

/- 同じ reconnect 状態で refresh を挟まず、時刻 5200 に session b を受理する。 -/
def retrySessionNoRefreshBeforeSelectionAt5200 : History := Id.run do
  let mut h := retrySessionReconnectedNoRefreshAt900
  h := { h with operatorNow := 5200 }
  return accept h { id := 22, user := false, session := "b", reportId := some "s" } .watchReport

/- refresh 後、同じ時刻 5200 に session b を受理した選択直前の具体状態。 -/
def retrySessionAfterRefreshBeforeSelectionAt5200 : History := Id.run do
  let mut h := retrySessionAfterRefreshAt900
  h := { h with operatorNow := 5200 }
  return accept h { id := 22, user := false, session := "b", reportId := some "s" } .watchReport

/- 永続 retry deadline を再読して event を上書きした後、二つ目の session の poll が
   queue を起こすと、selector は in-memory deadline より早く session a を選ぶ。 -/
def retrySessionAfterRefreshWithClockSkew : History := Id.run do
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let mut h := retrySessionAfterRefreshBeforeSelectionAt5200
  h := internal h (.operatorBeginCommit 41 cfg 5200 true false)
  h := internal h (.operatorCommitApply "batch-a-early" "payload-a" 5200)
  return dispatch h "batch-a-early" "payload-a"

/- unavailable なまま session b が到着しても lifecycle gate は選択を開始させない。 -/
def retrySessionWhileUnavailable : History := Id.run do
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let mut h := retrySessionHistoryAfterSaveWithClocks (some false) 100 900
  h := { h with operatorNow := 5200 }
  h := accept h { id := 22, user := false, session := "b", reportId := some "s" } .watchReport
  return internal h (.operatorBeginCommit 41 cfg 5200 true false)

#guard (decide (
  let h := retrySessionAfterRefreshAt900
  h.supported &&
    h.concrete.operator.lifecycle.available &&
    h.concrete.operator.lifecycle.canDispatch &&
    h.concrete.operator.retryStoredAt == some 5100 &&
    h.concrete.operator.queue.retryById == [("r", 5900)] &&
    h.concrete.operator.queue.pending.any (fun event =>
      event.reportId == some "r" && event.readyAt == 5900 &&
        event.retryReadyAt == some 5100 && event.frozenBatchId == some "batch") &&
    h.items == retrySessionReconnectedNoRefreshAt900.items &&
    h.entries.any (fun entry => entry.event == .tick 900)
))

#guard (decide (
  let h := retrySessionWhileUnavailable
  let before := retrySessionHistoryAfterSaveWithClocks (some false) 100 900
  h.supported &&
    !h.concrete.operator.lifecycle.canDispatch &&
    h.concrete.operator.queue.pending.any (fun event => event.reportId == some "r") &&
    h.concrete.operator.queue.pending.any (fun event => event.reportId == some "s") &&
    h.concrete.operatorPreparing.isNone &&
    h.concrete.operatorSend.isNone &&
    h.concreteMarks == before.concreteMarks
))

#guard (decide (
  let h := retrySessionAfterRefreshWithClockSkew
  h.supported &&
    h.concrete.operator.queue.retryById == [] &&
    h.entries.any (fun entry => entry.event == .arrival .watchReport 22 &&
      Observation.accepted 22 .watchReport ∈ entry.observations) &&
    h.entries.flatMap (fun entry =>
      entry.observations.filterMap (fun observation => match observation with
        | .dispatched id attempt => if id == 7 then some attempt else none
        | _ => none)) == [1, 3] &&
    h.items.any (fun item => item.logicalId == 7 && !item.pending && item.lastAttempt == some 3) &&
    h.items.any (fun item => item.logicalId == 22 && item.pending)
))

/- refresh は追跡項目を落とさない。比較した #855 の retry / now / item 値は同じだが、
   具体 queue deadline が違い、session 別 selector の結果も変わる。 -/
#guard (decide (
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let before := retrySessionNoRefreshBeforeSelectionAt5200
  let after := retrySessionAfterRefreshBeforeSelectionAt5200
  let beforeObserved := observeDispatchHeld before .operator
  let afterObserved := observeDispatchHeld after .operator
  let beforeSelected := (before.concrete.operator.queue.selectBatch
    before.concrete.operator.selection cfg 5200).2
  let afterSelected := (after.concrete.operator.queue.selectBatch
    after.concrete.operator.selection cfg 5200).2
  beforeObserved.retry == afterObserved.retry &&
    beforeObserved.now == afterObserved.now &&
    beforeObserved.items 7 == afterObserved.items 7 &&
    beforeObserved.items 22 == afterObserved.items 22 &&
    before.concrete.operator.queue.pending.any
      (fun event => event.id == 8 && event.reportId == some "r" &&
        event.retryReadyAt == some 5900 && event.readyAt == 0) &&
    after.concrete.operator.queue.pending.any
      (fun event => event.id == 8 && event.reportId == some "r" &&
        event.retryReadyAt == some 5100 && event.readyAt == 5900) &&
    (beforeSelected.any (fun batch =>
      batch.session == some "b" && batch.events.any (fun event => event.id == 22))) &&
    (afterSelected.any (fun batch =>
      batch.session == some "a" && batch.events.any (fun event => event.id == 8))) &&
    beforeObserved.now == afterObserved.now
))

/- 抽象の retry / item / time フィールドでは refresh 前後を区別できない。
   この射影だけで Eligible 全体や abstract transition equivalence は主張しない。 -/
#guard (decide (
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let h := retrySessionAfterRefreshAt900
  let observed := observeDispatchHeld h .operator
  let selected := (h.concrete.operator.queue.selectBatch
    h.concrete.operator.selection cfg 900).2
  observed.retry == .none && observed.now == 900 &&
    observed.available && !observed.attention && observed.lease.isNone &&
    observed.items 7 == some ⟨.watchReport, .pending⟩ &&
    selected.isNone &&
    h.concrete.operator.queue.pending.any
      (fun event => event.reportId == some "r" &&
        event.retryReadyAt == some 5100 && event.readyAt == 5900)
))

#guard (decide (
  let h := retrySessionHistoryWithClockSkew
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let beforeQueueDeadline :=
    (h.concrete.operator.queue.selectBatch h.concrete.operator.selection cfg 5899).2
  let atQueueDeadline :=
    (h.concrete.operator.queue.selectBatch h.concrete.operator.selection cfg 5900).2
  h.concrete.operator.retryStoredAt == some 5100 &&
    h.concrete.operator.queue.pending.any
      (fun e => e.id == 8 && e.retryReadyAt == some 5900 && e.frozenBatchId == some "batch") &&
    beforeQueueDeadline.any (fun b => b.session == some "b" && b.events.any (fun e => e.id == 22)) &&
    atQueueDeadline.any (fun b => b.session == some "a" && b.events.any (fun e => e.id == 8))
))

#guard (decide (
  let h := retrySessionHistory
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let s := observeDispatchHeld h .operator
  let selected := (h.concrete.operator.queue.selectBatch h.concrete.operator.selection cfg 0).2
  let beforeDeadline := (h.concrete.operator.queue.selectBatch h.concrete.operator.selection cfg 4999).2
  let atDeadline := (h.concrete.operator.queue.selectBatch h.concrete.operator.selection cfg 5000).2
  h.concrete.operator.queue.pending.any (fun e => e.session == "a" && e.frozenBatchId == some "batch" && e.retryReadyAt == some 5000) &&
  selected.any (fun b => b.session == some "b" && b.events.any (fun e => e.id == 22)) &&
  beforeDeadline.any (fun b => b.session == some "b" && b.events.any (fun e => e.id == 22)) &&
  atDeadline.any (fun b => b.session == some "a" && b.events.any (fun e => e.id == 8)) &&
  s.retry == .none && s.available && !s.attention && s.lease == none &&
  s.items 7 == some ⟨.watchReport, .pending⟩ && s.items 22 == some ⟨.watchReport, .pending⟩ &&
  s.conversationHold == false && s.reportHold == false
))

/- ready な別 session を dispatch して ack を終えた後も、retry report は期限まで残る。 -/
def retrySessionAfterOtherDispatch : History := Id.run do
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let success : SettlementInput :=
    { lease := ⟨0, "", .send, 0⟩, workflow := .operatorAgent,
      status := .completed, failureClass := .transport }
  let mut h := retrySessionHistory
  h := internal h (.operatorBeginCommit 20 cfg 0 true false)
  h := internal h (.operatorCommitApply "batch-b" "payload-b" 0)
  h := dispatch h "batch-b" "payload-b"
  h := sendResult h success
  h := operatorAckStep h (.operatorAckResult true 0)
  return operatorAckStep h .operatorFinishAcknowledged

/- 期限到来後に frozen retry を dispatch する同一 concrete history。 -/
def retrySessionAfterRetryDispatch : History := Id.run do
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let mut h := retrySessionAfterOtherDispatch
  h := internal h (.operatorBeginCommit 21 cfg 5000 true false)
  h := internal h (.operatorCommitApply "batch-a" "payload-a" 5000)
  return dispatch h "batch-a" "payload-a"

/- 別 session を先に送っても retry report は保留に残り、期限後の dispatch で追跡を閉じる。 -/
#guard (decide (
  let afterOther := retrySessionAfterOtherDispatch
  let afterRetry := retrySessionAfterRetryDispatch
  afterOther.supported &&
    afterOther.concrete.operator.queue.pending.any
      (fun e => e.id == 8 && e.retryReadyAt == some 5000 && e.frozenBatchId == some "batch") &&
    afterOther.items.any (fun i => i.logicalId == 7 && i.concreteId == 8 && i.pending && i.lastAttempt == some 1) &&
    afterOther.items.any (fun i => i.logicalId == 22 && !i.pending && i.lastAttempt == some 2) &&
    afterRetry.supported && !(afterRetry.concrete.operator.queue.pending.any (fun e => e.id == 8)) &&
    afterRetry.items.any (fun i => i.logicalId == 7 && !i.pending && i.lastAttempt == some 3) &&
    afterRetry.items.any (fun i => i.logicalId == 22 && !i.pending && i.lastAttempt == some 2)
))

/- unavailable になった session a の report retry を保持した具体履歴で reconnect
   成功後、ready な session b と期限待ちの a を別々に選択できるかを調べる。 -/
def retrySessionAfterReconnect : History := Id.run do
  let mut h := retrySessionHistoryWithAvailability (some false)
  h := operatorRequestReconnect h
  h := operatorBeginReconnect h 30
  return operatorReconnectResult h true

def retryReconnectAfterOtherDispatch : History := Id.run do
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let success : SettlementInput :=
    { lease := ⟨0, "", .send, 0⟩, workflow := .operatorAgent,
      status := .completed, failureClass := .transport }
  let mut h := retrySessionAfterReconnect
  h := internal h (.operatorBeginCommit 31 cfg 0 true false)
  h := internal h (.operatorCommitApply "batch-b" "payload-b" 0)
  h := dispatch h "batch-b" "payload-b"
  h := sendResult h success
  h := operatorAckStep h (.operatorAckResult true 0)
  return operatorAckStep h .operatorFinishAcknowledged

def retryReconnectAfterRetryDispatch : History := Id.run do
  let cfg : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let mut h := retryReconnectAfterOtherDispatch
  h := internal h (.operatorBeginCommit 32 cfg 5000 true false)
  h := internal h (.operatorCommitApply "batch-a" "payload-a" 5000)
  return dispatch h "batch-a" "payload-a"

/- reconnect は availability だけを戻し、retry deadline は維持する。
   期限前は session b、期限到来後は session a が同じ履歴から選択される。 -/
#guard (decide (
  let reconnected := retrySessionAfterReconnect
  ! (retrySessionHistoryWithAvailability (some false)).concrete.operator.lifecycle.available &&
    reconnected.concrete.operator.lifecycle.available &&
    reconnected.concrete.operator.pendingReconnects == 0 &&
    reconnected.concrete.operator.queue.pending.any
      (fun e => e.id == 8 && e.retryReadyAt == some 5000 && e.frozenBatchId == some "batch") &&
    reconnected.entries.any (fun e => e.event == .reconnectResult true)
))

#guard (decide (
  let beforeRetry := retryReconnectAfterOtherDispatch
  beforeRetry.supported &&
    beforeRetry.concreteMarks.any (fun mark => mark == .selected .operator [22]) &&
    beforeRetry.concrete.operator.queue.pending.any
      (fun e => e.id == 8 && e.retryReadyAt == some 5000 && e.frozenBatchId == some "batch") &&
    beforeRetry.items.any
      (fun i => i.logicalId == 7 && i.concreteId == 8 && i.pending && i.lastAttempt == some 1) &&
    beforeRetry.items.any
      (fun i => i.logicalId == 22 && !i.pending && i.lastAttempt == some 3)
))

#guard (decide (
  let afterRetry := retryReconnectAfterRetryDispatch
  afterRetry.supported &&
    !(afterRetry.concrete.operator.queue.pending.any (fun e => e.id == 8)) &&
    afterRetry.items.any (fun i => i.logicalId == 7 && !i.pending && i.lastAttempt == some 4) &&
    afterRetry.items.any (fun i => i.logicalId == 22 && !i.pending && i.lastAttempt == some 3)
))

/- reconnect 要求と成功結果は具体 report の retry・frozen・hold・attention を変えない。
   availability と reconnect lease / 要求数は reconnect の対象なので比較から除く。 -/
#guard (decide (
  let before := retrySessionHistoryWithAvailability (some false)
  let requested := operatorRequestReconnect before
  let begun := operatorBeginReconnect requested 30
  let after := operatorReconnectResult begun true
  let s := observeDispatchHeld before .operator
  let t := observeDispatchHeld after .operator
  let frozenA (h : History) :=
    h.concrete.operator.queue.pending.any
      (fun event => event.id == 8 && event.frozenBatchId == some "batch")
  let frozenB (h : History) :=
    h.concrete.operator.queue.pending.any
      (fun event => event.id == 22 && event.frozenBatchId.isSome)
  s.retry == t.retry &&
    frozenA before == frozenA after && frozenB before == frozenB after &&
    s.reportHold == t.reportHold &&
    s.conversationHold == t.conversationHold &&
    s.dispatchHold == t.dispatchHold &&
    s.attention == t.attention &&
    s.items 7 == t.items 7 && s.items 22 == t.items 22 &&
    !s.available && t.available
))

/- #855 の operation.reconnect に対応させた要求遷移では、保護対象を保持する。 -/
#guard (decide (
  let before := retrySessionHistoryWithAvailability (some false)
  let requested := operatorRequestReconnect before
  let s := observeDispatchHeld before .operator
  let t := observeDispatchHeld requested .operator
  s.retry == t.retry &&
    s.reportHold == t.reportHold &&
    s.conversationHold == t.conversationHold &&
    s.dispatchHold == t.dispatchHold &&
    s.attention == t.attention &&
    s.available == t.available &&
    s.items 7 == t.items 7 && s.items 22 == t.items 22 &&
    before.concrete.operator.queue.pending.any
      (fun event => event.id == 8 && event.frozenBatchId == some "batch") ==
    requested.concrete.operator.queue.pending.any
      (fun event => event.id == 8 && event.frozenBatchId == some "batch")
))

/-- #855 では frozen を忠実に写す限り、別 session でも非 frozen report は eligible でない。 -/
theorem frozen_blocks_other_report (s : State) (a b : EventId)
    (f : s.frozen a) (nf : ¬ s.frozen b)
    (item : s.items b = some ⟨.watchReport, .pending⟩) : ¬ Eligible s b := by
  intro ⟨kind, pending, _, _, tail⟩
  have eq : kind = .watchReport := by
    unfold Pending at pending
    rw [item] at pending
    cases pending
    rfl
  subst kind
  rcases tail with ne | ⟨_, _, _, all | frozen⟩
  · exact ne rfl
  · exact all a f
  · exact nf frozen

end Ensemble.AsIs.ObservedHistory
