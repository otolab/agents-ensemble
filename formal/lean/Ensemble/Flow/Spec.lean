/-! # dispatch フローの抽象仕様

性質ごとの operator 合意範囲は対応する Issue に従う。ここにある全性質が合意済みとは限らない。
NoAutomaticInputReplay の restart recovery と operator 明示再送の例外は Issue #909 で承認された。
size preflight は通常の batch 編成時のサイズ計測・text 分割で回避し、選択後の超過は異常停止として
operator に通知し batch 全体の discard を可能にする契約だが、この抽象状態・遷移ではモデル化しない。
その停止 gate、明示 discard、再取込防止、解除条件は証明しない。
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
/-- send の終了結果。失敗と結果不明を分ける。 -/
inductive SendResult where
  | completed | failed | unknown
  deriving DecidableEq
/-- 一つの論理 batch を識別する抽象 ID。runtime の永続 ID との同一性は主張しない。 -/
abbrev BatchId := Nat
/-- batch を構成する項目の ID と種類。member の列挙順は初回 request の記録に使う。 -/
structure BatchMember where
  id : EventId
  kind : ItemKind
  deriving DecidableEq
/-- batch 内の一回の send-start と、その後に確定した結果。`none` は結果待ち。 -/
structure BatchAttempt where
  attempt : AttemptId
  result : Option SendResult
  deriving DecidableEq
/-- batch ID、初回に固定した ordered membership、上書きしない attempt / result 履歴。 -/
structure BatchRecord where
  id : BatchId
  members : List BatchMember
  attempts : List BatchAttempt
  deriving DecidableEq
/-- recovery request の envelope。再開通知は member ではなく request の前置情報。 -/
inductive BatchRecoveryEnvelope where
  | none
  | processRestartNotice
  deriving DecidableEq
/-- member の ID が重複せず、空でもない batch membership。 -/
def ValidBatchMembers (members : List BatchMember) : Prop :=
  members ≠ [] ∧ (members.map (·.id)).Nodup
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
  lastAttempt : EventId → Option AttemptId
  completed : AttemptId → Prop
  now : Time
  /-- 初回 send-start 時に記録し、結果と復旧試行を追記する抽象 batch 履歴。 -/
  batchHistory : BatchId → Option BatchRecord := fun _ => none
/-- 解除操作と通常入力。別の意図で再入力する場合は新しい ID を使う。 -/
inductive Operation where
  | input (id : EventId)
  | reconnect | recoveryContinue | resumeWatch
  | setDispatchHold (enabled : Bool)
  | setReportHold (enabled : Bool)
  deriving DecidableEq
/--
外部操作、処理結果、到着、時刻をモデルに与える入力。
`restartRecoveryDispatch` は結果不明の既存 item を、同じ ID のまま process 再開後に送信する
例外経路の抽象 event。`operatorResend` は3回上限到達後、TTY operator が明示選択した
一操作一送信を表す。明示 resend が失敗確定した後にも、環境を整えた operator が再送を
選んだ場合は同じ event を使う。これらの event tag は呼び出し元が与える前提であり、
property は実際の process 再開、3回上限到達、TTY operator の選択、環境準備を検証しない。
回数の実装や、実際に再送が起きること、他の dispatch gate を満たすことも保証しない。
-/
inductive Event where
  | operation (op : Operation)
  | sendResult (attempt : AttemptId) (result : SendResult)
  | reconnectResult (success : Bool)
  | arrival (kind : ItemKind) (id : EventId)
  | tick (time : Time)
  | schedule (id : EventId)
  | restartRecoveryDispatch (id : EventId) (attempt : AttemptId)
  | operatorResend (id : EventId) (attempt : AttemptId)
  | batchSendStarted (batch : BatchId) (members : List BatchMember) (attempt : AttemptId)
  | batchSendResult (batch : BatchId) (attempt : AttemptId) (result : SendResult)
  | batchRecoverySendStarted (batch : BatchId) (source : AttemptId) (attempt : AttemptId)
      (envelope : BatchRecoveryEnvelope)
  deriving DecidableEq
/-- 観測される受理、send 開始時の dispatch、明示破棄。 -/
inductive Observation where
  | accepted (id : EventId) (kind : ItemKind)
  | dispatched (id : EventId) (attempt : AttemptId)
  | discarded (id : EventId)
  | requeued (id : EventId)
  deriving DecidableEq
/-- member の並びを保った dispatch 観測列。coverage の比較では順不同として扱う。 -/
def BatchMemberObservations (members : List BatchMember) (attempt : AttemptId) :
    List Observation :=
  members.map fun member => .dispatched member.id attempt
/-- 指定した試行が直近で、結果不明として記録されている。 -/
def LastUnknownBatchAttempt (record : BatchRecord) (attempt : AttemptId) : Prop :=
  ∃ priorAttempts, record.attempts = priorAttempts ++
    [{ attempt := attempt, result := some .unknown }]
/--
operator input member に限った trace 射影。batch result を既存の `.sendResult` に、
batch recovery dispatch を `NoAutomaticInputReplay` が認める
`.restartRecoveryDispatch` に写す。初回 event は send-start のまま保ち、観測だけを
対象 input member に絞る。worker member は射影しない。
-/
def BatchInputReplayProjection (record : BatchRecord) (member : BatchMember)
    (event : Event) (obs : List Observation) : Option (Event × List Observation) :=
  if member.kind = .operatorInput ∧ member ∈ record.members then
    match event with
    | .batchSendStarted batch members _ =>
        if batch = record.id ∧ members = record.members then
          some (event, obs.filter fun observation =>
            match observation with
            | .dispatched id _ => id = member.id
            | _ => False)
        else none
    | .batchSendResult batch attempt result =>
        if batch = record.id then some (.sendResult attempt result, [])
        else none
    | .batchRecoverySendStarted batch _ attempt _ =>
        if batch = record.id then
          some (.restartRecoveryDispatch member.id attempt,
            [.dispatched member.id attempt])
        else none
    | _ => none
  else none
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
  | .sendResult _ _ | .batchSendResult _ _ _ | .reconnectResult _ | .tick _ => True
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
明示的な requeue 観測で許す。operator input の再 dispatch は、通常は pending item から
行う。結果不明後の例外は process 再開時の `.restartRecoveryDispatch`、または3回上限後に
operator が選ぶ `.operatorResend` event として、同じ ID の dispatch observation を出す。
明示 resend の失敗確定後も operator が再送を選んだ場合は `.operatorResend` を使う。
NoAutomaticInputReplay は通常の failed result 後の再 dispatch を禁じ、明示 resend の失敗後は
後続の同一 ID dispatch を operator resend に限る。成功済み attempt では ack のみを retry し、
再投入しない。batch recovery では dispatch 済みの非 operator item も同じ kind のまま
再 dispatch できるが、全 member の一対一 coverage は `BatchRecoveryObservationConsistent`
で別に検査する。各観測は同じ遷移の状態変化に対応する。ID の永続性、電源断後の保持、
配信成功は保証しない。
-/
def ObservationConsistent (step : Transition) : Prop :=
  ∀ s e obs t, step s e obs t →
    (∀ id kind, .accepted id kind ∈ obs ↔ s.items id = none ∧ t.items id = some ⟨kind, .pending⟩) ∧
    (∀ id attempt, .dispatched id attempt ∈ obs →
      (∃ kind, Pending s id kind ∧ t.items id = some ⟨kind, .dispatched⟩ ∧
        t.lastAttempt id = some attempt ∧ ¬ s.completed attempt) ∨
      ((e = .restartRecoveryDispatch id attempt ∨ e = .operatorResend id attempt) ∧
        s.items id = some ⟨.operatorInput, .dispatched⟩ ∧
        t.items id = some ⟨.operatorInput, .dispatched⟩ ∧
        (∃ previous, s.lastAttempt id = some previous ∧ ¬ s.completed previous) ∧
        t.lastAttempt id = some attempt ∧ ¬ s.completed attempt) ∨
      (∃ kind batch source envelope record,
        e = .batchRecoverySendStarted batch source attempt envelope ∧
        s.batchHistory batch = some record ∧ record.id = batch ∧
        LastUnknownBatchAttempt record source ∧
        ⟨id, kind⟩ ∈ record.members ∧
        s.items id = some ⟨kind, .dispatched⟩ ∧
        t.items id = some ⟨kind, .dispatched⟩ ∧
        t.lastAttempt id = some attempt ∧ ¬ s.completed attempt)) ∧
    (∀ id, .discarded id ∈ obs ↔ ∃ kind, Pending s id kind ∧ t.items id = some ⟨kind, .discarded⟩) ∧
    (∀ id, .requeued id ∈ obs ↔ s.items id = some ⟨.watchReport, .dispatched⟩ ∧
      t.items id = some ⟨.watchReport, .pending⟩) ∧
    (∀ id, .requeued id ∈ obs → ∃ attempt result, e = .sendResult attempt result ∧
      result ≠ .completed ∧ s.lastAttempt id = some attempt ∧ ¬ s.completed attempt) ∧
    (∀ attempt, t.completed attempt ↔
      s.completed attempt ∨ e = .sendResult attempt .completed ∨
        ∃ batch, e = .batchSendResult batch attempt .completed) ∧
    (∀ id, s.lastAttempt id = t.lastAttempt id ∨
      (∃ attempt, .dispatched id attempt ∈ obs ∧ t.lastAttempt id = some attempt)) ∧
    (∀ id, (s.items id = none ∧ t.items id = none) ∨
      (∃ kind, s.items id = none ∧ t.items id = some ⟨kind, .pending⟩ ∧ .accepted id kind ∈ obs) ∨
      (∃ item, s.items id = some item ∧ t.items id = some item) ∨
      (∃ kind attempt, Pending s id kind ∧ t.items id = some ⟨kind, .dispatched⟩ ∧
        .dispatched id attempt ∈ obs) ∨
      (∃ kind, Pending s id kind ∧ t.items id = some ⟨kind, .discarded⟩ ∧ .discarded id ∈ obs) ∨
      (s.items id = some ⟨.watchReport, .dispatched⟩ ∧
        t.items id = some ⟨.watchReport, .pending⟩ ∧ .requeued id ∈ obs))
/--
batch recovery event の観測と状態変更が、初回に記録した全 member に一対一で対応する。
observation list の順序は問わないが、`List.Perm` により欠落・追加・重複・ID 差し替えを許さない。
request envelope の process restart notice は member coverage の外に置く。有限 prefix は
この一段の recovery 遷移ではなく、完了扱いにしない。
-/
def BatchRecoveryObservationConsistent (step : Transition) : Prop :=
  ∀ s t batch source attempt envelope obs,
    step s (.batchRecoverySendStarted batch source attempt envelope) obs t →
      ∃ record, s.batchHistory batch = some record ∧ record.id = batch ∧
        LastUnknownBatchAttempt record source ∧
        obs.Perm (BatchMemberObservations record.members attempt) ∧
        (∀ member, member ∈ record.members →
          s.items member.id = some ⟨member.kind, .dispatched⟩ ∧
          t.items member.id = some ⟨member.kind, .dispatched⟩ ∧
          t.lastAttempt member.id = some attempt)
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
/-- 指定 ID の dispatch は restart recovery または operator の明示 resend として記録される。 -/
def ExplicitUnknownReplayDispatchOnly (trace : List (Event × List Observation)) (id : EventId) : Prop :=
  ∀ entry, entry ∈ trace →
    ∀ attempt, .dispatched id attempt ∈ entry.2 →
      entry.1 = .restartRecoveryDispatch id attempt ∨ entry.1 = .operatorResend id attempt
/-- 明示 resend の失敗確定後、同じ ID の再 dispatch は operator resend event に限る。 -/
def ExplicitOperatorResendDispatchOnly (trace : List (Event × List Observation)) (id : EventId) : Prop :=
  ∀ entry, entry ∈ trace →
    ∀ attempt, .dispatched id attempt ∈ entry.2 →
      entry.1 = .operatorResend id attempt
/-- 該当 attempt が operator の明示 resend として開始されたことを履歴で確認する。 -/
def OperatorResendDispatchRecorded
    (trace : List (Event × List Observation)) (id : EventId) (attempt : AttemptId) : Prop :=
  ∃ entry, entry ∈ trace ∧ entry.1 = .operatorResend id attempt ∧
    .dispatched id attempt ∈ entry.2
/--
通常の send の失敗確定後は同じ ID で再 dispatch しない。結果不明なら process 再開後の
`.restartRecoveryDispatch` event、または3回上限後に operator が選ぶ `.operatorResend`
event で同じ ID の復旧再送を許す。明示 resend 自体が失敗確定した場合は batch を保持し、
再送は自動化せず、環境を整えた operator が再び明示選択する `.operatorResend` に限る。
failure と unknown の分類・環境準備や operator 操作の実装、再送自体は保証しない。
event tag が表す restart / operator 操作の前提も検証せず、batch identity・send 回数上限・
永続化はモデル化しない。
別 ID の再入力、watch report の retry、受信側の副作用重複は対象外。
観測の完全性と復旧 dispatch の状態対応は `ObservationConsistent` が担う。
-/
def NoAutomaticInputReplay (initial : State → Prop) (step : Transition) : Prop :=
  ∀ start before s t u attempt result id obs after,
    initial start → Run step start before s →
    Observed before (.accepted id .operatorInput) → Observed before (.dispatched id attempt) →
    result ≠ .completed → step s (.sendResult attempt result) obs t → Run step t after u →
    (∀ next, .dispatched id next ∉ obs) ∧
    (result = .failed →
      (OperatorResendDispatchRecorded before id attempt →
        ExplicitOperatorResendDispatchOnly after id) ∧
      (¬ OperatorResendDispatchRecorded before id attempt → ¬ Dispatched after id)) ∧
    (result = .unknown → ExplicitUnknownReplayDispatchOnly after id)
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
各解除操作は対象外の停止要因を変更しない。すべての操作で retry と frozen を保持し、
`setDispatchHold(false)` 以外は held を保持する。reconnect 要求以外は lease と
pending reconnect も保持する。reconnect はその開始・待機を変更しうる。dispatch hold
解除は保留イベントを戻せるため held の変更を許す。対象 hold や attention 自体の解除成功、
操作後の別イベントで起こる回復、項目の配信は保証しない。
-/
def ReleaseIndependent (step : Transition) : Prop :=
  ∀ s t obs op, step s (.operation op) obs t →
    (op = .resumeWatch ∨ op = .recoveryContinue ∨ op = .reconnect ∨
      op = .setDispatchHold false ∨ op = .setReportHold false) →
    t.retry = s.retry ∧ t.frozen = s.frozen ∧
    (op ≠ .setDispatchHold false → t.held = s.held) ∧
    (op ≠ .reconnect → t.lease = s.lease ∧ t.pendingReconnects = s.pendingReconnects) ∧
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
