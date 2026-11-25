import Ensemble.Flow.Spec

/-! # 具体状態を保持する実行と抽象仕様への射影

抽象状態が同じでも具体状態が異なる場合がある。有限実行は具体的な中間状態を
保持し、射影した遷移を逆向きにつないで具体実行とみなさない。
-/
namespace Ensemble.AsIs.ConcreteTrace

open Ensemble.Flow

/-- 具体実行上、選択と dispatch を別時点に置く場合の直接的な進行条件。
    選択の弱公平性に加え、対象が可能な時の選択が後の dispatch に至る
    という独立の仮定を要する。この定理は合成モデルが仮定を満たすとは主張しない。 -/
theorem concrete_fair_eventually_dispatched
    (eligible selected dispatched : Nat → Prop) (n : Nat)
    (untilDispatch : ∀ m, n ≤ m → (∀ k, n ≤ k → k < m → ¬ dispatched k) → eligible m)
    (fair : ∀ j, (∀ m, j ≤ m → eligible m) → ∃ m, j ≤ m ∧ selected m)
    (selectionProgress : ∀ m, n ≤ m → eligible m → selected m →
      ∃ k, m ≤ k ∧ dispatched k) :
    ∃ k, n ≤ k ∧ dispatched k := by
  classical
  apply Classical.byContradiction
  intro missing
  have noDispatch : ∀ k, n ≤ k → ¬ dispatched k := by
    intro k hk hd
    exact missing ⟨k, hk, hd⟩
  have always : ∀ m, n ≤ m → eligible m := by
    intro m hm
    exact untilDispatch m hm (fun k hk _ => noDispatch k hk)
  obtain ⟨m, hm, choice⟩ := fair n always
  obtain ⟨k, hmk, delivered⟩ := selectionProgress m hm (always m hm) choice
  exact noDispatch k (Nat.le_trans hm hmk) delivered

/-- 具体状態と、抽象仕様で観測できる状態への写像。 -/
structure Model (σ : Type) where
  observe : σ → State
  step : σ → Event → List Observation → σ → Prop

/-- 中間状態を具体状態のままつないだ有限実行。 -/
inductive Run {σ : Type} (model : Model σ) : σ → List (Event × List Observation) → σ → Prop where
  | nil (s : σ) : Run model s [] s
  | cons {s t u : σ} {e : Event} {o : List Observation} {rest : List (Event × List Observation)} :
      model.step s e o t → Run model t rest u → Run model s ((e, o) :: rest) u

/-- 具体遷移の両端を射影した抽象遷移。連続実行の逆向きの対応は保証しない。 -/
def projectedStep {σ : Type} (model : Model σ) : Transition :=
  fun s e obs t => ∃ a b, model.observe a = s ∧ model.observe b = t ∧ model.step a e obs b

/-- 具体的な初期状態の射影。 -/
def projectedInitial {σ : Type} (model : Model σ) (initial : σ → Prop) : State → Prop :=
  fun s => ∃ a, initial a ∧ model.observe a = s

/-- 具体実行は同じ観測列の抽象実行に射影できる。逆は一般に成り立たない。 -/
theorem run_projects {σ : Type} (model : Model σ) {a b : σ} {trace : List (Event × List Observation)}
    (h : Run model a trace b) : Ensemble.Flow.Run (projectedStep model) (model.observe a) trace (model.observe b) := by
  induction h with
  | nil s => exact .nil (model.observe s)
  | @cons s t u e o rest hstep hrun ih =>
    exact .cons ⟨s, t, rfl, rfl, hstep⟩ ih

/-- 初期状態からの具体実行も、射影先では到達可能である。 -/
theorem reachable_projects {σ : Type} (model : Model σ) (initial : σ → Prop)
    {a b : σ} {trace : List (Event × List Observation)} (ha : initial a) (h : Run model a trace b) :
    Reachable (projectedInitial model initial) (projectedStep model) (model.observe b) := by
  exact ⟨model.observe a, trace, ⟨a, ha, rfl⟩, run_projects model h⟩

/-- 射影先の消失防止が成り立てば、具体実行上でも保留項目は消失しない。 -/
theorem noEventLoss_concrete {σ : Type} (model : Model σ) (initial : σ → Prop)
    (property : NoEventLoss (projectedInitial model initial) (projectedStep model))
    {start s t : σ} {past trace : List (Event × List Observation)} {id : EventId} {kind : ItemKind}
    (hstart : initial start) (hprefix : Run model start past s)
    (hpending : Pending (model.observe s) id kind) (hrun : Run model s trace t)
    (hdispatch : ¬ Dispatched trace id) (hdiscard : ¬ Observed trace (.discarded id)) :
    Pending (model.observe t) id kind := by
  exact property (model.observe s) trace (model.observe t) id kind
    (reachable_projects model initial hstart hprefix) hpending (run_projects model hrun) hdispatch hdiscard

/-- 受理後の保持は、具体履歴とその観測列に対して抽象命題から従う。 -/
theorem acceptedEventRetained_concrete {σ : Type} (model : Model σ) (initial : σ → Prop)
    (property : AcceptedEventRetained (projectedInitial model initial) (projectedStep model))
    {start s t u : σ} {past trace : List (Event × List Observation)}
    {event : Event} {obs : List Observation} {id : EventId} {kind : ItemKind}
    (hstart : initial start) (hpast : Run model start past s)
    (hstep : model.step s event obs t) (haccepted : .accepted id kind ∈ obs)
    (hrun : Run model t trace u) (hdispatch : ¬ Dispatched trace id)
    (hdiscard : ¬ Observed trace (.discarded id)) :
    Pending (model.observe u) id kind := by
  exact property (model.observe s) (model.observe t) (model.observe u) event obs trace id kind
    (reachable_projects model initial hstart hpast)
    ⟨s, t, rfl, rfl, hstep⟩ haccepted (run_projects model hrun) hdispatch hdiscard

/-- input 非再送は、受理からの具体履歴を保った実行に抽象命題から引き継がれる。 -/
theorem noAutomaticInputReplay_concrete {σ : Type} (model : Model σ) (initial : σ → Prop)
    (property : NoAutomaticInputReplay (projectedInitial model initial) (projectedStep model))
    {start s t u : σ} {before after : List (Event × List Observation)}
    {attempt : AttemptId} {result : SendResult} {id : EventId} {obs : List Observation}
    (hstart : initial start) (hbefore : Run model start before s)
    (haccepted : Observed before (.accepted id .operatorInput))
    (hdispatched : Observed before (.dispatched id attempt)) (hincomplete : result ≠ .completed)
    (hstep : model.step s (.sendResult attempt result) obs t) (hafter : Run model t after u) :
    (∀ next, .dispatched id next ∉ obs) ∧ ¬ Dispatched after id := by
  exact property (model.observe start) before (model.observe s) (model.observe t) (model.observe u)
    attempt result id obs after ⟨start, hstart, rfl⟩ (run_projects model hbefore)
    haccepted hdispatched hincomplete ⟨s, t, rfl, rfl, hstep⟩ (run_projects model hafter)

/-- 再投入を tick と同じ遷移で観測すると、元仕様の観測整合性には反する。 -/
theorem requeueOnTick_inconsistent (step : Transition) (s t : State) (id : EventId) (time : Time)
    (hstep : step s (.tick time) [.requeued id] t) : ¬ ObservationConsistent step := by
  intro h
  have hcons := h s (.tick time) [.requeued id] t hstep
  rcases hcons with ⟨_, _, _, _, hrequeue, _⟩
  have hmem : Observation.requeued id ∈ [Observation.requeued id] := by simp
  obtain ⟨attempt, result, hevent, _, _, _⟩ := hrequeue id hmem
  cases hevent

/-- 再投入の観測には、同じ遷移の未完了 send 結果が必要である。 -/
theorem requeue_requires_incomplete_result (step : Transition) (s t : State)
    (event : Event) (obs : List Observation) (id : EventId)
    (hstep : step s event obs t) (hconsistent : ObservationConsistent step)
    (hobserved : .requeued id ∈ obs) :
    ∃ attempt result, event = .sendResult attempt result ∧ result ≠ .completed := by
  rcases hconsistent s event obs t hstep with ⟨_, _, _, _, hrequeue, _⟩
  obtain ⟨attempt, result, hevent, hincomplete, _, _⟩ := hrequeue id hobserved
  exact ⟨attempt, result, hevent, hincomplete⟩

/-- lease の異なる二つの抽象状態を、状態不変の stutter としては扱えない。 -/
theorem different_lease_not_stutter (s t : State) (h : s.lease ≠ t.lease) : s ≠ t := by
  intro equal
  exact h (congrArg State.lease equal)

/-- 選択時の配信と弱公平性から、継続して可能な項目の最終配信が従う。 -/
theorem fair_eventually_dispatched (step : Transition) (scheduled : ScheduledDispatches step)
    (run : Ensemble.Flow.Execution) (n : Nat) (id : EventId)
    (valid : ValidExecution step run) (eligible : EligibleUntilDispatch run n id)
    (fair : SchedulerFair run id) : ∃ m, n ≤ m ∧ DispatchAt run m id := by
  classical
  apply Classical.byContradiction
  intro h
  have noDispatch : ∀ k, n ≤ k → ¬ DispatchAt run k id := by
    intro k hk hd
    exact h ⟨k, hk, hd⟩
  have alwaysEligible : ∀ m, n ≤ m → Eligible (run.state m) id := by
    intro m hm
    exact eligible m hm (fun k hk _ => noDispatch k hk)
  obtain ⟨m, hm, chosen⟩ := fair n alwaysEligible
  have hstep := valid m
  rw [chosen] at hstep
  obtain ⟨attempt, observed⟩ := scheduled (run.state m) (run.state (m + 1))
    id (run.observations m) (alwaysEligible m hm) hstep
  exact noDispatch m hm ⟨attempt, observed⟩

/--
抽象上ずっと選択可能な項目について、選択が現れない無限列は弱公平ではない。
具体側が無限に待機できること自体や、その列の到達可能性はこの定理に含まれない。
-/
theorem continuously_eligible_without_selection_not_fair
    (run : Ensemble.Flow.Execution) (n : Nat) (id : EventId)
    (eligible : ∀ m, n ≤ m → Eligible (run.state m) id)
    (notSelected : ∀ m, n ≤ m → run.event m ≠ .schedule id) :
    ¬ SchedulerFair run id := by
  intro fair
  obtain ⟨m, hm, selected⟩ := fair n eligible
  exact notSelected m hm selected

/-- 選択時に配信するモデルは、仕様の hold 対象外通知の配信性を満たす。 -/
theorem scheduled_implies_hold_exempt (step : Transition) (scheduled : ScheduledDispatches step) :
    HoldExemptDelivered step := by
  intro run n id valid _ _ eligible fair
  exact fair_eventually_dispatched step scheduled run n id valid eligible fair

/-- 選択時に配信するモデルは、仕様の reconnect 後の配信性を満たす。 -/
theorem scheduled_implies_reconnect_resumes (step : Transition) (scheduled : ScheduledDispatches step) :
    ReconnectResumes step := by
  intro run n id valid _ eligible fair
  exact fair_eventually_dispatched step scheduled run (n + 1) id valid eligible fair

/-- 無限実行も具体状態の列を保持する。 -/
structure Execution {σ : Type} (model : Model σ) where
  state : Nat → σ
  event : Nat → Event
  observations : Nat → List Observation
  valid : ∀ n, model.step (state n) (event n) (observations n) (state (n + 1))

/-- 具体的な無限実行を抽象状態と同じ観測の無限実行へ射影する。 -/
def Execution.project {σ : Type} {model : Model σ} (run : Execution model) : Ensemble.Flow.Execution where
  state := fun n => model.observe (run.state n)
  event := run.event
  observations := run.observations

/-- 射影された無限実行は射影遷移に従う。 -/
theorem Execution.project_valid {σ : Type} {model : Model σ} (run : Execution model) :
    ValidExecution (projectedStep model) run.project := by
  intro n
  exact ⟨run.state n, run.state (n + 1), rfl, rfl, run.valid n⟩

end Ensemble.AsIs.ConcreteTrace
