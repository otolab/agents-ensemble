import Ensemble.AsIs.StoppedRecovery

/-! # 具体履歴を保持した回復可能性

到達可能な2状態から、`StoppedRecovery.Action` に限定して継続するモデル。
固定された #855 の抽象 `Transition` による回復可能性との関係を調べる。
-/
namespace Ensemble.AsIs.HistoryRecovery

open Ensemble.AsIs.StoppedRecovery
open Ensemble.Flow

/-- 両方とも初期状態からの具体列で得られる。 -/
inductive Origin where
  | stopped | live

/-- 分岐元と、それ以降の具体操作列を保持する。 -/
structure History where
  origin : Origin
  actions : List Action

/-- 操作列を具体状態に対して順に適用する。 -/
def History.state (h : History) : Ensemble.AsIs.Composition.System :=
  let start := match h.origin with | .stopped => stoppedExample | .live => liveExample
  runActions start h.actions

/-- 過去の操作を保持したまま、同じ履歴に新しい操作列を追加する。 -/
def History.advance (h : History) (events : List Action) : History :=
  { h with actions := h.actions ++ events }

/-- 操作列を追加した履歴の具体状態を求める。 -/
theorem History.state_advance (h : History) (events : List Action) :
    (h.advance events).state = runActions h.state events := by
  cases h with
  | mk origin past =>
    cases origin <;> simp [History.advance, History.state, runActions, List.foldl_append]

/-- 同じ具体状態から継続する回復可能性。 -/
def ConcreteRecovery (h : History) : Prop :=
  ∃ future, Eligible (observeExample (h.advance future).state) 2

/-- #855 の存在量化と同じ抽象状態・抽象回復経路による回復可能性。 -/
def AbstractRecovery (step : Transition) (s : State) : Prop :=
  ∃ trace target, Run step s trace target ∧
    (∀ entry ∈ trace, RecoveryEvent entry.1) ∧ Eligible target 2

/-- 停止済みの具体履歴は、対象操作列では回復できない。 -/
theorem stopped_history_not_recoverable :
    ¬ ConcreteRecovery ⟨.stopped, []⟩ := by
  intro ⟨future, eligible⟩
  apply no_concrete_eligible_recovery
  rw [History.state_advance] at eligible
  exact ⟨future, eligible⟩

/-- 稼働中の具体履歴は recovery continue で回復できる。 -/
theorem live_history_recoverable : ConcreteRecovery ⟨.live, []⟩ := by
  refine ⟨[.recoveryContinue], ?_⟩
  exact spliced_target_eligible

/-- 同じ観測を持つ到達履歴について、固定 Transition の回復可能性は区別できない。 -/
theorem same_observation_for_histories :
    observeExample (History.state ⟨.stopped, []⟩) =
      observeExample (History.state ⟨.live, []⟩) := same_example_observation.symm

/--
この観測と対象操作では、固定の抽象 Transition をどう選んでも、到達した2履歴の
抽象回復可能性と具体回復可能性をともに同値にすることはできない。
観測を変えた場合や、#855 と異なる履歴添字付き遷移の可能性は排除しない。
-/
theorem no_fixed_transition_exact_correspondence :
    ¬ ∃ step : Transition, ∀ h : History,
      AbstractRecovery step (observeExample h.state) ↔ ConcreteRecovery h := by
  rintro ⟨step, exactCorrespondence⟩
  have abstractLive := (exactCorrespondence ⟨.live, []⟩).2 live_history_recoverable
  have abstractStopped : AbstractRecovery step (observeExample (History.state ⟨.stopped, []⟩)) := by
    rw [same_observation_for_histories]
    exact abstractLive
  exact stopped_history_not_recoverable ((exactCorrespondence ⟨.stopped, []⟩).1 abstractStopped)

end Ensemble.AsIs.HistoryRecovery
