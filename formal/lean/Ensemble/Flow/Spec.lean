/-! # dispatch フローの抽象仕様

性質はレビュー用の候補であり、証明やオペレータの合意ではない。
識別子は同一の受理を追跡する抽象的な名前で、本文の一致を意味しない。
-/
namespace Ensemble.Flow

/-- 受理された入力または通知の識別子。再送では同じ識別子を使う。 -/
abbrev EventId := Nat
/-- send の試行を区別する識別子。 -/
abbrev AttemptId := Nat
/-- 明示的な時刻。単位は具体的なモデルが定める。 -/
abbrev Time := Nat
/-- send または reconnect の排他的な所有権。 -/
inductive Lease where
  | send (attempt : AttemptId)
  | reconnect
  deriving DecidableEq
/-- watch report の再試行段階と期限。 -/
inductive Retry where
  | none
  | send (readyAt : Time)
  | ack (readyAt : Time)
  deriving DecidableEq
/-- 受理された項目の種類。stall は dispatch hold 対象外の通知。 -/
inductive ItemKind where
  | operatorInput | worker | watchReport | permissionStall
  deriving DecidableEq
/-- 各項目の現在の状態。send 後も識別子と種類を保持する。 -/
inductive ItemStatus where
  | pending | dispatched | discarded
  deriving DecidableEq
/-- 受理された項目の種類と状態。 -/
structure Item where
  kind : ItemKind
  status : ItemStatus
  deriving DecidableEq
/-- 停止要因と項目の抽象的な観測。held と frozen は項目 ID の集合。 -/
structure State where
  lease : Option Lease
  available : Bool
  attention : Bool
  dispatchHold : Bool
  conversationHold : Bool
  reportHold : Bool
  held : EventId → Prop
  pendingReconnects : Nat
  retry : Retry
  frozen : EventId → Prop
  items : EventId → Option Item
  now : Time
/-- 解除操作と通常入力。別の意図で再入力する場合は新しい ID を使う。 -/
inductive Operation where
  | input (id : EventId)
  | reconnect | recoveryContinue | resumeWatch
  | setDispatchHold (enabled : Bool)
  | setReportHold (enabled : Bool)
  deriving DecidableEq
/-- send の終了結果。失敗と結果不明を分ける。 -/
inductive SendResult where
  | completed | failed | unknown
  deriving DecidableEq
/-- 外部操作、処理結果、到着、時刻をモデルに与える入力。 -/
inductive Event where
  | operation (op : Operation)
  | sendResult (attempt : AttemptId) (result : SendResult)
  | reconnectResult (success : Bool)
  | arrival (kind : ItemKind) (id : EventId)
  | tick (time : Time)
  | schedule (id : EventId)
  deriving DecidableEq
/-- 観測される受理、send 開始時の dispatch、明示破棄。 -/
inductive Observation where
  | accepted (id : EventId) (kind : ItemKind)
  | dispatched (id : EventId) (attempt : AttemptId)
  | discarded (id : EventId)
  | requeued (id : EventId)
  deriving DecidableEq
/-- 具体的モデルが与える遷移関係。1 遷移で複数の観測が生じてよい。 -/
abbrev Transition := State → Event → List Observation → State → Prop
/-- 有限の実行。初期状態と具体的遷移は呼び出し側が与える。 -/
inductive Run (step : Transition) : State → List (Event × List Observation) → State → Prop where
  | nil (s : State) : Run step s [] s
  | cons {s t u : State} {e : Event} {o : List Observation} {rest : List (Event × List Observation)} :
      step s e o t → Run step t rest u → Run step s ((e, o) :: rest) u
/-- 初期状態から有限回の遷移で到達できる状態。 -/
def Reachable (initial : State → Prop) (step : Transition) (s : State) : Prop :=
  ∃ start trace, initial start ∧ Run step start trace s
/-- その遷移の観測に指定した値が含まれる。 -/
def Observed (trace : List (Event × List Observation)) (o : Observation) : Prop :=
  ∃ entry ∈ trace, o ∈ entry.2
/-- 実行中に指定 ID の dispatch がある。 -/
def Dispatched (trace : List (Event × List Observation)) (id : EventId) : Prop :=
  ∃ attempt, Observed trace (.dispatched id attempt)
/-- 保留中であり、種類が一致する項目。 -/
def Pending (s : State) (id : EventId) (kind : ItemKind) : Prop :=
  s.items id = some ⟨kind, .pending⟩
/-- 回復列で許す利用者操作と環境イベント。 -/
def RecoveryEvent : Event → Prop
  | .operation .reconnect | .operation .recoveryContinue | .operation .resumeWatch
  | .operation (.setDispatchHold false) | .operation (.setReportHold false)
  | .sendResult _ _ | .reconnectResult _ | .tick _ => True
  | _ => False
/-- lifecycle が新しい send を受け付けられる状態。個別項目の hold は含まない。 -/
def LifecycleReady (s : State) : Prop :=
  s.lease = none ∧ s.available = true ∧ s.attention = false ∧ s.pendingReconnects = 0
/-- 項目別の hold と retry を含めた dispatch 可能性。 -/
def Eligible (s : State) (id : EventId) : Prop :=
  ∃ kind, Pending s id kind ∧ LifecycleReady s ∧
    (kind = .operatorInput ∨ kind = .permissionStall ∨
      (s.dispatchHold = false ∧ ¬ s.held id)) ∧
    (kind ≠ .watchReport ∨ (s.conversationHold = false ∧ s.reportHold = false ∧
      (s.retry = .none ∨ ∃ deadline, s.retry = .send deadline ∧ deadline ≤ s.now) ∧
      ((∀ other, ¬ s.frozen other) ∨ s.frozen id)))
/--
状態と観測を両方向に対応させる。新しい ID の出現は受理観測を要し、保留からの
状態変更は dispatch または破棄を要する。dispatch 済み watch report の再投入だけを
明示的な requeue 観測で許し、operator input の再投入は許さない。再投入は未完了
send の結果に限る（ack-only retry は再投入しない）。各観測は同じ遷移の
状態変化に対応する。ID の再利用、永続化、配信成功は保証しない。
-/
def ObservationConsistent (step : Transition) : Prop :=
  ∀ s e obs t, step s e obs t →
    (∀ id kind, .accepted id kind ∈ obs ↔ s.items id = none ∧ t.items id = some ⟨kind, .pending⟩) ∧
    (∀ id attempt, .dispatched id attempt ∈ obs →
      ∃ kind, Pending s id kind ∧ t.items id = some ⟨kind, .dispatched⟩) ∧
    (∀ id, .discarded id ∈ obs ↔ ∃ kind, Pending s id kind ∧ t.items id = some ⟨kind, .discarded⟩) ∧
    (∀ id, .requeued id ∈ obs ↔ s.items id = some ⟨.watchReport, .dispatched⟩ ∧
      t.items id = some ⟨.watchReport, .pending⟩) ∧
    (∀ id, .requeued id ∈ obs → ∃ attempt result, e = .sendResult attempt result ∧ result ≠ .completed) ∧
    (∀ id, (s.items id = none ∧ t.items id = none) ∨
      (∃ kind, s.items id = none ∧ t.items id = some ⟨kind, .pending⟩ ∧ .accepted id kind ∈ obs) ∨
      (∃ item, s.items id = some item ∧ t.items id = some item) ∨
      (∃ kind attempt, Pending s id kind ∧ t.items id = some ⟨kind, .dispatched⟩ ∧
        .dispatched id attempt ∈ obs) ∨
      (∃ kind, Pending s id kind ∧ t.items id = some ⟨kind, .discarded⟩ ∧ .discarded id ∈ obs) ∨
      (s.items id = some ⟨.watchReport, .dispatched⟩ ∧
        t.items id = some ⟨.watchReport, .pending⟩ ∧ .requeued id ∈ obs))
/--
到達可能な状態の保留項目ごとに、解除操作と環境結果・時刻からなる有限列を経て
その項目が dispatch 可能になる経路が存在する。hold、held、retry、frozen も判定する。
環境が実際に成功すること、経路が実行されること、配信や有限時間での回復は保証しない。
項目が存在しない状態に特定の配信先を要求しない。環境結果を含む緩和の採否は要レビュー。
-/
def RecoveryPossible (initial : State → Prop) (step : Transition) : Prop :=
  ∀ s id kind, Reachable initial step s → Pending s id kind → ∃ trace t,
    Run step s trace t ∧ (∀ entry ∈ trace, RecoveryEvent entry.1) ∧ Eligible t id
/--
reconnect の成功は availability を回復する。他の停止要因の解除や実際の配信、
成功そのものは保証しない。成功後も unavailable のままの遷移を排除する。
-/
def ReconnectRestoresAvailability (step : Transition) : Prop :=
  ∀ s t obs, step s (.reconnectResult true) obs t → t.available = true
/-- 無限実行の各時点の状態・入力・観測。各遷移の整合性は `ValidExecution` で確認する。 -/
structure Execution where
  state : Nat → State
  event : Nat → Event
  observations : Nat → List Observation
/-- 無限実行の各時点が具体的モデルの遷移に従う。 -/
def ValidExecution (step : Transition) (run : Execution) : Prop :=
  ∀ n, step (run.state n) (run.event n) (run.observations n) (run.state (n + 1))
/-- 指定時点に対象の dispatch が観測された。 -/
def DispatchAt (run : Execution) (n : Nat) (id : EventId) : Prop :=
  ∃ attempt, .dispatched id attempt ∈ run.observations n
/--
対象がある時点以降ずっと dispatch 可能なら、scheduler はそれ以降に対象を選ぶ。
無関係なイベントはいくつでも、無限に挟まってよい。選択は入力の観測であり、
dispatch の成功や send の完了ではない。この弱公平性は環境に対する前提である。
-/
def SchedulerFair (run : Execution) (id : EventId) : Prop :=
  ∀ n, (∀ m, n ≤ m → Eligible (run.state m) id) →
    ∃ m, n ≤ m ∧ run.event m = .schedule id
/--
ある時点から dispatch されるまで、対象が各時点で dispatch 可能であり続ける。
他の停止要因が介入しないという前提であり、それらの回復を保証しない。
-/
def EligibleUntilDispatch (run : Execution) (n : Nat) (id : EventId) : Prop :=
  ∀ m, n ≤ m → (∀ k, n ≤ k → k < m → ¬ DispatchAt run k id) →
    Eligible (run.state m) id
/--
選択された dispatch 可能な項目は同じ遷移で dispatch される。選択そのものは保証せず、
send の完了や副作用の成功も保証しない。公平性とは別にモデルに要求する性質。
-/
def ScheduledDispatches (step : Transition) : Prop :=
  ∀ s t id obs, Eligible s id → step s (.schedule id) obs t →
    ∃ attempt, .dispatched id attempt ∈ obs
/--
hold 中の permission stall は、dispatch まで他の停止要因がなく、scheduler が弱公平な
無限実行ではいつか dispatch される。公平性は選択についての前提で、配信を前提にしない。
時間や遷移回数の上限、send の完了、hold の解除は保証しない。有限実行しかないモデルでは空虚に成立する。
-/
def HoldExemptDelivered (step : Transition) : Prop :=
  ∀ run n id, ValidExecution step run → (run.state n).dispatchHold = true →
    Pending (run.state n) id .permissionStall → EligibleUntilDispatch run n id →
    SchedulerFair run id → ∃ m, n ≤ m ∧ DispatchAt run m id
/--
受理済みの保留項目は、dispatch または明示破棄されるまで有限実行の終わりに残る。
永続化、再起動後の保持、最終的な配信や順序は保証しない。
-/
def NoEventLoss (initial : State → Prop) (step : Transition) : Prop :=
  ∀ s trace t id kind, Reachable initial step s → Pending s id kind → Run step s trace t →
    ¬ Dispatched trace id → ¬ Observed trace (.discarded id) → Pending t id kind
/--
受理観測の直後から、dispatch または明示破棄まで同じ種類の項目が残る。受理遷移の
状態への反映と、その後の保持をともに要求する。永続化や最終的な配信は保証しない。
-/
def AcceptedEventRetained (initial : State → Prop) (step : Transition) : Prop :=
  ∀ s t u e obs trace id kind, Reachable initial step s → step s e obs t →
    .accepted id kind ∈ obs → Run step t trace u → ¬ Dispatched trace id →
    ¬ Observed trace (.discarded id) → Pending u id kind
/--
失敗または結果不明の attempt に dispatch された operator input の同一 ID は、結果と
同じ遷移にも、その後にも再 dispatch されない。履歴上の受理・dispatch で判別し、
失敗直前の状態に依存しない。別 ID の再入力、watch report の再送、受信側の副作用の
重複は対象外。観測の完全性は別の `ObservationConsistent` が担う。
-/
def NoAutomaticInputReplay (initial : State → Prop) (step : Transition) : Prop :=
  ∀ start before s t u attempt result id obs after,
    initial start → Run step start before s →
    Observed before (.accepted id .operatorInput) → Observed before (.dispatched id attempt) →
    result ≠ .completed → step s (.sendResult attempt result) obs t → Run step t after u →
    (∀ next, .dispatched id next ∉ obs) ∧ ¬ Dispatched after id
/--
reconnect 成功後、対象が dispatch まで可能であり続け、scheduler が弱公平な無限実行
ではいつか dispatch される。成功自体、他の停止要因の解消、send の完了、時間や遷移
回数の上限は保証しない。公平性は選択を仮定し、配信を仮定しない。有限実行しか
ないモデルではこの命題は空虚に成立する。availability 回復は別命題で検査する。
-/
def ReconnectResumes (step : Transition) : Prop :=
  ∀ run n id, ValidExecution step run → run.event n = .reconnectResult true →
    EligibleUntilDispatch run (n + 1) id → SchedulerFair run id →
    ∃ m, n + 1 ≤ m ∧ DispatchAt run m id
/--
`/resume-watch` は手動 report hold を変えない。操作の成功や他の解除操作の独立性は
この命題単体では保証しない。
-/
def ResumeWatchPreservesReportHold (step : Transition) : Prop :=
  ∀ s t obs, step s (.operation .resumeWatch) obs t → t.reportHold = s.reportHold
/--
解除操作は列挙された対象外の hold・availability・attention を変えない。lease、
pending reconnect、retry、held、frozen と、結果イベントによる変更は対象外。
解除操作自身が成功することも保証しない。
-/
def ReleaseIndependent (step : Transition) : Prop :=
  ∀ s t obs op, step s (.operation op) obs t →
    (op = .resumeWatch → t.reportHold = s.reportHold ∧ t.dispatchHold = s.dispatchHold ∧
      t.available = s.available ∧ t.attention = s.attention) ∧
    (op = .recoveryContinue → t.reportHold = s.reportHold ∧ t.conversationHold = s.conversationHold ∧
      t.dispatchHold = s.dispatchHold ∧ t.available = s.available) ∧
    (op = .setDispatchHold false → t.reportHold = s.reportHold ∧ t.conversationHold = s.conversationHold ∧
      t.available = s.available ∧ t.attention = s.attention) ∧
    (op = .setReportHold false → t.conversationHold = s.conversationHold ∧ t.dispatchHold = s.dispatchHold ∧
      t.available = s.available ∧ t.attention = s.attention) ∧
    (op = .reconnect → t.reportHold = s.reportHold ∧ t.conversationHold = s.conversationHold ∧
      t.dispatchHold = s.dispatchHold ∧ t.attention = s.attention)
end Ensemble.Flow
