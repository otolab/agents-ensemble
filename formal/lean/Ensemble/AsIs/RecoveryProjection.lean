import Ensemble.AsIs.ConcreteTrace
import Ensemble.AsIs.OperatorDispatch

/-! # 回復操作の射影と具体状態の区別

これは回復操作の接続だけを取り出した検査であり、全 dispatch フローのモデルではない。
queue 内の項目や履歴は扱わず、runner の停止を抽象状態に写さない場合の限界を示す。
-/
namespace Ensemble.AsIs.RecoveryProjection

open Ensemble.Flow
open Ensemble.AsIs.ConcreteTrace
open Ensemble.AsIs.OperatorDispatch

/-- lifecycle と operator の hold を回復操作の検査に必要な範囲で射影する。 -/
def observe (r : Runner) : State where
  lease := none
  available := r.lifecycle.available
  attention := r.lifecycle.pendingAttemptId.isSome
  dispatchHold := false
  conversationHold := r.queue.conversationHold
  reportHold := r.queue.reportHold
  held := fun _ => False
  pendingReconnects := r.pendingReconnects
  retry := .none
  frozen := fun _ => False
  items := fun _ => none
  lastAttempt := fun _ => none
  completed := fun _ => False
  now := 0

/-- 通常入力を指定しない recovery continue の具体遷移。 -/
def recoveryStep (r : Runner) (e : Ensemble.Flow.Event) (obs : List Observation) (next : Runner) : Prop :=
  e = .operation .recoveryContinue ∧ obs = [] ∧ next = (r.recoveryContinue none).1

/-- 回復操作に限定した具体モデル。 -/
def model : Model Runner := ⟨observe, recoveryStep⟩

/-- 確認待ちで稼働中の runner。 -/
def live : Runner := { lifecycle := { pendingAttemptId := some "1" } }

/-- 稼働中の例と停止以外の状態が一致する runner。 -/
def stopped : Runner := { live with stopped := true }

/-- 停止状態を射影しないため、二つの runner は同じ抽象状態に写る。 -/
theorem same_observation : observe live = observe stopped := rfl

/-- 抽象遷移には、稼働中の runner が確認待ちを解除する経路が含まれる。 -/
theorem abstract_recovery :
    projectedStep model (observe stopped) (.operation .recoveryContinue) []
      (observe (live.recoveryContinue none).1) := by
  exact ⟨live, (live.recoveryContinue none).1, same_observation, rfl, rfl, rfl, rfl⟩

/-- 停止済み runner の同じ操作は確認待ちを解除しない。 -/
theorem stopped_recovery_preserves_attention :
    (observe (stopped.recoveryContinue none).1).attention = true := by decide

/-- 停止済み runner から上記の抽象遷移を具体遷移へ持ち上げることはできない。 -/
theorem no_lift :
    ¬ ∃ next, recoveryStep stopped (.operation .recoveryContinue) [] next ∧
      observe next = observe (live.recoveryContinue none).1 := by
  rintro ⟨next, ⟨_, _, rfl⟩, h⟩
  have h' := congrArg State.attention h
  change true = false at h'
  contradiction

end Ensemble.AsIs.RecoveryProjection
