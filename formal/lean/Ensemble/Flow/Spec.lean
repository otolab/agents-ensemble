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
    (kind = .operatorInput ∨ kind = .permissionStall ∨ s.dispatchHold = false) ∧
    (kind ≠ .watchReport ∨ (s.conversationHold = false ∧ s.reportHold = false ∧
      (s.retry = .none ∨ ∃ deadline, s.retry = .send deadline ∧ deadline ≤ s.now)))
/--
受理 ID の種類は変わらず、dispatch・明示破棄の観測なしには保留項目が消えない。
各遷移の受理・dispatch・破棄は遷移後の状態に反映され、未受理 ID の dispatch や
同じ ID の再受理はしない。これは観測の意味を揃える整合条件であり、永続化や配信を
保証しない。watch report は dispatch 後に同じ ID を再び pending にしてよい。
-/
def ObservationConsistent (step : Transition) : Prop :=
  ∀ s e obs t, step s e obs t →
    (∀ id kind, .accepted id kind ∈ obs → s.items id = none ∧ t.items id = some ⟨kind, .pending⟩) ∧
    (∀ id attempt, .dispatched id attempt ∈ obs →
      ∃ kind, Pending s id kind ∧ t.items id = some ⟨kind, .dispatched⟩) ∧
    (∀ id, .discarded id ∈ obs → ∃ kind, Pending s id kind ∧ t.items id = some ⟨kind, .discarded⟩) ∧
    (∀ id kind, Pending s id kind → (∀ a, .dispatched id a ∉ obs) →
      .discarded id ∉ obs → Pending t id kind) ∧
    (∀ id item, s.items id = some item → ∃ next, t.items id = some next ∧ next.kind = item.kind)
/--
到達可能な各状態から、解除操作と環境結果・時刻の有限列で lifecycle が再び send を
受け付けられる状態への経路が存在する。環境がその経路を実際に選ぶこと、個別項目の
配信、任意の失敗列からの回復や有限時間での回復は保証しない。
-/
def RecoveryPossible (initial : State → Prop) (step : Transition) : Prop :=
  ∀ s, Reachable initial step s → ∃ trace t,
    Run step s trace t ∧ (∀ entry ∈ trace, RecoveryEvent entry.1) ∧ LifecycleReady t
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
時間や遷移回数の上限、send の完了、hold の解除は保証しない。
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
失敗または結果不明の send に含まれた operator input の同一 ID は、その後 dispatch
されない。別 ID の再入力、watch report の再送、受信側の副作用の重複は対象外。
失敗した試行への所属は、過去の dispatch 観測から判定する。
-/
def NoAutomaticInputReplay (initial : State → Prop) (step : Transition) : Prop :=
  ∀ start before s t u attempt result id obs after,
    initial start → Run step start before s →
    Observed before (.dispatched id attempt) → s.items id = some ⟨.operatorInput, .dispatched⟩ →
    result ≠ .completed → step s (.sendResult attempt result) obs t → Run step t after u →
    ¬ Dispatched after id
/--
reconnect 成功後、対象が dispatch まで可能であり続け、scheduler が弱公平な無限実行
ではいつか dispatch される。成功自体、他の停止要因の解消、send の完了、時間や遷移
回数の上限は保証しない。公平性は選択を仮定し、配信を仮定しない。
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
解除操作は対象外の hold や lifecycle 状態を変えない。send や reconnect の結果に
伴う変更は対象外であり、解除操作自身が成功することも保証しない。
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
