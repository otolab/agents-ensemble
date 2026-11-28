import Ensemble.Flow.Spec

/-! # delivery-unknown batch の抽象 recovery

ここで定める transition は batch の論理記録と Flow observation の対応だけを表す。
provider 呼び出し・process restart・永続 restore の実行モデルではない。
-/

namespace Ensemble.Flow

/-- 履歴内のどこかに既に記録された send attempt。ID の再利用を防ぐ。 -/
def BatchAttemptRecorded (history : BatchId → Option BatchRecord) (attempt : AttemptId) : Prop :=
  ∃ batch record entry, history batch = some record ∧
    entry ∈ record.attempts ∧ entry.attempt = attempt

/-- 最新 attempt が結果待ちである batch 履歴。 -/
def LastStartedBatchAttempt (record : BatchRecord) (attempt : AttemptId) : Prop :=
  ∃ priorAttempts, record.attempts = priorAttempts ++
    [{ attempt := attempt, result := none }]

/-- batch 履歴 map の一つの slot を更新する。 -/
def setBatchRecord (history : BatchId → Option BatchRecord)
    (batch : BatchId) (record : Option BatchRecord) : BatchId → Option BatchRecord :=
  fun id => if id == batch then record else history id

/-- 初回 send-start で batch の各項目を dispatched にし、他の項目は保つ。 -/
def dispatchBatchItems (items : EventId → Option Item)
    (members : List BatchMember) : EventId → Option Item :=
  fun id =>
    match members.find? (fun member => member.id == id) with
    | some member => some ⟨member.kind, .dispatched⟩
    | none => items id

/-- batch の全 member に一つの attempt を記録する。 -/
def setBatchMemberAttempts (lastAttempt : EventId → Option AttemptId)
    (members : List BatchMember) (attempt : AttemptId) : EventId → Option AttemptId :=
  fun id =>
    if members.any (fun member => member.id == id) then some attempt else lastAttempt id

/-- membership 中の項目には共通 attempt が記録される。 -/
theorem setBatchMemberAttempts_of_mem
    (lastAttempt : EventId → Option AttemptId) (members : List BatchMember)
    (attempt : AttemptId) (member : BatchMember) (memberPresent : member ∈ members) :
    setBatchMemberAttempts lastAttempt members attempt member.id = some attempt := by
  unfold setBatchMemberAttempts
  have hAny : members.any (fun candidate => candidate.id == member.id) = true :=
    List.any_eq_true.mpr ⟨member, memberPresent, by simp⟩
  simp [hAny]

/-- 記録済み batch の attempt に結果を追記する。過去の結果は書き換えない。 -/
def recordBatchResult (record : BatchRecord) (attempt : AttemptId)
    (result : SendResult) : BatchRecord :=
  { record with attempts := record.attempts.map fun entry =>
      if entry.attempt == attempt then { entry with result := some result } else entry }

/-- Flow state に batch send-start 時の記録・dispatch を反映する。 -/
def batchSendStartedState (s : State) (batch : BatchId)
    (members : List BatchMember) (attempt : AttemptId) : State :=
  { s with
    items := dispatchBatchItems s.items members
    lastAttempt := setBatchMemberAttempts s.lastAttempt members attempt
    batchHistory := setBatchRecord s.batchHistory batch
      (some ⟨batch, members, [{ attempt := attempt, result := none }]⟩) }

/-- batch attempt の結果を履歴に追記し、成功時だけ completed を立てる。 -/
def batchSendResultState (s : State) (batch : BatchId)
    (record : BatchRecord) (attempt : AttemptId) (result : SendResult) : State :=
  { s with
    batchHistory := setBatchRecord s.batchHistory batch
      (some (recordBatchResult record attempt result))
    completed := fun prior => s.completed prior ∨
      (prior = attempt ∧ result = .completed) }

/-- recovery send-start を同一 batch の新しい attempt として追記する。 -/
def batchRecoverySendStartedState (s : State) (batch : BatchId)
    (record : BatchRecord) (attempt : AttemptId) : State :=
  { s with
    lastAttempt := setBatchMemberAttempts s.lastAttempt record.members attempt
    batchHistory := setBatchRecord s.batchHistory batch
      (some { record with attempts :=
        record.attempts ++ [{ attempt := attempt, result := none }] }) }

/--
抽象 batch 遷移。初回記録は batch send-start と同時であり、member の dispatch 観測を一段で出す。
結果は batch / attempt の組に記録する。recovery は直近の unknown attempt のみを参照し、
同じ batch・kind・ID の全 member を新しい共通 attempt で一段に dispatch する。
`schedule` の一般的意味は変更せず、この relation で concrete refinement も主張しない。
-/
inductive BatchRecoveryStep : Transition where
  | batchSendStarted {s : State} {batch : BatchId} {members : List BatchMember}
      {attempt : AttemptId} {obs : List Observation}
      (batchUnused : s.batchHistory batch = none)
      (membersValid : ValidBatchMembers members)
      (attemptFresh : ¬ BatchAttemptRecorded s.batchHistory attempt)
      (attemptNotCompleted : ¬ s.completed attempt)
      (membersPending : ∀ member, member ∈ members →
        s.items member.id = some ⟨member.kind, .pending⟩)
      (coverage : obs.Perm (BatchMemberObservations members attempt)) :
      BatchRecoveryStep s (.batchSendStarted batch members attempt) obs
        (batchSendStartedState s batch members attempt)
  | batchSendResult {s : State} {batch : BatchId} {record : BatchRecord}
      {attempt : AttemptId} {result : SendResult}
      (recordPresent : s.batchHistory batch = some record)
      (recordIdentity : record.id = batch)
      (attemptIsLatest : LastStartedBatchAttempt record attempt)
      (attemptNotCompleted : ¬ s.completed attempt) :
      BatchRecoveryStep s (.batchSendResult batch attempt result) []
        (batchSendResultState s batch record attempt result)
  | batchRecoverySendStarted {s : State} {batch : BatchId} {record : BatchRecord}
      {source attempt : AttemptId} {envelope : BatchRecoveryEnvelope}
      {obs : List Observation}
      (recordPresent : s.batchHistory batch = some record)
      (recordIdentity : record.id = batch)
      (membersValid : ValidBatchMembers record.members)
      (sourceUnknown : LastUnknownBatchAttempt record source)
      (membersLastAttempt : ∀ member, member ∈ record.members →
        s.lastAttempt member.id = some source)
      (membersDispatched : ∀ member, member ∈ record.members →
        s.items member.id = some ⟨member.kind, .dispatched⟩)
      (attemptFresh : ¬ BatchAttemptRecorded s.batchHistory attempt)
      (attemptNotCompleted : ¬ s.completed attempt)
      (coverage : obs.Perm (BatchMemberObservations record.members attempt)) :
      BatchRecoveryStep s (.batchRecoverySendStarted batch source attempt envelope) obs
        (batchRecoverySendStartedState s batch record attempt)

/-- この relation の recovery 観測は記録済み全 member の正確な coverage を持つ。 -/
theorem batch_recovery_observation_consistent :
    BatchRecoveryObservationConsistent BatchRecoveryStep := by
  intro s t batch source attempt envelope obs hstep
  cases hstep with
  | batchRecoverySendStarted recordPresent recordIdentity membersValid sourceUnknown
      membersLastAttempt membersDispatched attemptFresh attemptNotCompleted coverage =>
      rename_i record
      refine ⟨_, recordPresent, recordIdentity, sourceUnknown, coverage, ?_⟩
      intro member hmember
      have hdispatched := membersDispatched member hmember
      refine ⟨hdispatched, hdispatched, ?_⟩
      exact setBatchMemberAttempts_of_mem s.lastAttempt record.members attempt member hmember

/-- 初回 send-start は request の membership / attempt と全 member 観測を同時に記録する。 -/
theorem batch_send_started_records_exact_batch :
    ∀ s t batch members attempt obs,
      BatchRecoveryStep s (.batchSendStarted batch members attempt) obs t →
        s.batchHistory batch = none ∧
        t.batchHistory batch =
          some ⟨batch, members, [{ attempt := attempt, result := none }]⟩ ∧
        obs.Perm (BatchMemberObservations members attempt) ∧
        ∀ member, member ∈ members → t.lastAttempt member.id = some attempt := by
  intro s t batch members attempt obs hstep
  cases hstep with
  | batchSendStarted batchUnused _ _ _ _ coverage =>
      exact ⟨batchUnused, by simp [batchSendStartedState, setBatchRecord],
        coverage, fun member memberPresent =>
        setBatchMemberAttempts_of_mem s.lastAttempt members attempt member memberPresent⟩

/-- 全 batch recovery transition の operator input member は既存 restart 例外へ射影される。 -/
theorem batch_recovery_input_projection_preserves_existing_exception :
    ∀ s t batch source attempt envelope obs,
      BatchRecoveryStep s (.batchRecoverySendStarted batch source attempt envelope) obs t →
        ∃ record, s.batchHistory batch = some record ∧ record.id = batch ∧
          LastUnknownBatchAttempt record source ∧
          ∀ member, member.kind = .operatorInput → member ∈ record.members →
            .dispatched member.id attempt ∈ obs ∧
              BatchInputReplayProjection record member
                (.batchRecoverySendStarted batch source attempt envelope) obs =
                some (.restartRecoveryDispatch member.id attempt,
                  [.dispatched member.id attempt]) := by
  intro s t batch source attempt envelope obs hstep
  obtain ⟨record, recordPresent, recordIdentity, sourceUnknown, coverage, _⟩ :=
    batch_recovery_observation_consistent (s := s) (t := t) (batch := batch)
      (source := source) (attempt := attempt) (envelope := envelope)
      (obs := obs) hstep
  refine ⟨record, recordPresent, recordIdentity, sourceUnknown, ?_⟩
  intro member inputKind memberPresent
  have expected : .dispatched member.id attempt ∈
      BatchMemberObservations record.members attempt :=
    List.mem_map.mpr ⟨member, memberPresent, rfl⟩
  have observed := coverage.mem_iff.mpr expected
  exact ⟨observed, by
    simp [BatchInputReplayProjection, inputKind, memberPresent, recordIdentity]⟩

/-- batch result projection preserves its batch attempt and result in the existing input trace. -/
theorem batch_result_projection_preserves_attempt_and_result
    (record : BatchRecord) (member : BatchMember) (batch attempt : Nat)
    (result : SendResult) (obs : List Observation)
    (recordIdentity : record.id = batch)
    (inputKind : member.kind = .operatorInput)
    (memberPresent : member ∈ record.members) :
    BatchInputReplayProjection record member
      (.batchSendResult batch attempt result) obs =
      some (.sendResult attempt result, []) := by
  simp [BatchInputReplayProjection, recordIdentity, inputKind, memberPresent]

/-- 空でない operator input / worker 混在 batch の具体例。 -/
def mixedMembers : List BatchMember :=
  [{ id := 10, kind := .operatorInput }, { id := 20, kind := .worker }]

/-- witness の operator input member。 -/
def mixedInput : BatchMember := ⟨10, .operatorInput⟩

/-- witness の worker member。 -/
def mixedWorker : BatchMember := ⟨20, .worker⟩

/-- witness の初回 attempt が unknown になった直後の batch record。 -/
def mixedUnknownRecord : BatchRecord :=
  ⟨7, mixedMembers, [{ attempt := 1, result := some .unknown }]⟩

/-- input 射影は初回 send-start の観測から対象 operator input だけを残す。 -/
theorem mixed_input_projection_preserves_send_start :
    BatchInputReplayProjection mixedUnknownRecord mixedInput
      (.batchSendStarted 7 mixedMembers 1) (BatchMemberObservations mixedMembers 1) =
      some (.batchSendStarted 7 mixedMembers 1, [.dispatched 10 1]) := by
  simp [BatchInputReplayProjection, mixedUnknownRecord, mixedInput,
    mixedMembers, BatchMemberObservations]

/-- input 射影は元 attempt の unknown result を同じ attempt の既存 result event に写す。 -/
theorem mixed_input_projection_preserves_unknown_result :
    BatchInputReplayProjection mixedUnknownRecord mixedInput
      (.batchSendResult 7 1 .unknown) [] =
      some (.sendResult 1 .unknown, []) := by
  simp [BatchInputReplayProjection, mixedUnknownRecord, mixedInput,
    mixedMembers]

/-- input recovery は同じ batch の unknown source を参照し、既存の restart 例外に写る。 -/
theorem mixed_input_projection_uses_restart_exception :
    BatchInputReplayProjection mixedUnknownRecord mixedInput
      (.batchRecoverySendStarted 7 1 2 .processRestartNotice)
      (BatchMemberObservations mixedMembers 2) =
      some (.restartRecoveryDispatch 10 2, [.dispatched 10 2]) := by
  simp [BatchInputReplayProjection, mixedUnknownRecord, mixedInput,
    mixedMembers]

/-- worker member は input 専用の replay trace へ射影されない。 -/
theorem mixed_worker_has_no_input_replay_projection :
    BatchInputReplayProjection mixedUnknownRecord mixedWorker
      (.batchRecoverySendStarted 7 1 2 .processRestartNotice)
      (BatchMemberObservations mixedMembers 2) = none := by
  simp [BatchInputReplayProjection, mixedUnknownRecord, mixedWorker,
    mixedMembers]

/-- 混在 witness 用の初期状態。二つの異なる kind の item が pending である。 -/
def mixedInitial : State :=
  { lease := none
    available := true
    attention := false
    dispatchHold := false
    conversationHold := false
    reportHold := false
    held := fun _ => False
    pendingReconnects := 0
    retry := .none
    frozen := fun _ => False
    items := fun id =>
      if id = 10 then some ⟨.operatorInput, .pending⟩
      else if id = 20 then some ⟨.worker, .pending⟩
      else none
    lastAttempt := fun _ => none
    completed := fun _ => False
    now := 0
    batchHistory := fun _ => none }

/-- 混在 witness の初回抽象 send-start 後。 -/
def mixedAfterStart : State :=
  batchSendStartedState mixedInitial 7 mixedMembers 1

/-- 混在 witness で初回 attempt 1 が結果不明になった状態。 -/
def mixedAfterUnknown : State :=
  batchSendResultState mixedAfterStart 7
    ⟨7, mixedMembers, [{ attempt := 1, result := none }]⟩ 1 .unknown

/-- witness の batch 7 には初回 attempt 1 の unknown が記録されている。 -/
theorem mixedUnknownHistory :
    mixedAfterUnknown.batchHistory 7 =
      some ⟨7, mixedMembers, [{ attempt := 1, result := some .unknown }]⟩ := by
  rfl

/-- witness では attempt 2 をまだどの batch にも使っていない。 -/
theorem mixedAttempt2Fresh : ¬ BatchAttemptRecorded mixedAfterUnknown.batchHistory 2 := by
  intro h
  rcases h with ⟨batch, record, entry, recordLookup, entryPresent, attemptIsTwo⟩
  by_cases batchIsSeven : batch = 7
  · subst batch
    rw [mixedUnknownHistory] at recordLookup
    cases recordLookup
    simp at entryPresent
    subst entry
    simp at attemptIsTwo
  · have recordAbsent : mixedAfterUnknown.batchHistory batch = none := by
      simp [mixedAfterUnknown, batchSendResultState, setBatchRecord,
        mixedAfterStart, batchSendStartedState, mixedInitial, batchIsSeven]
    rw [recordAbsent] at recordLookup
    contradiction

/-- 混在 witness の member 列は有効である。 -/
theorem mixedMembersValid : ValidBatchMembers mixedMembers := by
  constructor
  · decide
  · simp [mixedMembers, List.Nodup]

/-- 混在 witness の recovery send-start 後。attempt 1 は保存し、attempt 2 を追記する。 -/
def mixedAfterRecovery : State :=
  batchRecoverySendStartedState mixedAfterUnknown 7
    ⟨7, mixedMembers, [{ attempt := 1, result := some .unknown }]⟩ 2

/-- 境界例用に初回 attempt 1 が失敗確定した状態。 -/
def mixedAfterFailed : State :=
  batchSendResultState mixedAfterStart 7
    ⟨7, mixedMembers, [{ attempt := 1, result := none }]⟩ 1 .failed

/-- failed は同一 batch record の attempt 1 に記録される。 -/
theorem mixedFailedHistory :
    mixedAfterFailed.batchHistory 7 =
      some ⟨7, mixedMembers, [{ attempt := 1, result := some .failed }]⟩ := by
  rfl

/-- 混在 witness から初回 send-start へ進める。 -/
theorem mixed_batch_send_started :
    BatchRecoveryStep mixedInitial (.batchSendStarted 7 mixedMembers 1)
      (BatchMemberObservations mixedMembers 1) mixedAfterStart := by
  apply BatchRecoveryStep.batchSendStarted
  · rfl
  · exact mixedMembersValid
  · simp [BatchAttemptRecorded, mixedInitial]
  · simp [mixedInitial]
  · intro member memberPresent
    simp [mixedMembers] at memberPresent
    rcases memberPresent with rfl | rfl <;> simp [mixedInitial]
  · simp [mixedMembers, BatchMemberObservations]

/-- 混在 witness の初回 attempt 1 は unknown として同じ batch record に残る。 -/
theorem mixed_batch_result_unknown :
    BatchRecoveryStep mixedAfterStart (.batchSendResult 7 1 .unknown) []
      mixedAfterUnknown := by
  apply BatchRecoveryStep.batchSendResult
  · rfl
  · rfl
  · exact ⟨[], rfl⟩
  · exact fun impossible => impossible

/-- 初回 unknown result の batch transition と input-only sendResult 射影は対応する。 -/
theorem mixed_input_result_is_existing_send_result :
    BatchRecoveryStep mixedAfterStart (.batchSendResult 7 1 .unknown) []
      mixedAfterUnknown ∧
    BatchInputReplayProjection mixedUnknownRecord mixedInput
      (.batchSendResult 7 1 .unknown) [] = some (.sendResult 1 .unknown, []) :=
  ⟨mixed_batch_result_unknown, mixed_input_projection_preserves_unknown_result⟩

/-- 混在 witness は同一 batch の unknown attempt 1 から全 member を attempt 2 へ復旧する。 -/
theorem mixed_batch_recovery_started :
    BatchRecoveryStep mixedAfterUnknown
      (.batchRecoverySendStarted 7 1 2 .processRestartNotice)
      (BatchMemberObservations mixedMembers 2) mixedAfterRecovery := by
  apply BatchRecoveryStep.batchRecoverySendStarted
  · rfl
  · rfl
  · exact mixedMembersValid
  · exact ⟨[], rfl⟩
  · intro member memberPresent
    simp [mixedMembers] at memberPresent
    rcases memberPresent with rfl | rfl <;>
      simp [mixedAfterUnknown, mixedAfterStart, batchSendResultState,
        batchSendStartedState, setBatchMemberAttempts,
        mixedMembers, mixedInitial]
  · intro member memberPresent
    simp [mixedMembers] at memberPresent
    rcases memberPresent with rfl | rfl <;>
      simp [mixedAfterUnknown, mixedAfterStart, batchSendResultState,
        batchSendStartedState, dispatchBatchItems, mixedMembers, mixedInitial]
  · exact mixedAttempt2Fresh
  · simp [mixedAfterUnknown, mixedAfterStart, batchSendResultState,
      batchSendStartedState, mixedInitial]
  · simp [mixedMembers, BatchMemberObservations]

/-- input 射影と batch transition は、同じ unknown source から既存 restart 例外へつながる。 -/
theorem mixed_input_recovery_is_valid_existing_exception :
    BatchRecoveryStep mixedAfterUnknown
      (.batchRecoverySendStarted 7 1 2 .processRestartNotice)
      (BatchMemberObservations mixedMembers 2) mixedAfterRecovery ∧
    BatchInputReplayProjection mixedUnknownRecord mixedInput
      (.batchRecoverySendStarted 7 1 2 .processRestartNotice)
      (BatchMemberObservations mixedMembers 2) =
      some (.restartRecoveryDispatch 10 2, [.dispatched 10 2]) :=
  ⟨mixed_batch_recovery_started, mixed_input_projection_uses_restart_exception⟩

/-- 初回 start → unknown → recovery の有限実行で混在 batch は到達可能である。 -/
theorem mixed_batch_recovery_reachable :
    Reachable (fun state => state = mixedInitial) BatchRecoveryStep mixedAfterRecovery := by
  refine ⟨mixedInitial, [
    (.batchSendStarted 7 mixedMembers 1, BatchMemberObservations mixedMembers 1),
    (.batchSendResult 7 1 .unknown, []),
    (.batchRecoverySendStarted 7 1 2 .processRestartNotice,
      BatchMemberObservations mixedMembers 2)], rfl, ?_⟩
  apply Run.cons mixed_batch_send_started
  apply Run.cons mixed_batch_result_unknown
  apply Run.cons mixed_batch_recovery_started
  exact Run.nil _

/-- positive witness は非空で、operator input と worker の両方を含む。 -/
theorem mixed_batch_is_nonempty_and_mixed :
    ValidBatchMembers mixedMembers ∧
      { id := 10, kind := ItemKind.operatorInput } ∈ mixedMembers ∧
      { id := 20, kind := ItemKind.worker } ∈ mixedMembers := by
  refine ⟨mixedMembersValid, ?_, ?_⟩ <;> simp [mixedMembers]

/-- 正例の最終 ledger は元 attempt の unknown と新 attempt の開始を両方保持する。 -/
theorem mixed_batch_keeps_attempt_and_result_history :
    mixedAfterRecovery.batchHistory 7 =
      some ⟨7, mixedMembers,
        [{ attempt := 1, result := some .unknown }, { attempt := 2, result := none }]⟩ := by
  simp [mixedAfterRecovery, mixedAfterUnknown, batchRecoverySendStartedState,
    batchSendResultState, setBatchRecord, mixedAfterStart, batchSendStartedState,
    mixedInitial, recordBatchResult]

/-- member coverage の長さが違う欠落観測は recovery transition にならない。 -/
theorem recovery_rejects_missing_member :
    ¬ ∃ t, BatchRecoveryStep mixedAfterUnknown
      (.batchRecoverySendStarted 7 1 2 .processRestartNotice)
      [.dispatched 10 2] t := by
  intro h
  obtain ⟨t, hstep⟩ := h
  have hcoverage := batch_recovery_observation_consistent
    (s := mixedAfterUnknown) (t := t) (batch := 7) (source := 1)
    (attempt := 2) (envelope := .processRestartNotice)
    (obs := [.dispatched 10 2]) hstep
  obtain ⟨record, recordPresent, _, _, coverage, _⟩ := hcoverage
  have recordEq : record =
      ⟨7, mixedMembers, [{ attempt := 1, result := some .unknown }]⟩ := by
    rw [mixedUnknownHistory] at recordPresent
    cases recordPresent
    rfl
  subst record
  have hlen := coverage.length_eq
  simp [BatchMemberObservations, mixedMembers] at hlen

/-- member coverage の長さが違う余分な観測は recovery transition にならない。 -/
theorem recovery_rejects_extra_member :
    ¬ ∃ t, BatchRecoveryStep mixedAfterUnknown
      (.batchRecoverySendStarted 7 1 2 .processRestartNotice)
      [.dispatched 10 2, .dispatched 20 2, .dispatched 99 2] t := by
  intro h
  obtain ⟨t, hstep⟩ := h
  have hcoverage := batch_recovery_observation_consistent
    (s := mixedAfterUnknown) (t := t) (batch := 7) (source := 1)
    (attempt := 2) (envelope := .processRestartNotice)
    (obs := [.dispatched 10 2, .dispatched 20 2, .dispatched 99 2]) hstep
  obtain ⟨record, recordPresent, _, _, coverage, _⟩ := hcoverage
  have recordEq : record =
      ⟨7, mixedMembers, [{ attempt := 1, result := some .unknown }]⟩ := by
    rw [mixedUnknownHistory] at recordPresent
    cases recordPresent
    rfl
  subst record
  have hlen := coverage.length_eq
  simp [BatchMemberObservations, mixedMembers] at hlen

/-- observation list の順を変えても recovery coverage は成立する。 -/
theorem recovery_accepts_reordered_members :
    ∃ t, BatchRecoveryStep mixedAfterUnknown
      (.batchRecoverySendStarted 7 1 2 .processRestartNotice)
      [.dispatched 20 2, .dispatched 10 2] t := by
  refine ⟨mixedAfterRecovery, BatchRecoveryStep.batchRecoverySendStarted ?_ ?_ ?_ ?_ ?_ ?_ ?_ ?_ ?_⟩
  · rfl
  · rfl
  · exact mixedMembersValid
  · exact ⟨[], rfl⟩
  · intro member memberPresent
    simp [mixedMembers] at memberPresent
    rcases memberPresent with rfl | rfl <;>
      simp [mixedAfterUnknown, mixedAfterStart, batchSendResultState,
        batchSendStartedState, setBatchMemberAttempts,
        mixedMembers, mixedInitial]
  · intro member memberPresent
    simp [mixedMembers] at memberPresent
    rcases memberPresent with rfl | rfl <;>
      simp [mixedAfterUnknown, mixedAfterStart, batchSendResultState,
        batchSendStartedState, dispatchBatchItems, mixedMembers, mixedInitial]
  · exact mixedAttempt2Fresh
  · simp [mixedAfterUnknown, mixedAfterStart, batchSendResultState,
      batchSendStartedState, mixedInitial]
  · simp [BatchMemberObservations, mixedMembers, List.Perm.swap]

/-- ID 差し替えまたは member ごとの attempt 不一致は完全 coverage にならない。 -/
theorem recovery_rejects_replaced_or_mismatched_attempt :
    (¬ ∃ t, BatchRecoveryStep mixedAfterUnknown
      (.batchRecoverySendStarted 7 1 2 .processRestartNotice)
      [.dispatched 10 2, .dispatched 30 2] t) ∧
    (¬ ∃ t, BatchRecoveryStep mixedAfterUnknown
      (.batchRecoverySendStarted 7 1 2 .processRestartNotice)
      [.dispatched 10 2, .dispatched 20 3] t) := by
  constructor <;> intro h
  · obtain ⟨t, hstep⟩ := h
    have hcoverage := batch_recovery_observation_consistent
      (s := mixedAfterUnknown) (t := t) (batch := 7) (source := 1)
      (attempt := 2) (envelope := .processRestartNotice)
      (obs := [.dispatched 10 2, .dispatched 30 2]) hstep
    obtain ⟨record, recordPresent, _, _, coverage, _⟩ := hcoverage
    have recordEq : record =
        ⟨7, mixedMembers, [{ attempt := 1, result := some .unknown }]⟩ := by
      rw [mixedUnknownHistory] at recordPresent
      cases recordPresent
      rfl
    subst record
    have expected : Observation.dispatched 20 2 ∈
        BatchMemberObservations mixedMembers 2 := by
      simp [BatchMemberObservations, mixedMembers]
    have actual := coverage.mem_iff.mpr expected
    simp at actual
  · obtain ⟨t, hstep⟩ := h
    have hcoverage := batch_recovery_observation_consistent
      (s := mixedAfterUnknown) (t := t) (batch := 7) (source := 1)
      (attempt := 2) (envelope := .processRestartNotice)
      (obs := [.dispatched 10 2, .dispatched 20 3]) hstep
    obtain ⟨record, recordPresent, _, _, coverage, _⟩ := hcoverage
    have recordEq : record =
        ⟨7, mixedMembers, [{ attempt := 1, result := some .unknown }]⟩ := by
      rw [mixedUnknownHistory] at recordPresent
      cases recordPresent
      rfl
    subst record
    have expected : Observation.dispatched 20 2 ∈
        BatchMemberObservations mixedMembers 2 := by
      simp [BatchMemberObservations, mixedMembers]
    have actual := coverage.mem_iff.mpr expected
    simp at actual

/-- failed は unknown と異なり、この process-restart recovery の source にならない。 -/
theorem failed_attempt_cannot_start_recovery :
    ¬ ∃ obs t, BatchRecoveryStep mixedAfterFailed
      (.batchRecoverySendStarted 7 1 2 .processRestartNotice) obs t := by
  intro h
  obtain ⟨obs, t, h⟩ := h
  cases h with
  | batchRecoverySendStarted recordPresent recordIdentity membersValid sourceUnknown
      membersLastAttempt membersDispatched attemptFresh attemptNotCompleted coverage =>
      rw [mixedFailedHistory] at recordPresent
      cases recordPresent
      rcases sourceUnknown with ⟨priorAttempts, sourceHistory⟩
      cases priorAttempts with
      | nil => simp at sourceHistory
      | cons first rest => simp at sourceHistory

/-- 完了済み attempt は再送元にならず、ack-only の既存境界を保つ。 -/
def mixedAfterCompleted : State :=
  batchSendResultState mixedAfterStart 7
    ⟨7, mixedMembers, [{ attempt := 1, result := none }]⟩ 1 .completed

/-- witness の completed result も同じ attempt の記録に残る。 -/
theorem mixedCompletedHistory :
    mixedAfterCompleted.batchHistory 7 =
      some ⟨7, mixedMembers, [{ attempt := 1, result := some .completed }]⟩ := by
  rfl

/-- completed attempt から recovery dispatch は開始できない。 -/
theorem completed_attempt_cannot_start_recovery :
    ¬ ∃ obs t, BatchRecoveryStep mixedAfterCompleted
      (.batchRecoverySendStarted 7 1 2 .processRestartNotice) obs t := by
  intro h
  obtain ⟨obs, t, hstep⟩ := h
  have hcoverage := batch_recovery_observation_consistent
    (s := mixedAfterCompleted) (t := t) (batch := 7) (source := 1)
    (attempt := 2) (envelope := .processRestartNotice) (obs := obs) hstep
  obtain ⟨record, recordPresent, _, sourceUnknown, _, _⟩ := hcoverage
  rw [mixedCompletedHistory] at recordPresent
  cases recordPresent
  rcases sourceUnknown with ⟨priorAttempts, history⟩
  cases priorAttempts with
  | nil => simp at history
  | cons first rest => simp at history

/-- recovery event の source は保存済み unknown attempt に一致しなければならない。 -/
theorem recovery_rejects_wrong_source_attempt :
    ¬ ∃ obs t, BatchRecoveryStep mixedAfterUnknown
      (.batchRecoverySendStarted 7 2 3 .processRestartNotice) obs t := by
  intro h
  obtain ⟨obs, t, hstep⟩ := h
  have hcoverage := batch_recovery_observation_consistent
    (s := mixedAfterUnknown) (t := t) (batch := 7) (source := 2)
    (attempt := 3) (envelope := .processRestartNotice) (obs := obs) hstep
  obtain ⟨record, recordPresent, _, sourceUnknown, _, _⟩ := hcoverage
  rw [mixedUnknownHistory] at recordPresent
  cases recordPresent
  rcases sourceUnknown with ⟨priorAttempts, history⟩
  cases priorAttempts with
  | nil => simp at history
  | cons first rest => simp at history

/-- record と state の kind が食い違うと、batch recovery を適用できない。 -/
def mixedWrongKindState : State :=
  { mixedAfterUnknown with
    items := fun id =>
      if id == 20 then some ⟨.operatorInput, .dispatched⟩
      else mixedAfterUnknown.items id }

/-- worker を operator input と読み替えた状態は recovery transition の前提を満たさない。 -/
theorem recovery_rejects_wrong_member_kind :
    ¬ ∃ obs t, BatchRecoveryStep mixedWrongKindState
      (.batchRecoverySendStarted 7 1 2 .processRestartNotice) obs t := by
  intro h
  obtain ⟨obs, t, hstep⟩ := h
  have hcoverage := batch_recovery_observation_consistent
    (s := mixedWrongKindState) (t := t) (batch := 7) (source := 1)
    (attempt := 2) (envelope := .processRestartNotice) (obs := obs) hstep
  obtain ⟨record, recordPresent, _, _, _, memberStates⟩ := hcoverage
  change mixedAfterUnknown.batchHistory 7 = some record at recordPresent
  rw [mixedUnknownHistory] at recordPresent
  cases recordPresent
  have workerPresent : mixedWorker ∈ mixedMembers := by
    simp [mixedWorker, mixedMembers]
  have workerState := (memberStates mixedWorker workerPresent).1
  simp [mixedWrongKindState, mixedWorker] at workerState

/-- recovery event 前で終わる有限 prefix は、batch recovery 完了を含まない。 -/
def mixedPrefix : List (Event × List Observation) :=
  [(.batchSendStarted 7 mixedMembers 1, BatchMemberObservations mixedMembers 1),
   (.batchSendResult 7 1 .unknown, [])]

/-- trace 内に全 member coverage を持つ recovery event がある。 -/
def HasBatchRecoveryCompletion
    (trace : List (Event × List Observation)) (batch : BatchId)
    (attempt : AttemptId) (members : List BatchMember) : Prop :=
  ∃ entry, entry ∈ trace ∧
    entry.1 = .batchRecoverySendStarted batch 1 attempt .processRestartNotice ∧
    entry.2.Perm (BatchMemberObservations members attempt)

/-- recovery event より前の prefix は completed recovery とみなされない。 -/
theorem prefix_before_recovery_is_incomplete :
    ¬ HasBatchRecoveryCompletion mixedPrefix 7 2 mixedMembers := by
  intro h
  obtain ⟨entry, entryInPrefix, eventIsRecovery, _⟩ := h
  simp [mixedPrefix] at entryInPrefix
  rcases entryInPrefix with entryIsStart | entryIsResult
  · simp [entryIsStart] at eventIsRecovery
  · simp [entryIsResult] at eventIsRecovery

end Ensemble.Flow
