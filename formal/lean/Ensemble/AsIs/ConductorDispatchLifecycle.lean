/-!
# 共有 dispatch lifecycle の現行モデル

対応元はいずれも `packages/core/src/conductor/conductor-dispatch-lifecycle.ts`。

| TypeScript | Lean |
|---|---|
| `ConductorDispatchState` | `DispatchState` |
| `ConductorDispatchLease`, `ConductorReconnectLease` | `Lease` |
| `state`, `available`, `confirmationRequired`, `pendingAttemptId`, `lastFailure`, `canDispatch` | `Lifecycle.state`, `Lifecycle.available`, `Lifecycle.confirmationRequired`, `Lifecycle.pendingAttemptId`, `Lifecycle.lastFailure`, `Lifecycle.canDispatch` |
| `beginSend`, `beginReconnect` | `Lifecycle.beginSend`, `Lifecycle.beginReconnect` |
| `settleSend`, `settleReconnect`, `setAgentAvailable`, `confirmRecovery`, `wake` | `Lifecycle.settleSend`, `Lifecycle.settleReconnect`, `Lifecycle.setAgentAvailable`, `Lifecycle.confirmRecovery`, `Lifecycle.wake` |
| `settleConductorDispatch` | `settleConductorDispatch` |

本文と metadata は lifecycle の分岐に影響しないため保持しない。inbox は snapshot の recovery ID を attempt ID で表した一覧として保持する。固定 prefix の付加は単射なので重複判定に必要な区別は失われない。複数件の存在を保持し、期限切れ・明示削除は外部から指定した ID を取り除く。commit は予約の検証成功後に期限切れを削除し、重複を検査する TS の順序を再現する。時刻・容量・本文・予約の詳細は inbox の責務として抽象化し、呼び出し側は期限切れ ID と commit の予約検証結果を実際の inbox に整合させる。release が予約を削除したかは追跡しない。失敗分類、入力の有無、byte 上限超過も外部入力とする。通知 listener の実行と例外はモデル化せず、`wake` は状態を変えない。token は一意な自然数として表し、呼び出し側が新しい token を供給する。TS の symbol の同一性は id とは別に照合する。
-/

namespace Ensemble.AsIs.ConductorDispatchLifecycle

/-- 操作の種類。 -/
inductive Kind where
  | send | reconnect
  deriving Repr, DecidableEq, BEq, Inhabited

/-- 公開される lifecycle 状態。 -/
inductive DispatchState where
  | ready | inFlight | reconnecting | unavailable | attention
  deriving Repr, DecidableEq, BEq

/-- recovery の失敗分類。 -/
inductive FailureClass where
  | auth | transport | providerError | cancelled | sendRejected | incompleteStatus
  deriving Repr, DecidableEq, BEq

/-- 発行された lease。payload は lifecycle の判定に使われない。 -/
structure Lease where
  id : Nat
  attemptId : String
  kind : Kind
  token : Nat
  deriving Repr, DecidableEq, BEq, Inhabited

/-- lease と独立した availability、確認対象、直近失敗を持つ状態。 -/
structure Lifecycle where
  sequence : Nat := 0
  activeLease : Option Lease := none
  available : Bool := true
  pendingAttemptId : Option String := none
  lastFailure : Option FailureClass := none
  deriving Repr, DecidableEq, BEq, Inhabited

/-- 公開 state の優先順位を適用する。 -/
def Lifecycle.state (s : Lifecycle) : DispatchState :=
  match s.activeLease with
  | some l => if l.kind == .send then .inFlight else .reconnecting
  | none => if !s.available then .unavailable else if s.pendingAttemptId.isSome then .attention else .ready

/-- 確認対象があるかを返す。 -/
def Lifecycle.confirmationRequired (s : Lifecycle) : Bool := s.pendingAttemptId.isSome

/-- lease がなく、利用可能で、確認待ちでない場合に送信できる。 -/
def Lifecycle.canDispatch (s : Lifecycle) : Bool :=
  s.activeLease.isNone && s.available && s.pendingAttemptId.isNone

/-- 新しい send lease を発行する。失敗時は状態を変えない。 -/
def Lifecycle.beginSend (s : Lifecycle) (token : Nat) : Lifecycle × Option Lease :=
  if s.canDispatch then
    let id := s.sequence + 1
    let lease : Lease := ⟨id, toString id, .send, token⟩
    ({ s with sequence := id, activeLease := some lease }, some lease)
  else (s, none)

/-- lease が空なら availability や確認待ちに関係なく reconnect を開始する。 -/
def Lifecycle.beginReconnect (s : Lifecycle) (token : Nat) : Lifecycle × Option Lease :=
  if s.activeLease.isNone then
    let id := s.sequence + 1
    let lease : Lease := ⟨id, toString id, .reconnect, token⟩
    ({ s with sequence := id, activeLease := some lease }, some lease)
  else (s, none)

/-- settle が送出する inactive lease エラー。 -/
inductive LeaseError where
  | inactiveSend | inactiveReconnect
  deriving Repr, DecidableEq, BEq

/-- TS と同じく token、id、両方の kind を照合し、attemptId は照合しない。 -/
def Lifecycle.matches (s : Lifecycle) (lease : Lease) (kind : Kind) : Bool :=
  match s.activeLease with
  | none => false
  | some active => active.token == lease.token && active.id == lease.id &&
      active.kind == kind && lease.kind == kind

/-- send の最終結果。省略された availability と確認指定を区別する。 -/
structure SendOutcome where
  completed : Bool
  failureClass : Option FailureClass := none
  agentAvailable : Option Bool := none
  requiresConfirmation : Option Bool := none
  deriving Repr, DecidableEq, BEq

/-- send lease を解放し、結果と確認 gate を反映する。 -/
def Lifecycle.settleSend (s : Lifecycle) (lease : Lease) (outcome : SendOutcome) : Except LeaseError Lifecycle :=
  if !s.matches lease .send then .error .inactiveSend else
    let s := { s with activeLease := none, available := outcome.agentAvailable.getD s.available }
    if outcome.completed then
      .ok { s with pendingAttemptId := none, lastFailure := none }
    else if outcome.requiresConfirmation != some false then
      .ok { s with pendingAttemptId := some lease.attemptId, lastFailure := outcome.failureClass }
    else .ok { s with lastFailure := outcome.failureClass }

/-- reconnect の成否を availability に反映し、確認 gate は維持する。 -/
def Lifecycle.settleReconnect (s : Lifecycle) (lease : Lease) (succeeded : Bool) : Except LeaseError Lifecycle :=
  if !s.matches lease .reconnect then .error .inactiveReconnect else
    .ok { s with activeLease := none, available := succeeded }

/-- availability の外部報告を反映する。 -/
def Lifecycle.setAgentAvailable (s : Lifecycle) (available : Bool) : Lifecycle :=
  { s with available := available }

/-- lease がなく、確認対象と任意の期待 ID が一致すれば gate を解除する。 -/
def Lifecycle.confirmRecovery (s : Lifecycle) (expected : Option String := none) : Lifecycle × Bool :=
  if s.activeLease.isSome || s.pendingAttemptId.isNone ||
      (expected.isSome && expected != s.pendingAttemptId) then (s, false)
  else ({ s with pendingAttemptId := none }, true)

/-- listener 通知のみの wake は、抽象状態を変更しない。 -/
def Lifecycle.wake (s : Lifecycle) : Lifecycle := s

/-- send を実行する workflow。 -/
inductive Workflow where
  | issue | operatorAgent
  deriving Repr, DecidableEq, BEq

/-- 完了判定に必要な send の status。その他は同じ不完全結果として扱う。 -/
inductive SendStatus where
  | finished | completed | running | other
  deriving Repr, DecidableEq, BEq

/-- snapshot の attempt ID を保持する inbox の抽象状態。 -/
structure Inbox where
  snapshots : List String := []
  deriving Repr, DecidableEq, BEq, Inhabited

/-- 期限切れまたは明示削除された ID を外部から反映する。 -/
def Inbox.remove (inbox : Inbox) (ids : List String) : Inbox :=
  { snapshots := inbox.snapshots.filter (fun id => !ids.contains id) }

/-- snapshot が一件以上残っているかを返す。 -/
def Inbox.hasSnapshot (inbox : Inbox) : Bool := !inbox.snapshots.isEmpty

/-- 共通 settle が inbox に対して行った操作。 -/
inductive InboxEffect where
  | none | releaseAttempted | committed
  deriving Repr, DecidableEq, BEq

/-- 共通 settle の失敗理由。 -/
inductive SettlementError where
  | missingReservation | inputTooLarge | commitRejected | duplicateSnapshot | inactiveLease
  deriving Repr, DecidableEq, BEq

/-- 外部 inbox の結果を含む共通 settle への入力。 -/
structure SettlementInput where
  lease : Lease
  workflow : Workflow
  status : SendStatus
  failureClass : FailureClass
  hasInbox : Bool := false
  hasReservation : Bool := false
  hasOperatorInput : Bool := false
  inputTooLarge : Bool := false
  captureFailure : Bool := true
  commitValid : Bool := true
  expired : List String := []
  agentAvailable : Option Bool := none
  requiresConfirmation : Option Bool := none
  deriving Repr, DecidableEq, BEq

/-- 例外時にも、それ以前に実行された inbox 操作を残す。 -/
structure SettlementResult where
  lifecycle : Lifecycle
  inboxEffect : InboxEffect
  inbox : Inbox
  result : Except SettlementError Bool
  failureClass : Option FailureClass := none
  /-- 正常 return に snapshot summary が含まれるか。保持状態は inbox にある。 -/
  snapshot : Bool := false
  deriving Repr

/-- 共通 settle の inbox 操作と lifecycle 更新を TS の順序で実行する。 -/
def settleConductorDispatch (s : Lifecycle) (i : SettlementInput) (initialInbox : Inbox := {}) : SettlementResult := Id.run do
  let completed := i.status == .finished || i.status == .completed ||
    (i.workflow == .issue && i.status == .running)
  let mut effect := InboxEffect.none
  let mut inbox := initialInbox
  if completed then
    if i.hasInbox && i.hasReservation then effect := .releaseAttempted
  else if i.captureFailure && i.hasOperatorInput then
    if !i.hasInbox || !i.hasReservation then
      return ⟨s, effect, inbox, .error .missingReservation, none, false⟩
    if i.inputTooLarge then return ⟨s, effect, inbox, .error .inputTooLarge, none, false⟩
    if !i.commitValid then return ⟨s, effect, inbox, .error .commitRejected, none, false⟩
    inbox := inbox.remove i.expired
    if inbox.snapshots.contains i.lease.attemptId then
      return ⟨s, effect, inbox, .error .duplicateSnapshot, none, false⟩
    inbox := { snapshots := inbox.snapshots ++ [i.lease.attemptId] }
    effect := .committed
  else if i.hasInbox && i.hasReservation then effect := .releaseAttempted
  let outcome : SendOutcome := if completed then ⟨true, none, none, none⟩ else
    ⟨false, some i.failureClass, i.agentAvailable, i.requiresConfirmation⟩
  match s.settleSend i.lease outcome with
  | .error _ => return ⟨s, effect, inbox, .error .inactiveLease, none, false⟩
  | .ok next => return ⟨next, effect, inbox, .ok completed,
      if completed then none else some i.failureClass, effect == .committed⟩

/-! 代表的な操作列。`decide` は実行可能な定義の結果をカーネルで確認する。 -/

/- 正常な send は lease を解放して再び送信可能になる。 -/
#guard (decide (

    let (s, lease) := ({} : Lifecycle).beginSend 1
    ((s.settleSend lease.get! { completed := true }).toOption.map Lifecycle.canDispatch) = some true
))
#eval (decide (

    let (s, lease) := ({} : Lifecycle).beginSend 1
    ((s.settleSend lease.get! { completed := true }).toOption.map Lifecycle.canDispatch) = some true
))

/- 失敗後は availability と確認待ちが独立し、確認しても直近失敗は残る。 -/
#guard (decide (

    let (s, lease) := ({} : Lifecycle).beginSend 1
    let failed := (s.settleSend lease.get! { completed := false, failureClass := some .transport, agentAvailable := some false }).toOption.get!
    let confirmed := failed.confirmRecovery (some "1")
    (failed.state, failed.confirmationRequired, confirmed.2, confirmed.1.state,
      confirmed.1.lastFailure) = (.unavailable, true, true, .unavailable, some .transport)
))
#eval (decide (

    let (s, lease) := ({} : Lifecycle).beginSend 1
    let failed := (s.settleSend lease.get! { completed := false, failureClass := some .transport, agentAvailable := some false }).toOption.get!
    let confirmed := failed.confirmRecovery (some "1")
    (failed.state, failed.confirmationRequired, confirmed.2, confirmed.1.state,
      confirmed.1.lastFailure) = (.unavailable, true, true, .unavailable, some .transport)
))

/- reconnect の成功は確認 gate を残し、失敗は unavailable にする。 -/
#guard (decide (

    let (s, send) := ({} : Lifecycle).beginSend 1
    let failed := (s.settleSend send.get! { completed := false }).toOption.get!
    let (busy, reconnect) := failed.beginReconnect 2
    let success := (busy.settleReconnect reconnect.get! true).toOption.get!
    let failure := (busy.settleReconnect reconnect.get! false).toOption.get!
    (busy.confirmRecovery none |>.2, success.state, failure.state,
      failure.confirmationRequired) = (false, .attention, .unavailable, true)
))
#eval (decide (

    let (s, send) := ({} : Lifecycle).beginSend 1
    let failed := (s.settleSend send.get! { completed := false }).toOption.get!
    let (busy, reconnect) := failed.beginReconnect 2
    let success := (busy.settleReconnect reconnect.get! true).toOption.get!
    let failure := (busy.settleReconnect reconnect.get! false).toOption.get!
    (busy.confirmRecovery none |>.2, success.state, failure.state,
      failure.confirmationRequired) = (false, .attention, .unavailable, true)
))

/- 不一致の確認と期限切れ lease は状態を変更しない。 -/
#guard (decide (

    let (s, lease) := ({} : Lifecycle).beginSend 1
    let stale := { lease.get! with token := 2 }
    ((s.settleSend stale { completed := true }).toOption.isNone, s.confirmRecovery (some "other") |>.2) =
      (true, false)
))
#eval (decide (

    let (s, lease) := ({} : Lifecycle).beginSend 1
    let stale := { lease.get! with token := 2 }
    ((s.settleSend stale { completed := true }).toOption.isNone, s.confirmRecovery (some "other") |>.2) =
      (true, false)
))

/- Issue の running は完了扱いで、operator-agent では失敗になる。 -/
#guard (decide (

    let (s, lease) := ({} : Lifecycle).beginSend 1
    let i : SettlementInput := { lease := lease.get!, workflow := .issue, status := .running, failureClass := .incompleteStatus }
    ((settleConductorDispatch s i).lifecycle.state,
      (settleConductorDispatch s { i with workflow := .operatorAgent }).lifecycle.state) =
        (.ready, .attention)
))
#eval (decide (

    let (s, lease) := ({} : Lifecycle).beginSend 1
    let i : SettlementInput := { lease := lease.get!, workflow := .issue, status := .running, failureClass := .incompleteStatus }
    ((settleConductorDispatch s i).lifecycle.state,
      (settleConductorDispatch s { i with workflow := .operatorAgent }).lifecycle.state) =
        (.ready, .attention)
))

/- commit 後に lease 照合が失敗しても、先行した inbox 操作は残る。 -/
#guard (decide (

    let (s, lease) := ({} : Lifecycle).beginSend 1
    let i : SettlementInput := { lease := { lease.get! with token := 2 }, workflow := .issue, status := .other, failureClass := .transport, hasInbox := true, hasReservation := true, hasOperatorInput := true }
    let result := settleConductorDispatch s i
    (result.inboxEffect, result.lifecycle.state) = (.committed, .inFlight)
))
#eval (decide (

    let (s, lease) := ({} : Lifecycle).beginSend 1
    let i : SettlementInput := { lease := { lease.get! with token := 2 }, workflow := .issue, status := .other, failureClass := .transport, hasInbox := true, hasReservation := true, hasOperatorInput := true }
    let result := settleConductorDispatch s i
    (result.inboxEffect, result.lifecycle.state) = (.committed, .inFlight)
))

/- 失敗時の snapshot は確認後も、次の send 成功後も inbox に残る。 -/
#guard (decide (
  let (s, lease) := ({} : Lifecycle).beginSend 1
  let failed := settleConductorDispatch s { lease := lease.get!, workflow := .issue, status := .other, failureClass := .transport, hasInbox := true, hasReservation := true, hasOperatorInput := true }
  let (confirmed, ok) := failed.lifecycle.confirmRecovery (some "1")
  let (next, nextLease) := confirmed.beginSend 2
  let completed := settleConductorDispatch next { lease := nextLease.get!, workflow := .issue, status := .completed, failureClass := .transport, hasInbox := true, hasReservation := true } failed.inbox
  (ok, completed.lifecycle.canDispatch, completed.inbox.snapshots) = (true, true, ["1"])
))

/- stale lease による例外後も commit 済み snapshot は次の操作に渡る。 -/
#guard (decide (
  let (s, lease) := ({} : Lifecycle).beginSend 1
  let stale := { lease.get! with token := 2 }
  let failed := settleConductorDispatch s { lease := stale, workflow := .issue, status := .other, failureClass := .transport, hasInbox := true, hasReservation := true, hasOperatorInput := true }
  let completed := settleConductorDispatch failed.lifecycle { lease := lease.get!, workflow := .issue, status := .completed, failureClass := .transport } failed.inbox
  (failed.inbox.hasSnapshot, completed.inbox.snapshots, completed.lifecycle.canDispatch,
    match failed.result with | .error .inactiveLease => true | _ => false) = (true, ["1"], true, true)
))

/- 複数件のうち期限切れだけを prune し、duplicate 例外後も結果を保持する。 -/
#guard (decide (
  let (s, lease) := ({} : Lifecycle).beginSend 1
  let input : SettlementInput := { lease := lease.get!, workflow := .issue, status := .other, failureClass := .transport, hasInbox := true, hasReservation := true, hasOperatorInput := true, expired := ["old"] }
  let failed := settleConductorDispatch s input { snapshots := ["old", "1", "other"] }
  let remaining := failed.inbox.remove ["1"]
  (failed.inbox.snapshots, remaining.hasSnapshot, (remaining.remove ["other"]).hasSnapshot,
    match failed.result with | .error .duplicateSnapshot => true | _ => false) = (["1", "other"], true, false, true)
))

/- commit の予約検証失敗は prune より前なので既存 snapshot を変えない。 -/
#guard (decide (
  let (s, lease) := ({} : Lifecycle).beginSend 1
  let failed := settleConductorDispatch s { lease := lease.get!, workflow := .issue, status := .other, failureClass := .transport, hasInbox := true, hasReservation := true, hasOperatorInput := true, commitValid := false, expired := ["old"] } { snapshots := ["old"] }
  failed.inbox.snapshots = ["old"]
))

/- 初期状態を評価できることを確認する。 -/
#eval ({} : Lifecycle).state

end Ensemble.AsIs.ConductorDispatchLifecycle
