import Ensemble.AsIs.Composition

/-! # 停止した operator の具体回復経路

同一の具体状態を維持する任意長の列を検査する。抽象遷移の逆方向の持ち上げは仮定しない。
-/
namespace Ensemble.AsIs.StoppedRecovery

open Ensemble.AsIs.Composition
open Ensemble.AsIs.ConductorDispatchLifecycle

/-- #855 の回復操作のうち operator に関わる操作、conductor hold 解除、内部待機。 -/
inductive Action where
  | recoveryContinue | resumeWatch | reportHoldOff | dispatchHoldOff
  | requestReconnect | beginReconnect (token : Nat) | reconnectResult (success : Bool) | wait
  | sendResult (input : SettlementInput) (now : Nat)
  | retryResult (readTime : Nat → Nat) (success : Bool)

/-- 内部待機はこの限定モデルでは状態を変えない。 -/
def apply (s : System) : Action → System
  | .recoveryContinue => step s .operatorRecoveryContinue
  | .resumeWatch => step s .operatorResumeWatch
  | .reportHoldOff => step s (.operatorHold false)
  | .dispatchHoldOff => step s (.conductorHold false)
  | .requestReconnect => step s .operatorRequestReconnect
  | .beginReconnect token => step s (.operatorBeginReconnect token)
  | .reconnectResult success => step s (.operatorReconnectResult success)
  | .wait => s
  | .sendResult input now => step s (.operatorSendResult input now)
  | .retryResult readTime success => step s (.operatorRetryResult readTime success)

/-- 指定操作は停止した operator を変更しない。 -/
theorem action_preserves_stopped_operator (s : System) (h : s.operator.stopped = true)
    (event : Action) : (apply s event).operator = s.operator := by
  cases event <;> simp [apply, step, h,
    Ensemble.AsIs.OperatorDispatch.Runner.recoveryContinue,
    Ensemble.AsIs.OperatorDispatch.Runner.requestReconnect,
    Ensemble.AsIs.OperatorDispatch.Runner.beginReconnect,
    Ensemble.AsIs.OperatorDispatch.Runner.finishRetryRecord]
  case sendResult =>
    split <;> simp

/-- 操作列を同じ具体 System 上で逐次実行する。 -/
def runActions (s : System) (events : List Action) : System := events.foldl apply s

/-- 上記操作の任意の有限列は停止した operator の状態を変えられない。 -/
theorem actions_preserve_stopped_operator (s : System) (h : s.operator.stopped = true)
    (events : List Action) : (runActions s events).operator = s.operator := by
  induction events generalizing s with
  | nil => rfl
  | cons first rest ih =>
    have same := action_preserves_stopped_operator s h first
    have remains : (apply s first).operator.stopped = true := by rw [same]; exact h
    have tail := ih (apply s first) remains
    exact tail.trans same

/-- 初期状態から送信失敗・別入力・retry 保存待ちでの停止に至る。 -/
def stoppedExample : System :=
  let config : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let dummy : Lease := ⟨0, "", .send, 0⟩
  let failure : SettlementInput :=
    { lease := dummy, workflow := .operatorAgent, status := .other,
      failureClass := .transport, captureFailure := false }
  run {} [
    .operatorInput { id := 1, user := true } true 100,
    .operatorBeginCommit 1 config 0 true false,
    .operatorCommitApply "batch" "payload" 0,
    .operatorCommitSuccess "batch" "payload",
    .operatorSendResult failure 0,
    .operatorInput { id := 2, user := true } true 100,
    .operatorInputEnd,
    .operatorRetryStopped
  ]

/-- この到達状態では停止と confirmation gate、後から受けた入力が残る。 -/
theorem example_stopped : stoppedExample.operator.stopped = true := by decide +kernel

/-- 入力終了を契機とする停止例であり、終了後の入力は受け付けない。 -/
theorem example_input_ended : stoppedExample.operatorInputEnded = true := by decide +kernel

/-- 入力終了後は新たな通常入力を受理しない。 -/
theorem stopped_example_rejects_input (event : Ensemble.AsIs.OperatorDispatch.Event)
    (nonblank : Bool) (limit : Nat) :
    step stoppedExample (.operatorInput event nonblank limit) = stoppedExample := by
  simp [step, example_input_ended]

/-- 停止例では確認待ちが残る。 -/
theorem example_attention : stoppedExample.operator.lifecycle.pendingAttemptId.isSome = true := by
  decide +kernel

/-- 停止例では後から受理した入力が残る。 -/
theorem example_pending :
    stoppedExample.operator.queue.pending.any (fun e => e.user && e.id == 2) = true := by
  decide +kernel

/-- 対象操作の任意長の列の後も、確認待ちは解消しない。 -/
theorem attention_persists (events : List Action) :
    (runActions stoppedExample events).operator.lifecycle.pendingAttemptId.isSome = true := by
  rw [actions_preserve_stopped_operator stoppedExample example_stopped events]
  exact example_attention

/-- 同じ具体状態を通る対象操作列では、確認待ちのない状態へ到達できない。 -/
theorem no_attention_free_recovery :
    ¬ ∃ events, (runActions stoppedExample events).operator.lifecycle.pendingAttemptId.isSome = false := by
  rintro ⟨events, h⟩
  have remaining := attention_persists events
  rw [h] at remaining
  contradiction

/-- 限定例の attention と入力 2 を具体 operator から読む観測。
    他の項目や任意の send 履歴の一般的な観測ではない。 -/
def observeExample (s : System) : Ensemble.Flow.State :=
  { Ensemble.AsIs.RecoveryProjection.observe s.operator with
    items := fun id => if id = 2 &&
      s.operator.queue.pending.any (fun e => e.user && e.id == 2)
      then some ⟨.operatorInput, .pending⟩ else none }

/-- 保留入力 2 が初期到達状態の観測に含まれる。 -/
theorem example_observed_pending :
    Ensemble.Flow.Pending (observeExample stoppedExample) 2 .operatorInput := by
  simp [Ensemble.Flow.Pending, observeExample, example_pending]

/-- この具体操作集合では保留入力 2 が抽象上 eligible な状態にも到達しない。 -/
theorem no_concrete_eligible_recovery :
    ¬ ∃ events, Ensemble.Flow.Eligible (observeExample (runActions stoppedExample events)) 2 := by
  rintro ⟨events, _, _, ready, _⟩
  have h := attention_persists events
  have notAttention := ready.2.2.1
  change (runActions stoppedExample events).operator.lifecycle.pendingAttemptId.isSome = false at notAttention
  rw [notAttention] at h
  contradiction

/-- 同じ観測を持つ稼働中状態。retry 保存が成功した具体列で得る。 -/
def liveExample : System :=
  let config : Ensemble.AsIs.OperatorDispatch.Scheduling :=
    { maxWait := 0, idleAging := 10, maxUserBytes := 100 }
  let dummy : Lease := ⟨0, "", .send, 0⟩
  let failure : SettlementInput :=
    { lease := dummy, workflow := .operatorAgent, status := .other,
      failureClass := .transport, captureFailure := false }
  run {} [
    .operatorInput { id := 1, user := true } true 100,
    .operatorBeginCommit 1 config 0 true false,
    .operatorCommitApply "batch" "payload" 0,
    .operatorCommitSuccess "batch" "payload",
    .operatorSendResult failure 0,
    .operatorInput { id := 2, user := true } true 100,
    .operatorRetryResult (fun _ => 0) true
  ]

/-- 限定観測では稼働中と停止後が同じ状態に写る。 -/
theorem same_example_observation : observeExample liveExample = observeExample stoppedExample := by
  unfold observeExample Ensemble.AsIs.RecoveryProjection.observe
  dsimp only
  congr 1
  all_goals
    try funext id
    try decide +kernel
  have livePending : liveExample.operator.queue.pending.any (fun e => e.user && e.id == 2) = true := by
    decide +kernel
  simp [livePending, example_pending]

/-- 存在による単一遷移射影に、稼働中状態の解除を含める。 -/
def recoveryModel : Ensemble.AsIs.ConcreteTrace.Model System where
  observe := observeExample
  step := fun s e obs t =>
    e = .operation .recoveryContinue ∧ obs = [] ∧ t = step s .operatorRecoveryContinue

/-- 異なる具体状態を経由する射影遷移が存在する。 -/
theorem spliced_abstract_step :
    Ensemble.AsIs.ConcreteTrace.projectedStep recoveryModel (observeExample stoppedExample)
      (.operation .recoveryContinue) [] (observeExample (step liveExample .operatorRecoveryContinue)) := by
  exact ⟨liveExample, step liveExample .operatorRecoveryContinue, same_example_observation, rfl,
    rfl, rfl, rfl⟩

/-- 継ぎ合わされた抽象経路の終点では入力が eligible になる。 -/
theorem spliced_target_eligible :
    Ensemble.Flow.Eligible (observeExample (step liveExample .operatorRecoveryContinue)) 2 := by
  refine ⟨.operatorInput, ?_, ?_, Or.inl rfl, ?_⟩
  · unfold Ensemble.Flow.Pending
    decide +kernel
  · constructor <;> first | decide +kernel | constructor
    all_goals decide +kernel
  · exact Or.inl (by decide)

/-- 射影遷移には元の回復命題が求める形の抽象経路がある。 -/
theorem projected_recovery_exists :
    ∃ trace target,
      Ensemble.Flow.Run (Ensemble.AsIs.ConcreteTrace.projectedStep recoveryModel)
        (observeExample stoppedExample) trace target ∧
      (∀ entry ∈ trace, Ensemble.Flow.RecoveryEvent entry.1) ∧
      Ensemble.Flow.Eligible target 2 := by
  refine ⟨[(.operation .recoveryContinue, [])],
    observeExample (step liveExample .operatorRecoveryContinue), ?_, ?_, spliced_target_eligible⟩
  · exact .cons spliced_abstract_step (.nil _)
  · simp [Ensemble.Flow.RecoveryEvent]

end Ensemble.AsIs.StoppedRecovery
