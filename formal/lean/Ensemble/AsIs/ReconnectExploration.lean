import Ensemble.AsIs.Composition
import Ensemble.AsIs.ConcreteTrace

/-! # reconnect 後の自律ターン上限

これは具体モデルの有限探索であり、#855 の弱公平な無限実行の反例ではない。
-/
namespace Ensemble.AsIs.ReconnectExploration

open Ensemble.AsIs.Composition
open Ensemble.AsIs.ConductorDispatchLifecycle

/-- 最初の worker send が完了し、自律ターン上限 1 に達した状態。 -/
def start : System :=
  let dummy : Lease := ⟨0, "", .send, 0⟩
  let completed : SettlementInput :=
    { lease := dummy, workflow := .issue, status := .finished, failureClass := .transport }
  run { maxTurns := 1 } [
    .conductorEnqueue { id := 1, kind := .workerCompleted, name := "first" },
    .conductorBeginSend 1 0 none none true,
    .conductorSendResult completed
  ]

/-- 固定の worker 到着・reconnect 要求・開始・成功の4種類を探索する。 -/
def alphabet : List Event := [
  .conductorEnqueue { id := 2, kind := .workerCompleted, name := "second" },
  .conductorEnqueue { id := 3, kind := .reconnect },
  .conductorBeginReconnect 2,
  .conductorReconnectResult true false
]

/-- 最後が有効な成功結果で、その直後の send 試行が上限で worker を送れない。 -/
def blockedAfterSuccessfulReconnect (trace : List Event) : Bool := Id.run do
  let mut s := start
  for e in trace do
    let validSuccess := match e with
      | .conductorReconnectResult true false =>
        s.conductorError.isNone && s.conductorReconnect.any (fun l =>
          s.conductor.lifecycle.matches l .reconnect)
      | _ => false
    let next := step s e
    if validSuccess then
      let dispatch := step next (.conductorBeginSend 3 0 none none true)
      if next.conductor.lifecycle.available && next.autonomousTurns == 1 &&
          next.conductor.queue.any (fun item => item.id == 2) &&
          dispatch.conductorSend.isNone &&
          dispatch.conductor.queue.any (fun item => item.id == 2) then return true
    s := next
  return false

/- この4操作は有効な成功後も worker が待機する例となる。 -/
#guard (blockedAfterSuccessfulReconnect alphabet)

/- 上記の開始状態・4種類の操作に限り、長さ3以下に同じ現象はない。 -/
#guard ((tracesUpTo alphabet 3).length == 85)
#guard ((tracesUpTo alphabet 3).all (fun trace => !(blockedAfterSuccessfulReconnect trace)))

/-- 上記の到達列を通った後、worker を一回選択しようとした具体状態。 -/
def blocked : System :=
  step (run start alphabet) (.conductorBeginSend 3 0 none none true)

/-- 上限が維持される間、同じ選択試行はこの具体状態を変えない。 -/
theorem blocked_selection_fixed :
    step blocked (.conductorBeginSend 3 0 none none true) = blocked := by
  rfl

/-- 限定観測は到達済み状態を #855 の worker eligible 状態に対応させる。 -/
def blockedModel : Ensemble.AsIs.ConcreteTrace.Model System where
  observe := fun _ => workerObservation
  step := fun s event obs t =>
    s = blocked ∧ event = .tick 0 ∧ obs = [] ∧
      t = step s (.conductorBeginSend 3 0 none none true)

/-- 固定された具体状態を保ちながら、同じ選択試行を繰り返す無限列。 -/
def repeatedBlocked : Ensemble.AsIs.ConcreteTrace.Execution blockedModel where
  state := fun _ => blocked
  event := fun _ => .tick 0
  observations := fun _ => []
  valid := by
    intro _
    exact ⟨rfl, rfl, rfl, blocked_selection_fixed.symm⟩

/-- この限定観測では常に eligible だが、選択が現れないため弱公平ではない。 -/
theorem repeated_blocked_not_fair :
    ¬ Ensemble.Flow.SchedulerFair repeatedBlocked.project 2 := by
  apply Ensemble.AsIs.ConcreteTrace.continuously_eligible_without_selection_not_fair
    repeatedBlocked.project 0 2
  · intro _ _
    exact workerObservation_eligible
  · intro _ _ h
    cases h

end Ensemble.AsIs.ReconnectExploration
