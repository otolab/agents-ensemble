import Ensemble.AsIs.ObservedHistory
import Ensemble.AsIs.ConcreteTrace

/-! # commit 後停止の観測履歴

固定した入力・設定と具体履歴に限る。TS の実行時再現や全遷移の忠実性は仮定しない。
-/
namespace Ensemble.AsIs.ObservedLoss

open Ensemble.AsIs.ObservedHistory
open Ensemble.AsIs.ConcreteTrace
open Ensemble.Flow

/-- 初期状態から固定した入力を受理した履歴。 -/
def accepted : History := accept {} { id := 7, user := true, bytes := 1 } .operatorInput

/-- 固定入力の batch を選択・commit した履歴。 -/
def selected : History := internal accepted (.operatorBeginCommit 10
  { maxWait := 0, idleAging := 10, maxUserBytes := 100 } 0 true false)

/-- 選択後に停止を要求した履歴。 -/
def requested : History := internal selected .operatorRequestStop

/-- commit 待機中の停止結果まで進めた履歴。 -/
def stopped : History := internal requested (.operatorCommitStopped "" "" true)

/-- 具体履歴の各段階を区別する限定遷移。 -/
def model : Model History where
  observe := fun h => observe h .operator
  step := fun a e obs b =>
    (a = ({} : History) ∧ e = .operation (.input 7) ∧ obs = [.accepted 7 .operatorInput] ∧ b = accepted) ∨
    (a = accepted ∧ e = .tick 0 ∧ obs = [] ∧ b = selected) ∨
    (a = selected ∧ e = .tick 0 ∧ obs = [] ∧ b = requested) ∨
    (a = requested ∧ e = .tick 0 ∧ obs = [] ∧ b = stopped)

/-- 限定モデルの初期履歴。 -/
def initial : History → Prop := fun h => h = {}

/-- 受理後から停止までの抽象イベント列。 -/
def trace : List (Ensemble.Flow.Event × List Observation) :=
  [(.tick 0, []), (.tick 0, []), (.tick 0, [])]

/-- 初期履歴から入力受理への具体遷移。 -/
theorem initial_to_accepted : ConcreteTrace.Run model {} [(.operation (.input 7), [.accepted 7 .operatorInput])] accepted := by
  apply ConcreteTrace.Run.cons
  · exact Or.inl ⟨rfl, rfl, rfl, rfl⟩
  · exact .nil _

/-- 受理から停止までの具体履歴。 -/
theorem accepted_to_stopped : ConcreteTrace.Run model accepted trace stopped := by
  apply ConcreteTrace.Run.cons
  · exact Or.inr (Or.inl ⟨rfl, rfl, rfl, rfl⟩)
  apply ConcreteTrace.Run.cons
  · exact Or.inr (Or.inr (Or.inl ⟨rfl, rfl, rfl, rfl⟩))
  apply ConcreteTrace.Run.cons
  · exact Or.inr (Or.inr (Or.inr ⟨rfl, rfl, rfl, rfl⟩))
  exact .nil _

/-- 入力は受理直後に保留状態である。 -/
theorem before_pending : Pending (observe accepted .operator) 7 .operatorInput := by
  unfold Pending
  decide +kernel

/-- 停止後の限定観測では入力が保留でない。 -/
theorem after_not_pending : ¬ Pending (observe stopped .operator) 7 .operatorInput := by
  unfold Pending
  decide +kernel

/-- この固定列の射影では、受理済み入力は dispatch・明示破棄なしに pending でなくなる。 -/
theorem no_event_loss_fails : ¬ NoEventLoss (projectedInitial model initial) (projectedStep model) := by
  intro property
  have reachable := reachable_projects model initial (show initial {} from rfl) initial_to_accepted
  have execution := run_projects model accepted_to_stopped
  have noDispatch : ¬ Dispatched trace 7 := by simp [Dispatched, Observed, trace]
  have noDiscard : ¬ Observed trace (.discarded 7) := by simp [Observed, trace]
  exact after_not_pending (property _ trace _ 7 .operatorInput reachable before_pending execution noDispatch noDiscard)

/-- 同じ受理遷移からの履歴は、受理済み項目の保持にも反する。 -/
theorem accepted_event_retained_fails :
    ¬ AcceptedEventRetained (projectedInitial model initial) (projectedStep model) := by
  intro property
  have reachable : Reachable (projectedInitial model initial) (projectedStep model)
      (observe ({} : History) .operator) :=
    reachable_projects model initial (show initial {} from rfl) (ConcreteTrace.Run.nil ({} : History))
  have acceptedStep : projectedStep model (observe ({} : History) .operator)
      (.operation (.input 7)) [.accepted 7 .operatorInput] (observe accepted .operator) :=
    ⟨{}, accepted, rfl, rfl, Or.inl ⟨rfl, rfl, rfl, rfl⟩⟩
  have execution := run_projects model accepted_to_stopped
  have noDispatch : ¬ Dispatched trace 7 := by simp [Dispatched, Observed, trace]
  have noDiscard : ¬ Observed trace (.discarded 7) := by simp [Observed, trace]
  exact after_not_pending (property _ _ _ _ _ trace 7 .operatorInput reachable acceptedStep
    (by simp) execution noDispatch noDiscard)

/-- 同じ限定射影は、観測なしの pending 消失を禁じる観測整合性も満たさない。 -/
theorem observation_consistent_fails :
    ¬ ObservationConsistent (projectedStep model) := by
  intro consistent
  have concrete : model.step requested (.tick 0) [] stopped :=
    Or.inr (Or.inr (Or.inr ⟨rfl, rfl, rfl, rfl⟩))
  have projected : projectedStep model (observe requested .operator) (.tick 0) []
      (observe stopped .operator) := ⟨requested, stopped, rfl, rfl, concrete⟩
  have changes := (consistent _ _ _ _ projected).2.2.2.2.2.2.2 7
  have pre : (observe requested .operator).items 7 = some ⟨.operatorInput, .pending⟩ := by
    decide +kernel
  have post : (observe stopped .operator).items 7 = none := by
    decide +kernel
  simp [pre, post, Pending] at changes

/-- 固定値の4操作だけで反例の長さを探索する。 -/
inductive Choice where
  | input | select | stopRequest | stopCommit
  deriving BEq, DecidableEq

/-- 固定した一操作を具体履歴に適用する。 -/
def perform (h : History) : Choice → History
  | .input => accept h { id := 7, user := true, bytes := 1 } .operatorInput
  | .select => internal h (.operatorBeginCommit 10
      { maxWait := 0, idleAging := 10, maxUserBytes := 100 } 0 true false)
  | .stopRequest => internal h .operatorRequestStop
  | .stopCommit => internal h (.operatorCommitStopped "" "" true)

/-- 最小性探索に用いる固定操作。 -/
def choices : List Choice := [.input, .select, .stopRequest, .stopCommit]

/-- 固定操作から指定長以下の列を列挙する。 -/
def choicesUpTo : Nat → List (List Choice)
  | 0 => [[]]
  | n + 1 => let shorter := choicesUpTo n
    shorter ++ (shorter.filter (fun xs => xs.length == n)).flatMap
      (fun xs => choices.map (fun choice => xs ++ [choice]))

/-- 入力がモデルの dispatch 対象から外れたかを判定する。 -/
def missingFromDispatchInput (events : List Choice) : Bool :=
  let h := events.foldl perform ({} : History)
  h.items.any (fun item => item.logicalId == 7 && item.missingFromDispatch)

/-- selector が対象を選んだ印を残したまま、send 開始の dispatch 印がないか。 -/
def selectedWithoutDispatch (events : List Choice) : Bool :=
  let h := events.foldl perform ({} : History)
  h.concreteMarks.any (fun mark => mark == .selected .operator [7]) &&
    !(h.concreteMarks.any fun mark => match mark with
      | .dispatched .operator ids _ => ids.contains 7
      | _ => false)

#guard ((choicesUpTo 3).length == 85)
#guard ((choicesUpTo 3).all (fun events => !missingFromDispatchInput events))
#guard (missingFromDispatchInput [.input, .select, .stopRequest, .stopCommit])

/- 固定操作 alphabet では受理前の選択は起きず、入力受理と次の選択で初めて選択印が残る。 -/
#guard ((choicesUpTo 1).length == 5)
#guard ((choicesUpTo 1).all (fun events => !selectedWithoutDispatch events))
#guard (selectedWithoutDispatch [.input, .select])

end Ensemble.AsIs.ObservedLoss
