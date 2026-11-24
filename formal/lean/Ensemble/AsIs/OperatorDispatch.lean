import Ensemble.AsIs.ConductorDispatchLifecycle

/-!
# operator-agent の hold と send・ack・reconnect

対応表と抽象化の境界は `OperatorDispatch.md` を参照する。
-/

namespace Ensemble.AsIs.OperatorDispatch

open Ensemble.AsIs.ConductorDispatchLifecycle

/-- 送信元と順序を区別する queue イベント。 -/
structure Event where
  id : Nat
  user : Bool
  arrival : Nat := 0
  arrivalOrder : Option Nat := none
  readyAt : Nat := 0
  firstQueuedAt : Option Nat := none
  eligibleAt : Option Nat := none
  batchReadyAt : Option Nat := none
  bytes : Nat := 0
  question : Bool := false
  priority : Nat := 1
  weight : Nat := 1
  session : String := ""
  reportId : Option String := none
  retryReadyAt : Option Nat := none
  frozenBatchId : Option String := none
  frozenPayload : Option String := none
  deriving Repr, BEq, DecidableEq, Inhabited

/-- JavaScript の truthiness に合わせ、空の report ID は未指定として扱う。 -/
def Event.usableReportId (event : Event) : Option String :=
  event.reportId.filter (fun id => !id.isEmpty)

/-- 手動と会話の hold を独立に保持する queue。 -/
structure Queue where
  pending : List Event := []
  held : List Event := []
  conversationHold : Bool := false
  reportHold : Bool := false
  inFlight : List String := []
  retryById : List (String × Nat) := []
  requested : List (String × List String) := []
  readyHeads : List Nat := []
  nextIdentity : Nat := 0
  deriving Repr, BEq, DecidableEq, Inhabited

/-- どちらかの hold が有効なら report を保留する。 -/
def Queue.isHeld (q : Queue) : Bool := q.conversationHold || q.reportHold

/-- hold の論理和が変化した場合だけ report を移動する。 -/
def Queue.updateHold (q : Queue) (previous : Bool) : Queue × Nat :=
  if previous == q.isHeld then (q, 0)
  else if q.isHeld then
    ({ q with held := q.held ++ q.pending.filter (fun e => !e.user), pending := q.pending.filter (·.user) }, 0)
  else
    ({ q with pending := (q.pending ++ q.held).mergeSort (fun a b => a.arrival <= b.arrival), held := [] }, q.held.length)

/-- 会話 hold を設定する。 -/
def Queue.setConversationHold (q : Queue) (value : Bool) : Queue × Nat :=
  ({ q with conversationHold := value }).updateHold q.isHeld

/-- 手動 hold を設定する。 -/
def Queue.setHold (q : Queue) (value : Bool) : Queue × Nat :=
  ({ q with reportHold := value }).updateHold q.isHeld

/-- 受理された通常入力を追加して会話 hold を設定する。 -/
def Queue.submitUser (q : Queue) (event : Event) : Queue :=
  ({ q with pending := q.pending ++ [{ event with user := true }], nextIdentity := max q.nextIdentity (event.id + 1) }).setConversationHold true |>.1

/-- 正規化後の空判定と UTF-8 byte 数を受け、上限内なら user を追加する。 -/
def Queue.enqueueUser (q : Queue) (event : Event) (nonblank : Bool) (limit : Nat) : Queue × Bool :=
  if !nonblank || event.bytes > limit then (q, false)
  else ({ q with pending := q.pending ++ [{ event with user := true, readyAt := 0 }], nextIdentity := max q.nextIdentity (event.id + 1) }, true)

/-- TTY の通常入力は受理された場合だけ会話 hold を有効にする。 -/
def Queue.handleUser (q : Queue) (event : Event) (nonblank : Bool) (limit : Nat) : Queue × Bool :=
  let (q, accepted) := q.enqueueUser event nonblank limit
  if accepted then ((q.setConversationHold true).1, true) else (q, false)

/-- user の requeue は新しい arrival と現在時刻を使う。 -/
def Queue.requeueUser (q : Queue) (event : Event) (newId arrival now : Nat) : Queue :=
  { q with pending := q.pending ++ [{ event with id := newId, arrival, readyAt := now }], nextIdentity := max q.nextIdentity (newId + 1) }

/-- report を現在の hold 状態に従って追加する。 -/
def Queue.enqueueRaw (q : Queue) (event : Event) : Queue :=
  let event := { event with user := false }
  if q.isHeld then { q with held := q.held ++ [event], nextIdentity := max q.nextIdentity (event.id + 1) }
  else { q with pending := q.pending ++ [event], nextIdentity := max q.nextIdentity (event.id + 1) }

/-- `/resume-watch` は会話 hold だけを解除する。 -/
def Queue.resumeWatch (q : Queue) : Queue × Nat := q.setConversationHold false

/-- retry は report の到着順と凍結情報を保ち、明示時刻から期限を設定する。 -/
def Queue.requeueReport (q : Queue) (event : Event) (now delay : Nat) : Queue :=
  let event := { event with retryReadyAt := some (now + delay) }
  let inFlight := q.inFlight.filter (fun id => some id != event.usableReportId)
  let update := fun e => if event.usableReportId.isSome && e.usableReportId == event.usableReportId && !e.user then
    { e with retryReadyAt := event.retryReadyAt } else e
  let alreadyQueued := (q.pending ++ q.held).any (fun e => event.usableReportId.isSome && e.usableReportId == event.usableReportId && !e.user)
  let retryById := match event.usableReportId with
    | none => q.retryById
    | some id => q.retryById.filter (fun x => x.1 != id) ++ [(id, now + delay)]
  let fresh := (q.pending ++ q.held).foldl (fun n e => max n (e.id + 1)) (max q.nextIdentity (event.id + 1))
  let fresh := q.readyHeads.foldl (fun n id => max n (id + 1)) fresh
  let event := { event with id := fresh, arrivalOrder := some (event.arrivalOrder.getD event.arrival) }
  let q := { q with inFlight, retryById, pending := q.pending.map update, held := q.held.map update }
  if alreadyQueued then q else if q.isHeld then { q with nextIdentity := fresh + 1, held := (q.held ++ [event]).mergeSort (fun a b => (a.arrivalOrder.getD a.arrival < b.arrivalOrder.getD b.arrival) || (a.arrivalOrder.getD a.arrival == b.arrivalOrder.getD b.arrival && a.arrival <= b.arrival)) }
  else { q with nextIdentity := fresh + 1, pending := (q.pending ++ [event]).mergeSort (fun a b => (a.arrivalOrder.getD a.arrival < b.arrivalOrder.getD b.arrival) || (a.arrivalOrder.getD a.arrival == b.arrivalOrder.getD b.arrival && a.arrival <= b.arrival)) }

/-- commit 対象の report に外部供給された batch ID と payload を凍結する。 -/
def freezeReports (events : List Event) (batchId payload : String) : List Event :=
  events.map (fun e => { e with frozenBatchId := some batchId, frozenPayload := some payload })

/-- 同じ frozen batch の retry は全メンバーの期限が到来してから選択できる。 -/
def frozenReady (events : List Event) (now : Nat) : Bool :=
  events.all (fun e => e.retryReadyAt.getD 0 <= now)

/-- TS の report request は report ID があれば ID、なければ arrival を key とする。 -/
def Event.requestKey (e : Event) : String :=
  match e.usableReportId with | some id => "id:" ++ id | none => "arrival:" ++ toString e.arrival

/-- 同一 session の pending と held の report を request に追加する。 -/
def Queue.requestReports (q : Queue) (session : String) : Queue × Bool :=
  let session := session.trimAscii.toString
  let reports := (q.pending ++ q.held).filter (fun e => !e.user && e.session == session)
  if session.isEmpty || reports.isEmpty then (q, false) else
    let old := ((q.requested.find? (fun p => p.1 == session)).map (·.2)).getD []
    let keys := reports.foldl (fun acc e => if acc.contains e.requestKey then acc else acc ++ [e.requestKey]) old
    ({ q with requested := q.requested.filter (fun p => p.1 != session) ++ [(session, keys)] }, true)

/-- ack 成功した report の key だけ request から除く。 -/
def Queue.completeReportRequest (q : Queue) (events : List Event) : Queue :=
  { q with requested := q.requested.filterMap fun (session, keys) =>
    let keys := keys.filter (fun key => !(events.any (fun e => !e.user && e.session == session && e.requestKey == key)))
    if keys.isEmpty then none else some (session, keys) }

/-- ack 済み report ID を pending、held、request、in-flight と retry index から除く。 -/
def Queue.discardReports (q : Queue) (ids : List String) : Queue :=
  let keep := fun e => e.user || !e.reportId.any (fun id => ids.contains id)
  let requested := q.requested.filterMap fun (session, keys) =>
    let keys := keys.filter (fun key => !(ids.any (fun id => key == "id:" ++ id)))
    if keys.isEmpty then none else some (session, keys)
  { q with pending := q.pending.filter keep, held := q.held.filter keep, requested, inFlight := q.inFlight.filter (fun id => !ids.contains id), retryById := q.retryById.filter (fun p => !ids.contains p.1) }

/-- 選択と commit の間でも維持する batch。 -/
structure Batch where
  session : Option String
  events : List Event
  usedContinuation : Bool := false
  priority : Nat := 1
  batchId : Option String := none
  payload : Option String := none
  deriving Repr, BEq, DecidableEq, Inhabited

/-- 選択時の前回送信元と focus。 -/
structure SelectionState where
  lastSession : Option String := none
  continuationConsumed : Bool := false
  focus : Option String := none
  deriving Repr, BEq, DecidableEq, Inhabited

/-- scheduling に必要な設定値。 -/
structure Scheduling where
  maxWait : Nat
  idleAging : Nat
  maxUserBytes : Nat
  threshold : Option Nat := none
  deriving Repr, BEq, DecidableEq, Inhabited

/-- user は arrival、report は arrivalOrder を優先する。 -/
def Event.order (e : Event) : Nat := if e.user then e.arrival else e.arrivalOrder.getD e.arrival

/-- arrivalOrder と arrival の順で並べる。 -/
def orderEvents (events : List Event) : List Event :=
  events.mergeSort (fun a b => a.order < b.order || (a.order == b.order && a.arrival <= b.arrival))

/-- 非凍結 report 群の quiet・cap・保存済み deadline の最小値。 -/
def deadline (events : List Event) (maxWait : Nat) : Nat :=
  let quiet := events.foldl (fun n e => max n e.readyAt) 0
  let cap := events.foldl (fun n e => min n (e.firstQueuedAt.getD e.readyAt + maxWait)) quiet
  events.foldl (fun n e => min n (e.batchReadyAt.getD n)) cap

/-- report の ID が既に queue または in-flight に存在するか。 -/
def Queue.hasReport (q : Queue) (id : String) : Bool :=
  q.inFlight.contains id || (q.pending ++ q.held).any (fun e => !e.user && e.reportId == some id)

/-- 追加前に deadline を通過済みの session head を保持する。 -/
def Queue.latchBeforeEnqueue (q : Queue) (events : List Event) (now maxWait : Nat) : Queue :=
  let sessions := events.map (·.session)
  sessions.foldl (fun q session =>
    let reports := orderEvents ((q.pending ++ q.held).filter (fun e => !e.user && e.frozenBatchId.isNone && e.session == session))
    match reports.head? with
    | none => q
    | some first => if deadline reports maxWait <= now && !q.readyHeads.contains first.id then
        { q with readyHeads := q.readyHeads ++ [first.id] } else q) q

/-- report 群を重複 ID を除いて追加し、debounce の時刻を明示入力から設定する。 -/
def Queue.enqueueReports (q : Queue) (events : List Event) (now delay maxWait : Nat) : Queue :=
  let q := q.latchBeforeEnqueue events now maxWait
  events.foldl (fun q event =>
    if event.usableReportId.any q.hasReport then q else
      let event := { event with user := false, readyAt := now + delay, firstQueuedAt := some (event.firstQueuedAt.getD now), arrivalOrder := some (event.arrivalOrder.getD event.arrival), eligibleAt := if event.priority == 2 then some now else event.eligibleAt }
      q.enqueueRaw event) q

/-- 一件の report を同じ規則で追加する。 -/
def Queue.enqueueReport (q : Queue) (event : Event) (now delay maxWait : Nat) : Queue :=
  q.enqueueReports [event] now delay maxWait

/-- threshold に達した report の firstQueuedAt を返す。 -/
def thresholdTime (events : List Event) (threshold now : Nat) : Option Nat := Id.run do
  let mut weight := 0
  for event in events do
    if event.frozenBatchId.isSome then break
    weight := weight + event.weight
    if weight >= threshold then return some (event.firstQueuedAt.getD now)
  return none

/-- session ごとの選択候補。priority は OQ=0、normal=1、idle=2。 -/
structure Candidate where
  session : String
  events : List Event
  priority : Nat
  question : Bool
  aged : Bool
  deriving Repr, BEq, Inhabited

/-- session の先頭で frozen 群を選び、threshold と deadline を判定する。 -/
def Queue.candidate (q : Queue) (cfg : Scheduling) (state : SelectionState) (now : Nat) (events : List Event) (alreadyReady : Option Batch := none) : Queue × Option Candidate := Id.run do
  let some first := events.head? | return (q, none)
  let frozen := first.frozenBatchId
  let members := events.filter (fun e => if frozen.isSome then e.frozenBatchId == frozen else e.frozenBatchId.isNone)
  let requested := q.requested.any (fun x => x.1 == first.session)
  let mut q := q
  let eligible := match cfg.threshold with
    | none => true
    | some threshold =>
      if requested then true else if state.focus.isSome then false else if frozen.isSome then true else
        match thresholdTime events threshold now with
        | none => false
        | some reached => min (events.foldl (fun n e => max n e.readyAt) 0) (reached + cfg.maxWait) <= now
  if !eligible then return (q, none)
  if cfg.threshold.isSome && frozen.isNone && !q.readyHeads.contains first.id then
    q := { q with readyHeads := q.readyHeads ++ [first.id] }
  let ready := if frozen.isSome then members.foldl (fun n e => max n (e.retryReadyAt.getD 0)) 0 else deadline members cfg.maxWait
  let remainsHead := alreadyReady.any (fun b => b.session == some first.session && (b.events.head?).any (fun e => e.id == first.id))
  if ready > now && !remainsHead && (frozen.isSome || !q.readyHeads.contains first.id) then return (q, none)
  if frozen.isNone && ready <= now && !q.readyHeads.contains first.id then
    q := { q with readyHeads := q.readyHeads ++ [first.id] }
  let priority := if members.any (fun e => e.priority == 0) then 0 else if members.any (fun e => e.priority != 2) then 1 else 2
  let age := members.foldl (fun n e => min n (e.eligibleAt.getD (e.firstQueuedAt.getD e.readyAt)))
    (first.eligibleAt.getD (first.firstQueuedAt.getD first.readyAt))
  return (q, some { session := first.session, events := members, priority, question := members.any (·.question), aged := priority == 2 && now >= age + cfg.idleAging })

/-- ready user を byte 上限まで順にまとめる。 -/
def boundedUsers (users : List Event) (limit : Nat) : List Event := Id.run do
  let mut result := []
  let mut bytes := 0
  for e in users do
    if e.bytes > limit || (!result.isEmpty && bytes + e.bytes > limit) then break
    result := result ++ [e]
    bytes := bytes + e.bytes
  return result

/-- user、focus、OQ、continuation、normal FIFO、idle FIFO の順に選択する。 -/
def Queue.selectBatchWith (q : Queue) (state : SelectionState) (cfg : Scheduling) (now : Nat) (alreadyReady : Option Batch) : Queue × Option Batch := Id.run do
  let ordered := orderEvents q.pending
  let readyUsers := ordered.filter (fun e => e.user && e.readyAt <= now)
  let users := boundedUsers readyUsers cfg.maxUserBytes
  let reports := ordered.filter (fun e => !e.user)
  let sessions := reports.foldl (fun acc e => if acc.contains e.session then acc else acc ++ [e.session]) ([] : List String)
  let mut q := q
  let mut candidates := []
  for session in sessions do
    let (next, found) := q.candidate cfg state now (reports.filter (fun e => e.session == session)) alreadyReady
    q := next
    if let some c := found then candidates := candidates ++ [c]
  if !readyUsers.isEmpty then
    if users.isEmpty then return (q, none)
    else return (q, some { session := none, events := users })
  let focus := state.focus.bind (fun id => candidates.find? (fun c => c.session == id))
  let question := candidates.find? (·.question)
  let preferred := focus.orElse (fun _ => question)
  let continuation := if state.continuationConsumed then none else state.lastSession.bind (fun id => candidates.find? (fun c => c.session == id))
  let selected := (preferred.orElse (fun _ => continuation)).orElse (fun _ =>
    (candidates.find? (fun c => c.priority == 1 || c.aged)).orElse (fun _ => candidates.head?))
  match selected with
  | none => return (q, none)
  | some c =>
    let first := c.events.head!
    return (q, some { session := some c.session, events := c.events, usedContinuation := preferred.isNone && continuation.isSome, priority := if c.aged then 1 else c.priority, batchId := first.frozenBatchId, payload := first.frozenPayload.filter (fun s => !s.isEmpty) })

/-- 通常選択では既選択 batch を指定しない。 -/
def Queue.selectBatch (q : Queue) (state : SelectionState) (cfg : Scheduling) (now : Nat) : Queue × Option Batch :=
  q.selectBatchWith state cfg now none

/-- 保持中 batch の先頭 identity と session が現在の選択と一致するか。 -/
def Queue.isBatchCurrent (q : Queue) (state : SelectionState) (cfg : Scheduling) (now : Nat) (batch : Batch) : Queue × Batch × Bool :=
  let (q, selected) := q.selectBatchWith state cfg now (some batch)
  match selected with
  | some b =>
    if b.session == batch.session && (b.events.head?).map (·.id) == (batch.events.head?).map (·.id) then
      (q, { batch with usedContinuation := b.usedContinuation }, true)
    else (q, batch, false)
  | none => (q, batch, false)

/-- commit は同一 session の未凍結 report を追加して凍結し、選択 ID を pending から除く。 -/
def Queue.commitBatch (q : Queue) (batch : Batch) (id payload : String) : Queue × Batch × Bool := Id.run do
  let mut b := batch
  if let some session := b.session then
    let members := orderEvents (q.pending.filter (fun e => !e.user &&
      if b.batchId.isSome then e.frozenBatchId == b.batchId else e.session == session && e.frozenBatchId.isNone))
    if !members.isEmpty then
      if b.batchId.isNone then
        let memberPriority := if members.any (fun e => e.priority == 0) then 0 else if members.any (fun e => e.priority != 2) then 1 else 2
        let priority := if memberPriority == 2 && b.priority == 1 then 1 else memberPriority
        b := { b with events := freezeReports members id payload, batchId := some id, payload := some payload, priority }
      else b := { b with events := members, payload := members.head!.frozenPayload }
  let keys := b.events.map (·.id)
  let pending := q.pending.filter (fun e => !keys.contains e.id)
  if pending.length == q.pending.length then return (q, b, false)
  let ids := b.events.filterMap (fun e => if e.user then none else e.usableReportId)
  return ({ q with pending, inFlight := q.inFlight ++ ids.filter (fun id => !q.inFlight.contains id), retryById := q.retryById.filter (fun x => !ids.contains x.1) }, b, true)

/-- rollback は report を pending に戻し、当該 batch の凍結を解除する。 -/
def Queue.rollbackBatchCommit (q : Queue) (b : Batch) : Queue × Batch :=
  if b.session.isNone then (q, b) else
    let ids := b.events.filterMap (fun e => if e.user then none else e.usableReportId)
    let events := b.events.map (fun e => if !e.user && b.batchId.isSome && e.frozenBatchId == b.batchId then { e with frozenBatchId := none, frozenPayload := none } else e)
    let pending := events.foldl (fun acc e => if e.user then acc else if acc.any (fun x => x.id == e.id) then acc.map (fun x => if x.id == e.id then e else x) else acc ++ [e]) q.pending
    ({ q with pending := orderEvents pending, inFlight := q.inFlight.filter (fun id => !ids.contains id) }, { b with events, batchId := none, payload := none })

/-- manifest 永続化前の commit 例外だけ rollback する。永続化後の例外では凍結を維持する。 -/
def Queue.afterCommitError (q : Queue) (batch : Batch) (committed durable : Bool) : Queue × Batch :=
  if committed && !durable then q.rollbackBatchCommit batch else (q, batch)

/-- 選択直後に commit し batch を返す。 -/
def Queue.takeBatch (q : Queue) (state : SelectionState) (cfg : Scheduling) (now : Nat) (id payload : String) : Queue × Option Batch :=
  let (q, selected) := q.selectBatch state cfg now
  match selected with
  | none => (q, none)
  | some b => let (q, b, _) := q.commitBatch b id payload; (q, some b)

/-- ack 専用 retry の段階。 -/
inductive AckState where
  | idle | attempting (attempts retries : Nat) | waiting (attempts retries readyAt : Nat)
  | acknowledged | stopped | exhausted
  deriving Repr, BEq, DecidableEq, Inhabited

/-- 共有 lifecycle と reconnect 要求、ack の途中状態。 -/
structure Runner where
  queue : Queue := {}
  lifecycle : Lifecycle := {}
  pendingReconnects : Nat := 0
  ack : AckState := .idle
  retryPending : Bool := false
  retryStoredAt : Option Nat := none
  batch : List Event := []
  selection : SelectionState := {}
  batchUsedContinuation : Bool := false
  displayedAttempt : Option (Option String) := none
  stopped : Bool := false
  deriving Repr, BEq, Inhabited

/-- `/recovery list` は表示時点の確認対象を記憶する。 -/
def Runner.recoveryList (r : Runner) : Runner :=
  if r.stopped then r else { r with displayedAttempt := some r.lifecycle.pendingAttemptId }

/-- `/recovery continue` は指定 ID または直近に表示した ID を原子的に照合する。 -/
def Runner.recoveryContinue (r : Runner) (explicit : Option String) : Runner × Bool :=
  if r.stopped then (r, false) else
  let attempt := match explicit with
    | some id => some id
    | none => match r.displayedAttempt with | some shown => shown | none => r.lifecycle.pendingAttemptId
  match attempt with
  | none => (r, false)
  | some id =>
    let (lifecycle, confirmed) := r.lifecycle.confirmRecovery (some id)
    ({ r with lifecycle, displayedAttempt := some (some id) }, confirmed)

/-- `/recovery clear` による snapshot 削除は attention を変更しない。 -/
def clearRecoverySnapshot (inbox : Inbox) (attemptId : String) : Inbox := inbox.remove [attemptId]

/-- 停止後は recovery clear を受け付けず、inbox も変更しない。 -/
def Runner.recoveryClear (r : Runner) (inbox : Inbox) (attemptId : String) : Inbox :=
  if r.stopped then inbox else clearRecoverySnapshot inbox attemptId

/-- commit 待ちの終了状態。 -/
inductive CommitResult where
  | stopped | rejected | error
  deriving Repr, BEq, DecidableEq

/-- 停止済みなら何もせず、それ以外は commit 結果に応じて lease を解放する。 -/
def Runner.settleBeforeSend (r : Runner) (lease : Lease) (result : CommitResult) : Except LeaseError Runner := do
  if r.stopped then return r
  let outcome : SendOutcome := if result == .error then { completed := false, requiresConfirmation := some false } else { completed := true }
  let lifecycle ← r.lifecycle.settleSend lease outcome
  return { r with lifecycle, stopped := r.stopped || result == .stopped || result == .error }

/-- send 待ちの中断は lifecycle を settle せず runner を停止する。 -/
def Runner.interruptSend (r : Runner) : Runner := { r with stopped := true }

/-- `/reconnect` は要求を一件積む。 -/
def Runner.requestReconnect (r : Runner) : Runner :=
  if r.stopped then r else { r with pendingReconnects := r.pendingReconnects + 1 }

/-- lease が取れなければ reconnect 要求は残る。 -/
def Runner.beginReconnect (r : Runner) (token : Nat) : Runner × Option Lease :=
  if r.stopped || r.retryPending || r.ack != .idle || r.pendingReconnects == 0 then (r, none) else
    let (lifecycle, lease) := r.lifecycle.beginReconnect token
    if lease.isNone then (r, none) else ({ r with lifecycle, pendingReconnects := r.pendingReconnects - 1 }, lease)

/-- reconnect 要求がなく runner が待機中なら共有 lifecycle から send lease を取得する。 -/
def Runner.beginSend (r : Runner) (token : Nat) : Runner × Option Lease :=
  if r.stopped || r.retryPending || r.pendingReconnects > 0 || r.ack != .idle then (r, none) else
    let (lifecycle, lease) := r.lifecycle.beginSend token
    ({ r with lifecycle }, lease)

/-- 停止済みなら何もせず、それ以外は reconnect の結果を共有 lifecycle に渡す。 -/
def Runner.settleReconnect (r : Runner) (lease : Lease) (success : Bool) : Except LeaseError Runner := do
  if r.stopped then return r
  let lifecycle ← r.lifecycle.settleReconnect lease success
  return { r with lifecycle }

/-- 停止済みなら結果なしで状態を保つ。それ以外は send を settle し、完了時に ack、例外時に終了する。 -/
def Runner.settleSend (r : Runner) (input : SettlementInput) (inbox : Inbox) (now : Nat) : Runner × Option SettlementResult :=
  if r.stopped then (r, none) else
  let hasUser := r.batch.any (·.user)
  let input := { input with workflow := .operatorAgent, hasOperatorInput := hasUser, requiresConfirmation := some hasUser }
  let result := settleConductorDispatch r.lifecycle input inbox
  let session := (r.batch.head?).bind (fun e => if e.user then none else some e.session)
  let selection := { r.selection with lastSession := session, continuationConsumed := r.batchUsedContinuation }
  let retryPending := result.result.toOption == some false
  let failed := match result.result with | .error _ => true | .ok _ => false
  ({ r with lifecycle := result.lifecycle, selection, retryPending, retryStoredAt := if retryPending then some (now + 5000) else none, ack := if result.result.toOption == some true then .attempting 1 0 else .idle, stopped := failed }, some result)

/-- 保存後に report ごとの時計値を順に受けて再投入する。停止・例外なら再投入せず終了する。 -/
def Runner.finishRetryRecord (r : Runner) (readTime : Nat → Nat) (succeeded : Bool) : Runner :=
  if r.stopped || !r.retryPending then r else if !succeeded then { r with retryPending := false, stopped := true } else
    let floor := r.batch.foldl (fun n e => max n (e.id + 1)) r.queue.nextIdentity
    let (queue, _) := r.batch.foldl (fun (q, index) e =>
      if e.user then (q, index) else (q.requeueReport e (readTime index) 5000, index + 1))
      ({ r.queue with nextIdentity := floor }, 0)
    { r with queue, retryPending := false }

/-- ack に失敗すると最大3回まで5秒後の retry を待つ。 -/
def Runner.ackResult (r : Runner) (success : Bool) (now : Nat) : Runner :=
  if r.stopped then r else match r.ack with
  | .attempting attempts retries =>
    if success then { r with ack := .acknowledged }
    else if retries >= 3 then { r with ack := .exhausted, stopped := true }
    else { r with ack := .waiting attempts (retries + 1) (now + 5000) }
  | _ => r

/-- ack の待機中に停止するか、期限到来後に次の試行を開始する。 -/
def Runner.advanceAck (r : Runner) (now : Nat) (stopped : Bool) : Runner :=
  if r.stopped then r else match r.ack with
  | .waiting attempts retries ready =>
    if stopped then { r with ack := .stopped, stopped := true }
    else if now >= ready then { r with ack := .attempting (attempts + 1) retries } else r
  | _ => r

/-- ack 成功後、user batch かつ pending user がなければ会話 hold を解除する。 -/
def Runner.finishAcknowledged (r : Runner) : Runner :=
  if r.stopped || r.ack != .acknowledged then r else
    let ids := r.batch.filterMap (fun e => if e.user then none else e.usableReportId)
    let queue := (r.queue.discardReports ids).completeReportRequest r.batch
    let q := if r.batch.any (·.user) && queue.conversationHold && !(queue.pending.any (·.user))
      then (queue.setConversationHold false).1 else queue
    { r with queue := q, batch := [], ack := .idle }

/- request は held の report も登録し、ack 済みの key だけ解除する。 -/
#guard (decide (
  let q : Queue := { held := [{ id := 4, arrival := 9, user := false, session := "a", reportId := some "x" }, { id := 5, arrival := 10, user := false, session := "a", reportId := some "y" }], reportHold := true }
  let (q, ok) := q.requestReports "a"
  let q := q.completeReportRequest [q.held.head!]
  ok && q.requested == [("a", ["id:y"])]
))

/- 凍結済み batch は期限前に送られず、後着の非凍結 report を含まない。 -/
#guard (decide (
  let e : Event := { id := 8, arrival := 1, user := false, session := "a", reportId := some "x", frozenBatchId := some "batch", frozenPayload := some "payload", retryReadyAt := some 5000 }
  let later : Event := { id := 3, arrival := 2, user := false, session := "a" }
  let q : Queue := { pending := [e, later] }
  let cfg : Scheduling := { maxWait := 10, idleAging := 100, maxUserBytes := 100 }
  let (_, before) := q.selectBatch {} cfg 4999
  let (_, after) := q.selectBatch {} cfg 5000
  before.isNone && after.map (fun b => b.events.map (·.id)) == some [8]
))

/- commit は後着の同一 session report を含めて凍結し、rollback は戻す。 -/
#guard (decide (
  let e : Event := { id := 99, arrival := 1, user := false, session := "a", reportId := some "x" }
  let later : Event := { id := 1, arrival := 2, user := false, session := "a", reportId := some "y" }
  let q : Queue := { pending := [later, e] }
  let b : Batch := { session := some "a", events := [e] }
  let (q, b, ok) := q.commitBatch b "batch" "payload"
  let (q, b) := q.rollbackBatchCommit b
  ok && q.inFlight.isEmpty && q.pending.map (·.id) == [99, 1] && b.batchId.isNone && q.pending.all (fun e => e.frozenBatchId.isNone && e.frozenPayload.isNone) &&
    b.events.all (fun e => e.frozenBatchId.isNone && e.frozenPayload.isNone) && b.events == q.pending
))

/- 複数 report はそれぞれ時計を読み、最後の期限まで frozen batch を選べない。 -/
#guard (decide (
  let first : Event := { id := 1, arrival := 1, user := false, session := "a", reportId := some "x", frozenBatchId := some "b", frozenPayload := some "p" }
  let second : Event := { id := 2, arrival := 2, user := false, session := "a", reportId := some "y", frozenBatchId := some "b", frozenPayload := some "p" }
  let user : Event := { id := 3, user := true }
  let r : Runner := { retryPending := true, batch := [first, user, second] }
  let r := r.finishRetryRecord (fun i => if i == 0 then 100 else 101) true
  let cfg : Scheduling := { maxWait := 10, idleAging := 100, maxUserBytes := 100 }
  let (_, early) := r.queue.selectBatch {} cfg 5100
  let (_, ready) := r.queue.selectBatch {} cfg 5101
  r.queue.pending.map (·.retryReadyAt) == [some 5100, some 5101] && early.isNone &&
    ready.map (fun b => b.events.length) == some 2
))

/- ack 成功だけが in-flight と request を解放する。 -/
#guard (decide (
  let e : Event := { id := 1, user := false, session := "a", reportId := some "x" }
  let q : Queue := { inFlight := ["x"], requested := [("a", ["id:x"])] }
  let r : Runner := { queue := q, batch := [e], ack := .attempting 1 0 }
  let failed := r.ackResult false 0
  let done := (r.ackResult true 0).finishAcknowledged
  failed.queue.inFlight == ["x"] && done.queue.inFlight.isEmpty && done.queue.requested.isEmpty
))

/- 未完了 send は report を5秒後に同じ凍結内容で戻す。 -/
#guard (decide (
  let e : Event := { id := 1, arrival := 1, user := false, session := "a", reportId := some "x", frozenBatchId := some "batch", frozenPayload := some "payload" }
  let (lifecycle, lease) := ({} : Lifecycle).beginSend 1
  let r : Runner := { lifecycle, queue := { inFlight := ["x"] }, batch := [e] }
  let (r, result) := r.settleSend { lease := lease.get!, workflow := .operatorAgent, status := .other, failureClass := .incompleteStatus } {} 100
  let r := r.finishRetryRecord (fun _ => 100) true
  result.bind (fun x => x.result.toOption) == some false && r.queue.inFlight.isEmpty &&
    r.queue.pending.head!.retryReadyAt == some 5100 && r.queue.pending.head!.frozenPayload == some "payload" && r.ack == .idle
))

/- 4回の ack 失敗は exhausted になり、hold と in-flight を保持する。 -/
#guard (decide (
  let r : Runner := { queue := { conversationHold := true, inFlight := ["x"] }, ack := .attempting 1 0 }
  let r := (r.ackResult false 0).advanceAck 5000 false
  let r := (r.ackResult false 5000).advanceAck 10000 false
  let r := (r.ackResult false 10000).advanceAck 15000 false
  let r := r.ackResult false 15000
  r.ack == .exhausted && r.finishAcknowledged.queue.conversationHold && r.queue.inFlight == ["x"]
))

/- user send と ack の完了で、待ち入力がなければ保留 report が解放される。 -/
#guard (decide (
  let q := ({} : Queue).submitUser { id := 0, user := true }
  let q := q.enqueueReport { id := 1, arrival := 1, user := false } 0 0 10
  let user := q.pending.head!
  let r : Runner := { queue := { q with pending := [] }, batch := [user], ack := .acknowledged }
  let r := r.finishAcknowledged
  !r.queue.conversationHold && r.queue.held.isEmpty && r.queue.pending.length == 1
))

/- 表示後に attempt が変化すると暗黙 continue は古い対象を照合する。 -/
#guard (decide (
  let r : Runner := { lifecycle := { pendingAttemptId := some "1" } }
  let r := r.recoveryList
  let r := { r with lifecycle := { r.lifecycle with pendingAttemptId := some "2" } }
  let (r, stale) := r.recoveryContinue none
  let (r, fresh) := r.recoveryContinue (some "2")
  !stale && fresh && r.lifecycle.pendingAttemptId.isNone
))

/- commit の不成立と例外はどちらも lease を解放するが、例外だけ停止する。 -/
#guard (decide (
  let (r, lease) := ({} : Runner).beginSend 1
  let rejected := (r.settleBeforeSend lease.get! .rejected).toOption.get!
  let failed := (r.settleBeforeSend lease.get! .error).toOption.get!
  rejected.lifecycle.canDispatch && !rejected.stopped && failed.lifecycle.canDispatch && failed.stopped
))

/- 空の report ID は arrival を request key とし、in-flight に記録しない。 -/
#guard (decide (
  let e : Event := { id := 2, arrival := 7, user := false, session := "a", reportId := some "" }
  let q : Queue := { pending := [e] }
  let (q, _) := q.requestReports "a"
  let b : Batch := { session := some "a", events := [e] }
  let (q, _, committed) := q.commitBatch b "batch" "payload"
  committed && q.requested == [("a", ["arrival:7"])] && q.inFlight.isEmpty
))

/- focus 中は request がない report を threshold から外す。request 後は deadline より先に選べる。 -/
#guard (decide (
  let e : Event := { id := 1, arrival := 1, user := false, session := "a", readyAt := 100, weight := 1 }
  let q : Queue := { pending := [e] }
  let cfg : Scheduling := { maxWait := 30, idleAging := 50, maxUserBytes := 100, threshold := some 1 }
  let state : SelectionState := { focus := some "a" }
  let (_, blocked) := q.selectBatch state cfg 0
  let (q, _) := q.requestReports "a"
  let (_, selected) := q.selectBatch state cfg 0
  blocked.isNone && selected.isSome
))

/- 未完了 user send は入力を再投入せず、hold と確認待ちを保持する。 -/
#guard (decide (
  let user : Event := { id := 1, user := true }
  let (r, lease) := ({} : Runner).beginSend 1
  let r := { r with queue := { conversationHold := true }, batch := [user] }
  let (r, _) := r.settleSend { lease := lease.get!, workflow := .operatorAgent, status := .other, failureClass := .incompleteStatus, captureFailure := false } {} 0
  r.queue.conversationHold && r.queue.pending.isEmpty && r.lifecycle.confirmationRequired && r.ack == .idle
))

/- 再選択で continuation の使用が変われば、元 batch の値も更新する。 -/
#guard (decide (
  let e : Event := { id := 1, user := false, session := "a" }
  let q : Queue := { pending := [e] }
  let cfg : Scheduling := { maxWait := 10, idleAging := 10, maxUserBytes := 100 }
  let b : Batch := { session := some "a", events := [e] }
  let (_, current, valid) := q.isBatchCurrent { lastSession := some "a" } cfg 0 b
  valid && current.usedContinuation
))

/- retry 保存待ちの停止は再投入を行わず、保存と queue の時刻は別に取る。 -/
#guard (decide (
  let e : Event := { id := 1, user := false, reportId := some "x", frozenBatchId := some "b" }
  let (r, lease) := ({} : Runner).beginSend 1
  let r := { r with queue := { inFlight := ["x"] }, batch := [e] }
  let (r, _) := r.settleSend { lease := lease.get!, workflow := .operatorAgent, status := .other, failureClass := .transport } {} 100
  let stopped := r.finishRetryRecord (fun _ => 900) false
  let resumed := r.finishRetryRecord (fun _ => 900) true
  stopped.stopped && stopped.queue.pending.isEmpty && stopped.queue.inFlight == ["x"] &&
    resumed.retryStoredAt == some 5100 && resumed.queue.pending.head!.retryReadyAt == some 5900
))

/- 凍結が永続化済みなら lock 解放エラーでも rollback しない。 -/
#guard (decide (
  let e : Event := { id := 1, user := false, session := "a", reportId := some "x" }
  let b : Batch := { session := some "a", events := [e] }
  let (q, b, ok) := ({ pending := [e] } : Queue).commitBatch b "b" "p"
  let (rolled, _) := q.afterCommitError b ok false
  let (durable, _) := q.afterCommitError b ok true
  rolled.pending.length == 1 && durable.pending.isEmpty && durable.inFlight == ["x"]
))

/- 同じ user send の完了と未完了は、例外とは異なり ack または retry に進む。 -/
#guard (decide (
  let user : Event := { id := 1, user := true }
  let (r, lease) := ({} : Runner).beginSend 1
  let r := { r with queue := { conversationHold := true }, batch := [user] }
  let input : SettlementInput := { lease := lease.get!, workflow := .operatorAgent, status := .finished, failureClass := .transport, hasInbox := true, hasReservation := true }
  let (completed, success) := r.settleSend input {} 100
  let (incomplete, failure) := r.settleSend { input with status := .other } {} 100
  success.bind (fun x => x.result.toOption) == some true && !completed.stopped && completed.ack == .attempting 1 0 &&
    failure.bind (fun x => x.result.toOption) == some false && !incomplete.stopped && incomplete.retryPending && incomplete.queue.conversationHold
))

/- send の待機中断では lease を settle せず、次の処理を開始しない。 -/
#guard (decide (
  let (r, lease) := ({} : Runner).beginSend 1
  let r := r.interruptSend
  let (_, next) := r.beginSend 2
  lease.isSome && r.stopped && r.lifecycle.activeLease == lease && next.isNone
))

/- user の send 後に inbox commit が失敗すると、入力は戻らず runner は終了する。 -/
#guard (decide (
  let user : Event := { id := 1, user := true }
  let q := ({} : Queue).submitUser user
  let cfg : Scheduling := { maxWait := 10, idleAging := 10, maxUserBytes := 100 }
  let (r, lease) := ({ queue := q } : Runner).beginSend 1
  let (queue, batch) := r.queue.takeBatch {} cfg 0 "unused" "unused"
  let r := { r with queue, batch := batch.get!.events }
  let (r, result) := r.settleSend { lease := lease.get!, workflow := .operatorAgent, status := .other, failureClass := .transport, hasInbox := true, hasReservation := true, commitValid := false } {} 100
  let afterReconnectRequest := r.requestReconnect
  let (_, nextSend) := afterReconnectRequest.beginSend 2
  let (_, reconnect) := afterReconnectRequest.beginReconnect 3
  let (_, confirmed) := afterReconnectRequest.recoveryContinue none
  let retryInput : SettlementInput := { lease := lease.get!, workflow := .operatorAgent, status := .finished, failureClass := .transport }
  let (reapplied, retryResult) := r.settleSend retryInput ({} : Inbox) 101
  let beforeSend := (r.settleBeforeSend lease.get! .rejected).toOption
  let reconnectSettled := (r.settleReconnect lease.get! true).toOption
  (result.map (fun x => match x.result with | .error .commitRejected => true | _ => false) == some true) &&
    r.stopped && r.lifecycle.activeLease.isSome && r.queue.conversationHold && r.queue.pending.isEmpty &&
    r.ack == .idle && !r.retryPending && afterReconnectRequest.pendingReconnects == 0 &&
    nextSend.isNone && reconnect.isNone && !confirmed && reapplied == r && retryResult.isNone &&
    beforeSend == some r && reconnectSettled == some r
))

/- 停止済みでは reconnect lease を持っていても settle は lifecycle を変更しない。 -/
#guard (decide (
  let (busy, lease) := ({} : Runner).requestReconnect.beginReconnect 1
  let stopped := { busy with stopped := true }
  let after := (stopped.settleReconnect lease.get! true).toOption
  lease.isSome && after == some stopped && stopped.lifecycle.activeLease == lease
))

/- 停止済みの公開 runner 操作は queue・inbox を含む状態を進めない。 -/
#guard (decide (
  let r : Runner := { stopped := true, ack := .attempting 1 0, retryPending := true, pendingReconnects := 1 }
  let inbox : Inbox := { snapshots := ["1"] }
  let (send, sendLease) := r.beginSend 1
  let (reconnect, reconnectLease) := r.beginReconnect 2
  let (continued, ok) := r.recoveryContinue none
  send == r && sendLease.isNone && reconnect == r && reconnectLease.isNone &&
    r.requestReconnect == r && r.recoveryList == r && continued == r && !ok &&
    r.recoveryClear inbox "1" == inbox && r.finishRetryRecord (fun _ => 0) true == r &&
    r.ackResult true 0 == r && r.advanceAck 0 false == r && r.finishAcknowledged == r && r.interruptSend == r
))

/- 手動 hold を残したまま `/resume-watch` しても report は解放されない。 -/
#guard (decide (
  let q := ({} : Queue).submitUser { id := 0, user := true }
  let q := q.enqueueRaw { id := 1, user := false }
  let q := (q.setHold true).1
  let (q, released) := q.resumeWatch
  (q.conversationHold, q.reportHold, q.held.length, released) = (false, true, 1, 0)
))

/- ack の停止は会話 hold 解除に至らない。 -/
#guard (decide (
  let q := ({} : Queue).submitUser { id := 0, user := true }
  let r : Runner := { queue := q, ack := .attempting 1 0 }
  let r := (r.ackResult false 0).advanceAck 5000 true
  r.ack == .stopped && r.finishAcknowledged.queue.conversationHold
))

/- send 失敗後の reconnect は確認待ちを解除しない。 -/
#guard (decide (
  let (s, lease) := ({} : Lifecycle).beginSend 1
  let failed := (s.settleSend lease.get! { completed := false, agentAvailable := some false }).toOption.get!
  let r : Runner := { lifecycle := failed }
  let (r, reconnect) := r.requestReconnect.beginReconnect 2
  let r := (r.settleReconnect reconnect.get! true).toOption.get!
  r.lifecycle.available && r.lifecycle.confirmationRequired && r.pendingReconnects == 0
))

/- 明示時刻を使った代表操作列を実行可能な値として表示する。 -/
#eval (({} : Queue).handleUser { id := 1, user := true } true 100).1.isHeld
#eval (let q := ({} : Queue).submitUser { id := 1, user := true }; (q.resumeWatch).1.isHeld)
#eval (let q := (({} : Queue).setHold true).1; let q := q.submitUser { id := 1, user := true }; (q.resumeWatch).1.isHeld)
#eval (let q := ({} : Queue).submitUser { id := 1, user := true }; let r : Runner := { queue := { q with pending := [] }, batch := q.pending, ack := .acknowledged }; r.finishAcknowledged.queue.isHeld)
#eval (let (s, lease) := ({} : Lifecycle).beginSend 1; let s := (s.settleSend lease.get! { completed := false, agentAvailable := some false }).toOption.get!; let r : Runner := { lifecycle := s }; let (r, l) := r.requestReconnect.beginReconnect 2; ((r.settleReconnect l.get! true).toOption.get!).lifecycle.state)

end Ensemble.AsIs.OperatorDispatch
