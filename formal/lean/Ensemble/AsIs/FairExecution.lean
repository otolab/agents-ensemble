import Ensemble.AsIs.Composition
import Ensemble.AsIs.ConcreteTrace

/-! # 限定実行における公平性条件の点検

実際の Composition.System を遷移させる小さなモデル。hold 中の permission stall が
eligible のまま、外部から与えた hold tool 操作を二回受けた後に選択・send される
無限実行を構成する。dispatch 後は eligible でなくなるため、#855 の `SchedulerFair`
の「以後ずっと eligible」という前提がこの witness で成立しないことも証明する。
全操作や TS driver の自律進行を含む合成モデルではない。
-/
namespace Ensemble.AsIs.FairExecution
open Ensemble.AsIs.Composition Ensemble.AsIs.ConcreteTrace Ensemble.AsIs.ConductorDispatchLifecycle Ensemble.Flow

structure ConcreteState where
  system : System
  stallDispatched : Bool := false
  stallCompleted : Bool := false

def before : System := run {} [
  .conductorHold true,
  .conductorEnqueue { id := 4, kind := .stall }
]

def initial : ConcreteState := ⟨before, false, false⟩
def started : ConcreteState := ⟨step before (.conductorBeginSend 1 0 none none true), true, false⟩

def completionInput : SettlementInput :=
  { lease := ⟨0, "", .send, 0⟩, workflow := .issue,
    status := .completed, failureClass := .transport }

def finished : ConcreteState :=
  ⟨step started.system (.conductorSendResult completionInput), true, true⟩

def holdIter : Nat → ConcreteState
  | 0 => finished
  | n + 1 =>
    let previous := holdIter n
    { previous with system := step previous.system (.conductorHold true) }

def observeConcrete (s : ConcreteState) : State := Id.run do
  let lifecycle := s.system.conductor.lifecycle
  let queued := s.system.conductor.queue.any (·.id == 4) || s.system.conductor.hold.held.any (·.id == 4)
  let item := if s.stallDispatched then some ⟨.permissionStall, .dispatched⟩
    else if queued then some ⟨.permissionStall, .pending⟩ else none
  return {
    lease := lifecycle.activeLease.map (fun lease => if lease.kind == .send then .send lease.id else .reconnect)
    available := lifecycle.available
    attention := lifecycle.pendingAttemptId.isSome
    dispatchHold := s.system.conductor.hold.active
    conversationHold := false
    reportHold := false
    held := fun id => s.system.conductor.hold.held.any (·.id == id) = true
    pendingReconnects := 0
    retry := .none
    frozen := fun _ => False
    items := fun id => if id == 4 then item else none
    lastAttempt := fun id => if id == 4 && s.stallDispatched then some 1 else none
    completed := fun attempt => attempt == 1 && s.stallCompleted
    now := 0
  }

/- Composition 上の hold(true) は、既に有効なら同じ具体状態を保つ。 -/
theorem hold_true_noop (s : System) (active : s.conductor.hold.active = true) :
    step s (.conductorHold true) = s := by
  cases s with
  | mk conductor operator conductorReconnect operatorReconnect operatorSend operatorInbox
      conductorSend conductorInbox conductorError autonomousTurns maxTurns nextAutonomousTurns
      operatorRetryExit operatorInputEnded operatorStopRequested operatorPreparing operatorReservation
      operatorNextReservationId operatorCanInspectRecovery operatorCommitLease
      operatorCommitInputEndedAtStart operatorCommitApplied operatorCommitConfig =>
    cases conductor with
    | mk hold queue batchState lifecycle =>
      cases hold with
      | mk wasActive held =>
        simp_all [step, Ensemble.AsIs.ConductorQueue.setHold]

def model : Model ConcreteState where
  observe := observeConcrete
  step := fun s e obs t =>
    (s = initial ∧ e = .operation (.setDispatchHold true) ∧ obs = [] ∧ t = initial) ∨
    (s = initial ∧ e = .schedule 4 ∧ obs = [.dispatched 4 1] ∧ t = started) ∨
    (s = started ∧ e = .sendResult 1 .completed ∧ obs = [] ∧ t = finished) ∨
    (s.stallDispatched = true ∧ s.stallCompleted = true ∧
      e = .operation (.setDispatchHold true) ∧ obs = [] ∧
      t = { s with system := step s.system (.conductorHold true) })

theorem before_eligible : Eligible (observeConcrete initial) 4 := by
  refine ⟨.permissionStall, ?_, ?_, Or.inr (Or.inl rfl), ?_⟩
  · unfold Pending observeConcrete initial
    decide +kernel
  · unfold LifecycleReady observeConcrete initial
    decide +kernel
  · simp

theorem started_not_eligible : ¬ Eligible (observeConcrete started) 4 := by
  intro ⟨_, _, ready, _, _⟩
  have lease : (observeConcrete started).lease = some (.send 1) := by decide +kernel
  have empty := ready.1
  rw [lease] at empty
  cases empty

theorem dispatched_not_eligible (s : ConcreteState) (h : s.stallDispatched = true) :
    ¬ Eligible (observeConcrete s) 4 := by
  intro ⟨kind, pending, _, _, _⟩
  have item : (observeConcrete s).items 4 = some ⟨.permissionStall, .dispatched⟩ := by
    simp [observeConcrete, h]
  have kindEq : kind = .permissionStall := by
    unfold Pending at pending
    rw [item] at pending
    cases pending
  subst kind
  unfold Pending at pending
  rw [item] at pending
  cases pending

theorem holdIter_flags : ∀ n, (holdIter n).stallDispatched = true ∧ (holdIter n).stallCompleted = true := by
  intro n
  induction n with
  | zero => constructor <;> rfl
  | succ n ih =>
    change (holdIter n).stallDispatched = true ∧ (holdIter n).stallCompleted = true
    exact ih

theorem scheduled_dispatches : ScheduledDispatches (projectedStep model) := by
  intro s t id obs eligible hstep
  obtain ⟨a, b, _, _, hconcrete⟩ := hstep
  rcases hconcrete with hwait | hscheduled | hsend | htail
  · rcases hwait with ⟨_, he, _, _⟩
    cases he
  · rcases hscheduled with ⟨_, he, hobs, _⟩
    have hid : id = 4 := by injection he
    subst id
    exact ⟨1, by simp [hobs]⟩
  · rcases hsend with ⟨_, he, _, _⟩
    cases he
  · rcases htail with ⟨_, _, he, _, _⟩
    cases he

theorem hold_exempt_delivered : HoldExemptDelivered (projectedStep model) :=
  ConcreteTrace.scheduled_implies_hold_exempt (projectedStep model) scheduled_dispatches

def execution : Execution model where
  state
    | 0 => initial
    | 1 => initial
    | 2 => initial
    | 3 => started
    | n + 4 => holdIter n
  event
    | 0 => .operation (.setDispatchHold true)
    | 1 => .operation (.setDispatchHold true)
    | 2 => .schedule 4
    | 3 => .sendResult 1 .completed
    | _ + 4 => .operation (.setDispatchHold true)
  observations
    | 2 => [.dispatched 4 1]
    | _ => []
  valid := by
    intro n
    cases n with
    | zero =>
      left
      exact ⟨rfl, rfl, rfl, rfl⟩
    | succ n =>
      cases n with
      | zero =>
        left
        exact ⟨rfl, rfl, rfl, rfl⟩
      | succ n =>
        cases n with
        | zero =>
          right
          left
          exact ⟨rfl, rfl, rfl, rfl⟩
        | succ n =>
          cases n with
          | zero =>
            right
            right
            left
            exact ⟨rfl, rfl, rfl, rfl⟩
          | succ n =>
            right
            right
            right
            refine ⟨(holdIter_flags n).1, (holdIter_flags n).2, rfl, rfl, ?_⟩
            rfl

theorem execution_dispatched_flag (n : Nat) (h : 3 ≤ n) :
    (execution.state n).stallDispatched = true := by
  cases n with
  | zero => omega
  | succ n =>
    cases n with
    | zero => omega
    | succ n =>
      cases n with
      | zero => omega
      | succ n =>
        cases n with
        | zero => rfl
        | succ n => simp [execution, holdIter_flags]

theorem not_continuously_eligible_from (n : Nat) :
    ¬ (∀ m, n ≤ m → Eligible (execution.project.state m) 4) := by
  intro always
  have eligible := always (max n 3) (Nat.le_max_left n 3)
  have dispatched := execution_dispatched_flag (max n 3) (Nat.le_max_right n 3)
  change Eligible (observeConcrete (execution.state (max n 3))) 4 at eligible
  exact dispatched_not_eligible _ dispatched eligible

/-- この実行は `SchedulerFair` を満たすが、その対象について公平性の前提はどの suffix でも偽。 -/
theorem fair : SchedulerFair execution.project 4 := by
  intro n always
  exact False.elim (not_continuously_eligible_from n always)

theorem eligible_until : EligibleUntilDispatch execution.project 0 4 := by
  intro m _ notYet
  by_cases beforeSelection : m ≤ 2
  · have mCases : m = 0 ∨ m = 1 ∨ m = 2 := by omega
    rcases mCases with rfl | rfl | rfl
    · simpa [Execution.project, model, execution] using before_eligible
    · simpa [Execution.project, model, execution] using before_eligible
    · simpa [Execution.project, model, execution] using before_eligible
  · have dispatched : DispatchAt execution.project 2 4 := by
      exact ⟨1, by simp [Execution.project, execution, model]⟩
    exact False.elim (notYet 2 (by omega) (by omega) dispatched)

theorem delayed_while_eligible :
    Eligible (execution.project.state 0) 4 ∧
    Eligible (execution.project.state 1) 4 ∧
    Eligible (execution.project.state 2) 4 ∧
    execution.project.event 0 ≠ .schedule 4 ∧
    execution.project.event 1 ≠ .schedule 4 ∧
    execution.project.event 2 = .schedule 4 ∧
    DispatchAt execution.project 2 4 := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
  · simpa [Execution.project, model, execution] using before_eligible
  · simpa [Execution.project, model, execution] using before_eligible
  · simpa [Execution.project, model, execution] using before_eligible
  · decide
  · decide
  · rfl
  · exact ⟨1, by simp [Execution.project, execution, model]⟩

theorem delivered : DispatchAt execution.project 2 4 := by
  exact ⟨1, by simp [Execution.project, execution, model]⟩

/--
公平な選択だけでは配信に至らない反例モデル。対象は全状態で eligible で、scheduler
は毎回選択するが、選択と dispatch を結ぶ遷移を置いていない。このモデルは
`Composition.step` や TS の runner の経路ではなく、`ScheduledDispatches` がない場合に
公平性だけから `HoldExemptDelivered` を導けないことを示すための抽象的な対照例。
-/
def unlinkedSchedulerModel : Model ConcreteState where
  observe := observeConcrete
  step := fun s e obs t =>
    s = initial ∧ e = .schedule 4 ∧ obs = [] ∧ t = initial

def unlinkedSchedulerExecution : Execution unlinkedSchedulerModel where
  state _ := initial
  event _ := .schedule 4
  observations _ := []
  valid := by
    intro n
    exact ⟨rfl, rfl, rfl, rfl⟩

theorem unlinked_scheduler_eligible (n : Nat) :
    Eligible (unlinkedSchedulerExecution.project.state n) 4 := by
  simpa [Execution.project, unlinkedSchedulerExecution, unlinkedSchedulerModel] using before_eligible

/-- この対照実行では scheduler fairness の前提が実際に常時成立する。 -/
theorem unlinked_scheduler_fair : SchedulerFair unlinkedSchedulerExecution.project 4 := by
  intro n _
  exact ⟨n, Nat.le_refl n, rfl⟩

theorem unlinked_scheduler_eligible_until :
    EligibleUntilDispatch unlinkedSchedulerExecution.project 0 4 := by
  intro n _ _
  exact unlinked_scheduler_eligible n

theorem unlinked_scheduler_never_dispatches (n : Nat) :
    ¬ DispatchAt unlinkedSchedulerExecution.project n 4 := by
  rintro ⟨attempt, observed⟩
  simp [Execution.project, unlinkedSchedulerExecution] at observed

/--
`SchedulerFair` が有効でも選択後進行がなければ hold 対象外通知は配信されない。
この対照モデルは `ScheduledDispatches` を満たさず、TS の到達可能性は主張しない。
-/
theorem fair_selection_without_progress_not_delivered :
    ¬ HoldExemptDelivered (projectedStep unlinkedSchedulerModel) := by
  intro delivered
  have pending : Pending (unlinkedSchedulerExecution.project.state 0) 4 .permissionStall := by
    change Pending (observeConcrete initial) 4 .permissionStall
    unfold Pending observeConcrete initial
    decide +kernel
  have hold : (unlinkedSchedulerExecution.project.state 0).dispatchHold = true := by
    decide +kernel
  obtain ⟨n, _, dispatch⟩ := delivered
    unlinkedSchedulerExecution.project
    0 4
    unlinkedSchedulerExecution.project_valid
    hold
    pending
    unlinked_scheduler_eligible_until
    unlinked_scheduler_fair
  exact unlinked_scheduler_never_dispatches n dispatch

end Ensemble.AsIs.FairExecution
