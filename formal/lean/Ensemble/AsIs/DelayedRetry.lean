import Ensemble.AsIs.Composition

/-! 限定された到達例に対する operator 側の遅延写像。全遷移への写像ではない。 -/
namespace Ensemble.AsIs.DelayedRetry

open Ensemble.Flow
open Ensemble.AsIs.Composition
open Ensemble.AsIs.ConductorDispatchLifecycle

private def input : Ensemble.AsIs.OperatorDispatch.Event := { id := 2, user := true }
private def waiting : System := reportAwaitingRetry
private def inputWaiting : System := step waiting (.operatorInput input true 100)
private def saved : System := step inputWaiting (.operatorRetryResult (fun _ => 100) true)
private def stopped : System := run inputWaiting [.operatorInputEnd, .operatorRetryStopped]
private def failed : System := step inputWaiting .operatorRetryException
private def savedDirect : System := step waiting (.operatorRetryResult (fun _ => 100) true)
private def stoppedDirect : System := run waiting [.operatorInputEnd, .operatorRetryStopped]
private def failedDirect : System := step waiting .operatorRetryException
private def interrupted : System := run reportSending [.operatorRequestStop, .operatorInterruptSend]

/- 保存成功、失敗と入力介在で、具体 queue と停止状態が想定どおり変化する。 -/
#guard (decide (
  reportSending.operator.lifecycle.activeLease.isSome &&
  waiting.operator.lifecycle.activeLease.isNone && waiting.operator.retryPending &&
  inputWaiting.operator.queue.conversationHold &&
  saved.operator.queue.held.any (fun e => e.reportId == some "report") &&
  savedDirect.operator.queue.pending.any (fun e => e.reportId == some "report") &&
  stopped.operator.stopped && failed.operator.stopped && stoppedDirect.operator.stopped &&
  failedDirect.operator.stopped &&
  stopped.operatorRetryExit == some .stopped && failed.operatorRetryExit == some .exception &&
  stopped.operator.queue.held.isEmpty && stoppedDirect.operator.queue.pending.isEmpty &&
  interrupted.operator.stopped && interrupted.operator.lifecycle.activeLease.isSome
))

/-- 固定した具体例の二項目と attempt に、任意の異なる抽象 ID を割り当てる。 -/
private def view (s : System) (reportId inputId attempt : Nat) (reportPending userPresent : Bool) : State where
  lease := s.operator.lifecycle.activeLease.map (fun _ => .send attempt)
  available := s.operator.lifecycle.available
  attention := s.operator.lifecycle.pendingAttemptId.isSome
  dispatchHold := false
  conversationHold := s.operator.queue.conversationHold
  reportHold := s.operator.queue.reportHold
  held := fun id => id = reportId ∧ s.operator.queue.held.any (fun e => e.reportId == some "report")
  pendingReconnects := s.operator.pendingReconnects
  retry := if s.operator.retryPending then .send 5000 else .none
  frozen := fun _ => False
  items := fun id => if id = reportId then some ⟨.watchReport, if reportPending then .pending else .dispatched⟩
    else if id = inputId ∧ userPresent then some ⟨.operatorInput, .pending⟩ else none
  lastAttempt := fun id => if id = reportId then some attempt else none
  completed := fun _ => False
  now := 0

/-- 限定した到達例の遷移。停止・例外時は結果を出すが再投入しない。 -/
private def relation (reportId inputId attempt : Nat) : Transition := fun s e o t =>
  (s = view reportSending reportId inputId attempt false false ∧ e = .tick 0 ∧ o = [] ∧ t = view waiting reportId inputId attempt false false) ∨
  (s = view waiting reportId inputId attempt false false ∧ e = .operation (.input inputId) ∧ o = [.accepted inputId .operatorInput] ∧ t = view inputWaiting reportId inputId attempt false true) ∨
  (s = view inputWaiting reportId inputId attempt false true ∧ e = .sendResult attempt .failed ∧ o = [.requeued reportId] ∧ t = view saved reportId inputId attempt true true) ∨
  (s = view inputWaiting reportId inputId attempt false true ∧ e = .sendResult attempt .failed ∧ o = [] ∧ t = view stopped reportId inputId attempt false true) ∨
  (s = view inputWaiting reportId inputId attempt false true ∧ e = .sendResult attempt .failed ∧ o = [] ∧ t = view failed reportId inputId attempt false true) ∨
  (s = view waiting reportId inputId attempt false false ∧ e = .sendResult attempt .failed ∧ o = [.requeued reportId] ∧ t = view savedDirect reportId inputId attempt true false) ∨
  (s = view waiting reportId inputId attempt false false ∧ e = .sendResult attempt .failed ∧ o = [] ∧ t = view stoppedDirect reportId inputId attempt false false) ∨
  (s = view waiting reportId inputId attempt false false ∧ e = .sendResult attempt .failed ∧ o = [] ∧ t = view failedDirect reportId inputId attempt false false) ∨
  (s = view reportSending reportId inputId attempt false false ∧ e = .tick 0 ∧ o = [] ∧ t = view interrupted reportId inputId attempt false false)

/-- 観測整合性だけの検査であり、tick の意味・他の性質の保存は含まない。 -/
theorem fixture_observation_consistent (reportId inputId attempt : Nat)
    (distinct : reportId ≠ inputId) : ObservationConsistent (relation reportId inputId attempt) := by
  classical
  intro s e obs t h
  rcases h with h | h | h | h | h | h | h | h | h <;> rcases h with ⟨rfl, rfl, rfl, rfl⟩
  all_goals
    simp only [view, Pending, List.mem_cons, List.not_mem_nil, or_false, false_or]
    repeat' constructor
    all_goals
      intros
      try simp_all
      try split at * <;> simp_all
      try omega
      try simp_all [eq_comm]
      try exact (Classical.em _).symm
      try exact ⟨attempt, .failed, by simp⟩

/--
この試作では tick に写した未完了 settle が lease を変える。
tick が時刻以外を変えないという追加条件を課す場合、この接続は使えない。
元仕様自体がその追加条件を形式化しているという主張ではない。
-/
theorem fixture_tick_changes_lease :
    ¬ ∀ s t obs time, relation 1 2 1 s (.tick time) obs t → s.lease = t.lease := by
  intro h
  have transition : relation 1 2 1 (view reportSending 1 2 1 false false) (.tick 0) []
      (view waiting 1 2 1 false false) := Or.inl ⟨rfl, rfl, rfl, rfl⟩
  have same := h _ _ _ _ transition
  have different :
      (view reportSending 1 2 1 false false).lease ≠ (view waiting 1 2 1 false false).lease := by
    decide +kernel
  exact different same

end Ensemble.AsIs.DelayedRetry
