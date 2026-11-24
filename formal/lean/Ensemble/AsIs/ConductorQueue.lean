import Ensemble.AsIs.ConductorDispatchLifecycle

/-!
# 現行 conductor の hold と queue

| TypeScript のファイル | 関数 | Lean の定義 | 対応範囲 |
|---|---|---|---|
| `packages/core/src/conductor/session/dispatch-hold.ts` | `createDispatchHoldState` | `Ensemble.AsIs.ConductorQueue.Hold` | 初期値 |
| `packages/core/src/conductor/session/dispatch-hold.ts` | `bufferDispatchHoldEvents` | `Ensemble.AsIs.ConductorQueue.bufferHold` | 保留対象の移動。通知は省略 |
| `packages/core/src/conductor/session/dispatch-hold.ts` | `pruneStalePermissionEvents` | `Ensemble.AsIs.ConductorQueue.prunePermissions` | queue と held の除去。pending 判定は入力 |
| `packages/core/src/conductor/session/dispatch-hold.ts` | `isHoldableDispatchEvent` | `Ensemble.AsIs.ConductorQueue.holdable` | 保留対象の判定 |
| `packages/core/src/conductor/session/dispatch-hold.ts` | `filterActivePermissionEvents` | `Ensemble.AsIs.ConductorQueue.prunePermissions` | 生存判定と除去 |
| `packages/core/src/dispatch/set-dispatch-hold-tool.ts` | `createSetDispatchHoldTool（execute）` | `Ensemble.AsIs.ConductorQueue.setHold` | hold 切替と解除前の回収。出力・通知は省略 |
| `packages/core/src/conductor/session/session-event-queue.ts` | `enqueue` | `Ensemble.AsIs.ConductorQueue.enqueue` | waiter 不在時の追加。waiter への直接配送は対象外 |
| `packages/core/src/conductor/session/session-event-queue.ts` | `dequeue` | `Ensemble.AsIs.ConductorQueue.dequeue` | 先頭の取り出し |
| `packages/core/src/conductor/session/session-event-queue.ts` | `snapshot` | `Ensemble.AsIs.ConductorQueue.Driver.queue` | 値として queue を保持 |
| `packages/core/src/conductor/session/session-event-queue.ts` | `replaceQueue` | `Ensemble.AsIs.ConductorQueue.replaceQueue` | queue の置換 |
| `packages/core/src/conductor/session/session-event-queue.ts` | `removeEvents` | `Ensemble.AsIs.ConductorQueue.removeEvents` | object identity による除去 |
| `packages/core/src/conductor/session/session-event-queue.ts` | `prependSilent` | `Ensemble.AsIs.ConductorQueue.prependSilent` | 先頭への挿入 |
| `packages/core/src/conductor/session/session-event-queue.ts` | `findSendEvent` | `Ensemble.AsIs.ConductorQueue.findEvent` | 最初の一致を除去 |
| `packages/core/src/conductor/session/session-event-queue.ts` | `findSendEvents` | `Ensemble.AsIs.ConductorQueue.findEvents` | 全一致を除去 |
| `packages/core/src/conductor/session/session-event-queue.ts` | `waitForMatchingEvent` | `Ensemble.AsIs.ConductorQueue.findEvent` | queue 内の検索のみ。非同期待機は対象外 |
| `packages/core/src/conductor/session/select-dispatch-batch.ts` | `eventSourceKey` | `Ensemble.AsIs.ConductorQueue.source` | source の分類 |
| `packages/core/src/conductor/session/select-dispatch-batch.ts` | `staticEventPriority` | `Ensemble.AsIs.ConductorQueue.priority` | event ごとの静的優先度 |
| `packages/core/src/conductor/session/select-dispatch-batch.ts` | `isDispatchable` | `Ensemble.AsIs.ConductorQueue.eligible` | dispatch 可否 |
| `packages/core/src/conductor/session/select-dispatch-batch.ts` | `pickStaticSourceKey` | `Ensemble.AsIs.ConductorQueue.staticSource` | source ごとの優先度と到着順 |
| `packages/core/src/conductor/session/select-dispatch-batch.ts` | `canUseWorkerContinuation` | `Ensemble.AsIs.ConductorQueue.selectBatch` | worker continuation の選択条件 |
| `packages/core/src/conductor/session/select-dispatch-batch.ts` | `selectDispatchBatch` | `Ensemble.AsIs.ConductorQueue.selectBatch` | source 選択と束の構築 |
| `packages/core/src/conductor/session/select-dispatch-batch.ts` | `selectDispatchBatch` | `Ensemble.AsIs.ConductorQueue.boundOperator` | operator 束の byte 上限 |
| `packages/core/src/conductor/session/select-dispatch-batch.ts` | `dispatchBatchStateAfterSend` | `Ensemble.AsIs.ConductorQueue.afterSend` | 送信後の状態 |
| `packages/core/src/conductor/session/select-dispatch-batch.ts` | `markContinuationConsumed` | `Ensemble.AsIs.ConductorQueue.consumeContinuation` | continuation の消費 |
| `packages/core/src/conductor/session/dispatch-mode.ts` | `sessionEventDispatchMode` | `Ensemble.AsIs.ConductorQueue.Event.mode` | mode は明示入力 |
| `packages/core/src/conductor/session/dispatch-mode.ts` | `isTriggerSessionEvent` | `Ensemble.AsIs.ConductorQueue.isTrigger` | trigger の判定 |
| `packages/core/src/conductor/session-policy.ts` | `canDispatchConductorSend` | `Ensemble.AsIs.ConductorQueue.canSend` | max-turns の判定 |
| `packages/core/src/conductor/conductor-session-driver.ts` | `canDispatchIdleOperatorMessage` | `Ensemble.AsIs.ConductorQueue.allowIdle` | idle operator の可否 |
| `packages/core/src/conductor/conductor-session-driver.ts` | `isImmediateDispatchSource` | `Ensemble.AsIs.ConductorQueue.immediate` | 即時優先 source の判定 |
| `packages/core/src/conductor/conductor-session-driver.ts` | `waitForDispatchBatch` | `Ensemble.AsIs.ConductorQueue.chooseDispatch` | 同期的な queue / held 選択。待機・通知・予約処理の内部は省略 |
| `packages/core/src/conductor/conductor-session-driver.ts` | `runConductorSessionDriver` | `Ensemble.AsIs.ConductorQueue.beginDispatch` | send / reconnect の lease 取得と選択 event の除去 |
| `packages/core/src/conductor/conductor-session-driver.ts` | `runConductorSessionDriver` | `Ensemble.AsIs.ConductorQueue.recordSend` | send 開始後の batch 状態更新 |
| `packages/core/src/conductor/conductor-session-driver.ts` | `runConductorSessionDriver` | `Ensemble.AsIs.ConductorQueue.settleReconnect` | reconnect 結果と後着分の除去 |
| `packages/core/src/conductor/conductor-session-driver.ts` | `runOperatorReconnect` | `Ensemble.AsIs.ConductorQueue.settleReconnect` | 外部入力の成否を lifecycle に反映。実接続は対象外 |
| `packages/core/src/conductor/session/dispatch-hold-reminder-monitor.ts` | `createDispatchHoldReminderMonitor` | — | 通知のみで dispatch 状態を変えないため対象外 |

queue の要素 ID は TS の object identity に対応する。同じ ID は同じ event object を表す必要がある。operator の入力は UTF-8 byte 数を保持し、表示内容や payload は省略する。pending の生存集合、予約の可否、停止信号、reconnect の成否、実行中 worker 数と lease token は外部から与える。負の max-turns は 0 に正規化し、負の byte 上限は `none` で表す。byte 上限の未指定には既定値 1048576 を使う。通知、timer、非同期 waiter、例外および recovery inbox の内部は扱わない。waiter に配送される到着は呼び出し側が別途表現する。reminder は operator への通知だけで dispatch 状態を変更しないため対象外とする。選択後に queue に追加された event は `removeEvents` で維持する。
-/
namespace Ensemble.AsIs.ConductorQueue
open Ensemble.AsIs.ConductorDispatchLifecycle

/-- 振る舞いに関係する event 種別。 -/
inductive EventKind where
  | operator | reconnect | permission | stall | workerCompleted | workerFailed
  | workerRecovered | github | connectivity | recoveryReport
  deriving Repr, BEq, DecidableEq
/-- dispatch mode。 -/
inductive Mode where
  | trigger | inform | telemetry
  deriving Repr, BEq, DecidableEq
/-- 同一性と選択に必要な event 属性。 -/
structure Event where
  id : Nat
  kind : EventKind
  name : String := ""
  mode : Mode := .trigger
  idle : Bool := false
  bytes : Nat := 0
  deriving Repr, BEq, DecidableEq
/-- dispatch の source。 -/
inductive Source where
  | operator | reconnect | permission | stall | worker (name : String) | github | recoveryReport | held
  deriving Repr, BEq, DecidableEq
/-- event の source key。 -/
def source (e : Event) : Source :=
  match e.kind with
  | .operator => .operator | .reconnect => .reconnect | .permission => .permission
  | .stall => .stall | .workerCompleted | .workerFailed | .workerRecovered => .worker e.name
  | .github | .connectivity => .github | .recoveryReport => .recoveryReport
/-- 単独で dispatch を起こせるか。 -/
def isTrigger (e : Event) : Bool := e.mode == .trigger
/-- 自律ターン上限下でも送信可能か。0 は無制限。 -/
def canSend (e : Event) (turns maxTurns : Nat) : Bool :=
  e.kind == .operator || e.kind == .reconnect || e.kind == .permission ||
  e.kind == .stall || e.kind == .recoveryReport || maxTurns == 0 || turns < maxTurns
/-- queue 末尾に追加する。 -/
def enqueue (q : List Event) (e : Event) : List Event := q ++ [e]
/-- queue 先頭を取り出す。 -/
def dequeue (q : List Event) : Option Event × List Event :=
  match q with | [] => (none, []) | e :: rest => (some e, rest)
/-- queue を置換する。 -/
def replaceQueue (_q next : List Event) : List Event := next
/-- object identity が一致する event をすべて除去する。 -/
def removeEvents (q selected : List Event) : List Event :=
  q.filter fun e => !(selected.any fun s => s.id == e.id)
/-- waiter を起こさず先頭へ戻す。 -/
def prependSilent (q : List Event) (e : Event) : List Event := e :: q
/-- 最初に条件を満たす event を取り出す。 -/
def findEvent (q : List Event) (p : Event → Bool) : Option Event × List Event :=
  match q with
  | [] => (none, [])
  | e :: rest => if p e then (some e, rest) else
      let (found, remaining) := findEvent rest p
      (found, e :: remaining)
/-- 条件を満たすすべての event を順に取り出す。 -/
def findEvents (q : List Event) (p : Event → Bool) : List Event × List Event :=
  (q.filter p, q.filter fun e => !p e)
/-- hold と到着順の保留 event。 -/
structure Hold where
  active : Bool := false
  held : List Event := []
  deriving Repr, BEq, DecidableEq
/-- hold に移す event の判定。 -/
def holdable (e : Event) : Bool :=
  e.kind == .connectivity || (isTrigger e && e.kind != .operator &&
    e.kind != .reconnect && e.kind != .stall)
/-- hold 中の対象を queue から保留領域へ移す。 -/
def bufferHold (h : Hold) (q : List Event) : Hold × List Event :=
  if h.active then
    let held := q.filter holdable
    ({ h with held := h.held ++ held }, removeEvents q held)
  else (h, q)
/-- pending 集合に存在しない permission を両方から除く。 -/
def prunePermissions (h : Hold) (q : List Event) (pending : List String) : Hold × List Event :=
  let keep := fun e : Event => e.kind != .permission || pending.contains e.name
  ({ h with held := h.held.filter keep }, q.filter keep)
/-- 解除前に queue を回収してから hold を切り替える。 -/
def setHold (h : Hold) (q : List Event) (active : Bool) : Hold × List Event :=
  if active then ({ h with active := true }, q) else
    let (h, q) := bufferHold h q
    ({ h with active := false }, q)
/-- 前回 source と continuation の消費状態。 -/
structure BatchState where
  last : Option Source := none
  consumed : Bool := false
  deriving Repr, BEq, DecidableEq
/-- 一度の dispatch に選ばれた event と source。 -/
structure Batch where
  events : List Event
  source : Source
  deriving Repr, BEq, DecidableEq
/-- 送信後、次の worker continuation を有効にする。 -/
def afterSend (s : Source) : BatchState := ⟨some s, false⟩
/-- 選択した worker continuation の消費を記録する。 -/
def consumeContinuation (s : BatchState) (b : Batch) : BatchState :=
  match s.last with
  | some (.worker n) => if !s.consumed && b.source == .worker n then { s with consumed := true } else s
  | _ => s
/-- 静的優先度。source 内では最小値を使う。 -/
def priority (e : Event) : Nat :=
  match e.kind with
  | .operator => 0 | .permission | .reconnect | .recoveryReport => 1
  | .workerFailed | .workerRecovered => 2 | .workerCompleted => 3
  | .github => 4 | .stall => 5 | .connectivity => 6
/-- 指定条件で batch の主体になれるか。 -/
def eligible (e : Event) (turns maxTurns : Nat) (idleAllowed : Bool) : Bool :=
  (e.kind != .operator || !e.idle || idleAllowed) && isTrigger e && canSend e turns maxTurns
/-- operator batch を先頭から byte 上限まで取る。 -/
def boundOperator (events : List Event) (limit : Nat) (used : Nat := 0) : List Event :=
  match events with
  | [] => []
  | e :: rest => if e.kind != .operator || e.bytes > limit || used + e.bytes > limit then []
      else e :: boundOperator rest limit (used + e.bytes)
/-- source ごとの最小優先度と最初の位置で静的 source を選ぶ。 -/
def staticSource (es : List Event) : Option Source := Id.run do
  let mut best : Option (Source × Nat) := none
  for e in es do
    let key := source e
    let p := (es.filter (fun x => source x == key)).foldl (fun n x => min n (priority x)) (priority e)
    match best with
    | none => best := some (key, p)
    | some (_, old) => if p < old then best := some (key, p)
  return best.map Prod.fst
/-- 選択結果と残りの queue。 -/
structure Selection where
  batch : Batch
  remaining : List Event
  deriving Repr, BEq, DecidableEq
/-- 現行の優先順位、同梱、operator byte 上限に従って選択する。 -/
def selectBatch (q : List Event) (s : BatchState) (turns maxTurns : Nat)
    (idleAllowed : Bool := true) (byteLimit : Option Nat := some 1048576) : Option Selection := do
  let es := q.filter fun e => eligible e turns maxTurns idleAllowed
  if es.isEmpty then none else
    let keys := es.map source
    let chosen ← if keys.contains .operator then some .operator
      else if keys.contains .permission then some .permission
      else match s.last with
        | some (.worker n) => if !s.consumed && keys.contains (.worker n) then some (.worker n) else staticSource es
        | _ => staticSource es
    let batch := q.filter fun e => source e == chosen &&
      (eligible e turns maxTurns idleAllowed || (e.mode == .inform && canSend e turns maxTurns))
    let batch := if chosen == .operator then match byteLimit with
      | some n => boundOperator batch n
      | none => batch
      else batch
    if batch.isEmpty then none else some ⟨⟨batch, chosen⟩, removeEvents q batch⟩
/-- hold、queue、lifecycle の組み合わせ。 -/
structure Driver where
  hold : Hold := {}
  queue : List Event := []
  batchState : BatchState := {}
  lifecycle : Lifecycle := {}
  deriving Repr
/-- 通常 queue の選択か held の選択かを記録する。 -/
structure Dispatch where
  batch : Batch
  fromHeld : Bool := false
  selected : Bool := false
  deriving Repr
/-- idle 入力の許可を driver の条件から計算する。 -/
def allowIdle (d : Driver) (running turns maxTurns : Nat) : Bool :=
  if running > 0 then false else
    let held := d.hold.held
    let heldReady := !d.hold.active && !held.isEmpty &&
      (held.all (fun e => canSend e turns maxTurns) || (selectBatch held d.batchState turns maxTurns true).isSome)
    let others := d.queue.filter fun e => e.kind != .operator && e.kind != .reconnect
    !heldReady && (selectBatch others d.batchState turns maxTurns true).isNone
/-- 即時優先 source。 -/
def immediate (s : Source) : Bool := s == .operator || s == .reconnect || s == .permission
/-- 一回の同期選択。予約失敗は選択を返さない。 -/
def chooseDispatch (d : Driver) (turns maxTurns running : Nat) (pending : Option (List String))
    (byteLimit : Option Nat) (reservationOk : Bool) : Driver × Option Dispatch := Id.run do
  if !d.lifecycle.canDispatch then
    let rs := d.queue.filter fun e => e.kind == .reconnect
    return (d, if rs.isEmpty then none else some ⟨⟨rs, .reconnect⟩, false, false⟩)
  let (h, q) := bufferHold d.hold d.queue
  let (h, q) := match pending with | none => (h, q) | some ps => prunePermissions h q ps
  let d := { d with hold := h, queue := q }
  let sel := selectBatch q d.batchState turns maxTurns (allowIdle d running turns maxTurns) byteLimit
  if let some s := sel then
    if immediate s.batch.source then
      return (d, if reservationOk then some ⟨s.batch, false, true⟩ else none)
  if !h.active && !h.held.isEmpty then
    let all := h.held.all fun e => canSend e turns maxTurns
    let hs := if all then some (Selection.mk ⟨h.held, .held⟩ []) else selectBatch h.held d.batchState turns maxTurns true
    if let some s := hs then
      return (d, if reservationOk then some ⟨s.batch, true, !all⟩ else none)
  return (d, if reservationOk then sel.map fun s => ⟨s.batch, false, true⟩ else none)
/-- lease を取得できたときだけ選択済み event を除去する。 -/
def beginDispatch (d : Driver) (dispatch : Dispatch) (token : Nat) : Driver × Option Lease :=
  let reconnect := dispatch.batch.source == .reconnect
  let (lifecycle, lease) := if reconnect then d.lifecycle.beginReconnect token else d.lifecycle.beginSend token
  if lease.isNone then (d, none) else
    let d := { d with lifecycle := lifecycle }
    let d := if dispatch.fromHeld then { d with hold := { d.hold with held := removeEvents d.hold.held dispatch.batch.events } }
      else { d with queue := removeEvents d.queue dispatch.batch.events }
    let state := if dispatch.selected then consumeContinuation d.batchState dispatch.batch else d.batchState
    ({ d with batchState := if reconnect then afterSend .reconnect else state }, lease)
/-- send 開始後、Driver が次の continuation を設定する。 -/
def recordSend (d : Driver) (dispatch : Dispatch) : Driver :=
  { d with batchState := afterSend dispatch.batch.source }
/-- reconnect を settle し、成功かつ未中断なら待機中の重複も取り除く。 -/
def settleReconnect (d : Driver) (lease : Lease) (success aborted : Bool) : Except LeaseError Driver := do
  let lifecycle ← d.lifecycle.settleReconnect lease success
  let queue := if success && !aborted then d.queue.filter (fun e => e.kind != .reconnect) else d.queue
  pure { d with lifecycle := lifecycle, queue := queue }

/- hold 中の pending は保留され、stall は選択される。解除後は全件を一束にする。 -/
#guard (decide (
  let p : Event := { id := 1, kind := .permission, name := "p" }
  let w : Event := { id := 2, kind := .workerCompleted, name := "w" }
  let stall : Event := { id := 3, kind := .stall }
  let d : Driver := { hold := { active := true }, queue := [p, w, stall] }
  let (d, chosen) := chooseDispatch d 0 5 0 none (some 1048576) true
  let (released, q) := setHold d.hold d.queue false
  let (_, next) := chooseDispatch { d with hold := released, queue := q.filter (fun e => e.id != 3) } 0 5 0 none (some 1048576) true
  (d.hold.held.map Event.id, chosen.map (fun x => x.batch.source), next.map (fun x => x.batch.events.map Event.id)) =
    ([1, 2], some .stall, some [1, 2])
))
/- 上限到達後は保留された permission だけを選び worker は残る。 -/
#guard (decide (
  let p : Event := { id := 1, kind := .permission, name := "p" }
  let w : Event := { id := 2, kind := .workerCompleted, name := "w" }
  let d : Driver := { hold := { held := [w, p] } }
  let (_, result) := chooseDispatch d 2 2 0 none (some 1048576) true
  result.map (fun x => (x.batch.source, x.batch.events.map Event.id)) = some (.permission, [1])
))
/- operator、permission、worker continuation、静的優先の順に選択する。 -/
#guard (decide (
  let w : Event := { id := 1, kind := .workerCompleted, name := "w" }
  let p : Event := { id := 2, kind := .permission }
  let o : Event := { id := 3, kind := .operator }
  let f : Event := { id := 4, kind := .workerFailed, name := "other" }
  let state := afterSend (.worker "w")
  ((selectBatch [w, p, o] state 0 0).map (fun s => s.batch.source),
   (selectBatch [w, p] state 0 0).map (fun s => s.batch.source),
   (selectBatch [f, w] state 0 0).map (fun s => s.batch.source),
   (selectBatch [f, w] { state with consumed := true } 0 0).map (fun s => s.batch.source)) =
   (some .operator, some .permission, some (.worker "w"), some (.worker "other"))
))
/- reconnect 成功は後着 reconnect を除去し、失敗は保持する。 -/
#guard (decide (
  let r : Event := { id := 1, kind := .reconnect }
  let r2 : Event := { id := 2, kind := .reconnect }
  let d : Driver := { lifecycle := { available := false }, queue := [r] }
  let (_, picked) := chooseDispatch d 0 0 0 none (some 1048576) true
  let (busy, lease) := beginDispatch d (picked.getD ⟨⟨[], .reconnect⟩, false, false⟩) 1
  let busy := { busy with queue := [r2] }
  let ok := (settleReconnect busy lease.get! true false).toOption.getD busy
  let bad := (settleReconnect busy lease.get! false false).toOption.getD busy
  (ok.queue.length, ok.lifecycle.available, bad.queue.length, bad.lifecycle.available) = (0, true, 1, false)
))

/- 解除直前の queue を回収し、後着 inform と stale permission も処理する。 -/
#guard (decide (
  let pending : Event := { id := 1, kind := .permission, name := "old" }
  let inform : Event := { id := 2, kind := .connectivity, mode := .inform }
  let (h, q) := setHold { active := true } [pending, inform] false
  let (h, q) := prunePermissions h q []
  (h.active, h.held.map Event.id, q.length) = (false, [2], 0)
))
/- 即時 source は解除済み held に優先し、通常 event は後回しになる。 -/
#guard (decide (
  let w : Event := { id := 1, kind := .workerCompleted, name := "w" }
  let p : Event := { id := 2, kind := .permission }
  let g : Event := { id := 3, kind := .github }
  let d : Driver := { hold := { held := [w] }, queue := [g, p] }
  let (_, selected) := chooseDispatch d 0 0 0 none (some 1048576) true
  let (_, held) := chooseDispatch { d with queue := [g] } 0 0 0 none (some 1048576) true
  (selected.map (fun x => x.batch.source), held.map (fun x => x.batch.source)) = (some .permission, some .held)
))
/- 取得できない lease は選択された reconnect を消費しない。 -/
#guard (decide (
  let r : Event := { id := 1, kind := .reconnect }
  let (l, _) := ({} : Lifecycle).beginSend 1
  let d : Driver := { lifecycle := l, queue := [r] }
  let (_, selected) := chooseDispatch d 0 0 0 none (some 1048576) true
  let (d, lease) := beginDispatch d (selected.getD ⟨⟨[], .reconnect⟩, false, false⟩) 2
  (d.queue.map Event.id, lease.isNone) = ([1], true)
))
/- 同一 source の inform を同梱し、operator 入力は byte 上限で分割する。 -/
#guard (decide (
  let g : Event := { id := 1, kind := .github }
  let i : Event := { id := 2, kind := .connectivity, mode := .inform }
  let a : Event := { id := 3, kind := .operator, bytes := 3 }
  let b : Event := { id := 4, kind := .operator, bytes := 3 }
  ((selectBatch [i, g] {} 0 0).map (fun s => s.batch.events.map Event.id),
   (selectBatch [a, b] {} 0 0 true (some 5)).map (fun s => s.batch.events.map Event.id)) = (some [2, 1], some [3])
))

/- 代表操作列の結果を出力する。 -/
#eval (Id.run do
  let p : Event := { id := 1, kind := .permission, name := "p" }
  let stall : Event := { id := 2, kind := .stall }
  let d : Driver := { hold := { active := true }, queue := [p, stall] }
  let (d, chosen) := chooseDispatch d 0 5 0 none (some 1048576) true
  let (h, q) := setHold d.hold [] false
  let (_, released) := chooseDispatch { d with hold := h, queue := q } 0 5 0 none (some 1048576) true
  return (chosen.map (fun x => x.batch.source), released.map (fun x => x.batch.source)))

/- reconnect 成功後の状態と、上限到達後の保留選択を評価する。 -/
#eval (Id.run do
  let r : Event := { id := 1, kind := .reconnect }
  let w : Event := { id := 2, kind := .workerCompleted, name := "w" }
  let p : Event := { id := 3, kind := .permission }
  let d : Driver := { lifecycle := { available := false }, queue := [r], hold := { held := [w, p] } }
  let (_, selected) := chooseDispatch d 2 2 0 none (some 1048576) true
  let (busy, lease) := beginDispatch d (selected.getD ⟨⟨[], .reconnect⟩, false, false⟩) 1
  let ready := (settleReconnect busy lease.get! true false).toOption.getD busy
  let (_, held) := chooseDispatch ready 2 2 0 none (some 1048576) true
  return (ready.lifecycle.state, held.map (fun x => x.batch.source)))

end Ensemble.AsIs.ConductorQueue
