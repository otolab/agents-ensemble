import Ensemble.AsIs.StoppedRecovery
import Ensemble.AsIs.ReconnectExploration
import Ensemble.AsIs.HistoryRecovery
import Ensemble.AsIs.ObservedHistory
import Ensemble.AsIs.ObservedLoss

/-! # 具体経路と抽象化の反例

ここで示すのは個別の対応や具体的な回復可能性に対する反例である。
#855 の命題自体が破れると示した箇所と、それを示していない箇所を区別する。
-/
namespace Ensemble.AsIs.Counterexamples

open Ensemble.AsIs

/-!
## commit 後・send 前に停止した入力の観測

`ObservedHistory.lean` の固定列は、初期状態から user input を受理し、batch を
選択・commit した後、send 開始前に停止する。具体 queue から入力が除かれ、
send は始まらず、runner は停止する。履歴はモデル上の dispatch 対象からの
不在を保持し、観測上は pending でも明示破棄でもない。この固定列を含む
限定射影は `NoEventLoss` と
`AcceptedEventRetained` を満たさない。4種類の固定操作・固定値の長さ3以下
85列には同現象がなく、提示列はこの範囲で最短。TS の実行時到達性は未検査。

TS の `run-operator-conversation.ts` は commit 後の停止結果で return し、
`operator-watch-dispatch.ts` は user batch を同期的に queue commit する。
`run-operator-waiters.ts` は operation 完了後にも停止を判定する。
これは静的対応であり、実行時の再現を示すものではない。TS には表示用 TUI
履歴も存在する。全保管先から内容が消失するとの証明ではない。限定射影は
`ObservationConsistent` も満たさない。合成モデル全体や TS 実行時の検証と
同一視せず、TS 到達反例の候補として扱う。
-/
example : ¬ Ensemble.Flow.NoEventLoss
    (ConcreteTrace.projectedInitial ObservedLoss.model ObservedLoss.initial)
    (ConcreteTrace.projectedStep ObservedLoss.model) := ObservedLoss.no_event_loss_fails

example : ¬ Ensemble.Flow.AcceptedEventRetained
    (ConcreteTrace.projectedInitial ObservedLoss.model ObservedLoss.initial)
    (ConcreteTrace.projectedStep ObservedLoss.model) := ObservedLoss.accepted_event_retained_fails

example : ¬ Ensemble.Flow.ObservationConsistent
    (ConcreteTrace.projectedStep ObservedLoss.model) := ObservedLoss.observation_consistent_fails

/-!
## 停止済み operator は限定した回復操作では戻れない

利用者から見ると、input の送信が未完了になった後、retry 保存待ちの間に
次の入力を受け、runner が停止すると、確認待ちと後から受けた入力が残る。
停止済みの同じ runner に対する下記の回復操作では確認待ちを解除できない。

具体列は `StoppedRecovery.stoppedExample` にある。input 1 を受理して送信し、
未完了で settle、input 2 を受理し、入力終了を経て retry 保存待ちで停止する。
retry 保存が完了する前に入力終了が起きる環境での列である。TS では
`packages/operator-agent/src/run/run-operator-conversation.ts` の `runTtyConversation`、
同 `run-operator-waiters.ts` の `retryWatchLock` が対応する。

任意長の対象は `StoppedRecovery.Action` の10種類に限る。任意の send 結果と
retry 保存結果は含むが、再起動やプロセス間競合は含まない。停止へ至る列の
最小性は未検査。
これは具体的な回復不能の反例で、#855 `RecoveryPossible` 自体の反例ではない。
-/
example : ¬ ∃ events,
    Ensemble.Flow.Eligible
      (StoppedRecovery.observeExample
        (StoppedRecovery.runActions StoppedRecovery.stoppedExample events)) 2 :=
  StoppedRecovery.no_concrete_eligible_recovery

/-!
## 射影された経路は停止済みの具体状態へ持ち上げられない

上の停止状態と、同じ途中列の retry 保存が成功した稼働中状態は、限定観測が
一致する。両端の射影を存在量化する抽象遷移は稼働中状態の解除操作を使える。
そのため抽象上は保留 input が eligible に戻るが、停止済みの元の具体状態から
上記の操作列で回復できることは意味しない。両状態はそれぞれ初期状態から
到達する。停止側の履歴には入力終了もあり、この観測ではそれを区別していない。
これは単純な射影接続と具体経路の対応に対する反例であり、全ての
履歴付き接続の不可能性や、`RecoveryPossible` 全体の真偽は示していない。
-/
example : ∃ trace target,
    Ensemble.Flow.Run
      (ConcreteTrace.projectedStep StoppedRecovery.recoveryModel)
      (StoppedRecovery.observeExample StoppedRecovery.stoppedExample) trace target ∧
    (∀ entry ∈ trace, Ensemble.Flow.RecoveryEvent entry.1) ∧
    Ensemble.Flow.Eligible target 2 := StoppedRecovery.projected_recovery_exists

/-!
この限定観測では、停止済み・稼働中の両履歴を同じ抽象状態に写す。
履歴を保持した具体回復可能性は両者で異なるため、#855 のように固定された
抽象遷移と抽象状態だけから回復可能性を判定する方法では、両方の具体履歴と
同値にはできない。別の観測や別の量化方法の不可能性は示していない。
-/
example : ¬ ∃ step : Ensemble.Flow.Transition, ∀ h : HistoryRecovery.History,
    HistoryRecovery.AbstractRecovery step (StoppedRecovery.observeExample h.state) ↔
      HistoryRecovery.ConcreteRecovery h :=
  HistoryRecovery.no_fixed_transition_exact_correspondence

/-!
## reconnect 成功後も自律ターン上限で worker が待つ

利用者には reconnect が成功しても worker 通知が処理されないように見える。
`ReconnectExploration.start` は、最初の worker を送って上限 1 に達した状態。
ここから worker 到着、reconnect 要求、reconnect 開始、成功結果を与えると、
次の send 試行でも worker が保留される。TS では
`packages/core/src/conductor/conductor-session-driver.ts` の
`runConductorSessionDriver`、`packages/core/src/conductor/session/select-dispatch-batch.ts`
の `selectDispatchBatch`、`packages/core/src/conductor/session-policy.ts` の
`canDispatchConductorSend` と `autonomousTurnsAfterConductorBatch` が対応する。

この開始状態と上記4種類・固定値の操作に限れば長さ3以下の85列に該当例はなく、
提示した4操作は最短である。初期状態からの全操作・全値域での最小性ではない。
通常入力処理で上限を戻せる。上限を記憶しない抽象 `Eligible` と具体選択の違いが
あり、この有限列を #855 の弱公平性付き `ReconnectResumes` の反例と断定できない。
-/
#guard (ReconnectExploration.blockedAfterSuccessfulReconnect ReconnectExploration.alphabet)
#guard ((Composition.tracesUpTo ReconnectExploration.alphabet 3).all
  (fun trace => !(ReconnectExploration.blockedAfterSuccessfulReconnect trace)))

end Ensemble.AsIs.Counterexamples
