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

利用者から見ると、input 1 の送信失敗後に confirmation が必要となり、
その間に受けた input 2 が保留されたまま runner が終了する。終了した同じ
runner では confirmation を解除できず、対象操作をいくら続けても input 2 を
eligible にできない。

`StoppedRecovery.stoppedExample` は、初期状態から input 1 を選択・送信し、
未完了結果を settle して confirmation を残し、user-only retry 処理を通った後に
input 2 を受理する。
user-only batch の `recordRetry` は TS で report がない場合に即時 return するため、
この列では retry 保存待ちに EOF が割り込むとは仮定しない。その後 `canDispatch`
が false の待機に入り、SIGINT 等の `requestStop` が `stopping` を解決して
runner を return させる。Lean の `operatorWaitStopped` はこの wait 終了境界を表す。

対応する TS は `packages/operator-agent/src/run/run-operator-conversation.ts` の
`handleSubmittedInput`、send 結果後の `settleConductorDispatch`、`!canDispatch` の
`waitForChange` / `stopping` race と `requestStop`、および
`packages/operator-agent/src/watch/operator-watch-dispatch.ts` の `recordRetry`。
既存 test `packages/operator-agent/src/run/run-operator-agent-recovery.test.ts` の
`keeps only authored input after a failed first Cursor send and waits for confirmation`
は失敗後の confirmation と後続入力を個別に確認する。停止までを同じ test で
通す実行確認はなく、ここは静的な呼び出し経路を Lean に接続した結果と区別する。

任意長の no-path 定理は `StoppedRecovery.Action` の10種類を対象とし、停止後の
recovery continue、resume-watch、hold 解除、reconnect とその結果、send / retry
結果および内部待機を同じ concrete state に適用する。再起動・process teardown・
プロセス間競合は含まない。停止へ至る trace の全値域に対する最小性も未検査。

別の有限列 `reportRetryWaitingStart` は report send の未完了後、retry lock 待機中に
input 2、EOF、retry 停止を続ける。既存 test
`packages/operator-agent/src/run/run-operator-agent-watch.test.ts` の
`stops after retry lock acquisition races with eof` は report retry lock 中の EOF と
runner 終了を実行確認するが、input 2 を追加してはいない。追加 input が retry
wait 中に受理されて queue に残る点は実装経路に基づくモデル結果である。この固定
待機状態・操作集合・値では長さ2以下の13列を探索し、提示した3操作が最短。
どちらの concrete no-path も、#855 `RecoveryPossible` 自体の反例とは呼ばない。
-/
example : ¬ ∃ events,
    Ensemble.Flow.Eligible
      (StoppedRecovery.observeExample
        (StoppedRecovery.runActions StoppedRecovery.stoppedExample events)) 2 :=
  StoppedRecovery.no_concrete_eligible_recovery

/-!
## 射影された経路は停止済みの具体状態へ持ち上げられない

上の停止状態と、requestStop なしで同じ user failure / retry 保存成功に至った
稼働中状態は、`observeExample` では一致する。稼働中の状態では recovery continue
が confirmation を解除し、input 2 が eligible になる。停止済み状態では同じ具体
操作が no-op であり、`StoppedRecovery.no_concrete_eligible_recovery` が任意長の
対象操作列の後も候補観測上の `Eligible` に至らないことを示す。これは transport
が実際に send を受け付けるかを直接判定する述語ではない。
`HistoryRecovery.no_fixed_transition_exact_correspondence`
は、この限定観測と操作集合の下では一つの固定 abstract `Transition` が両履歴の
具体回復可能性を同時に正確に表せないことを証明する。

これは #855 `RecoveryPossible` の不成立を示さない。#855 の式は指定された abstract
initial / transition 上での存在量化であり、上記 Lean の「projected recovery」は
同じ観測を持つ live concrete state から遷移を借りる候補射影である。全履歴を
保つ abstract transition と TS との関係はまだなく、この経路を stopped history の
実回復として扱わない。別の状態観測や履歴添字付き関係の不可能性も示していない。
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
availability は戻るが、次の send 試行でも worker は保留される。上限なしと
上限 2 の対照では同じ列の後に send を開始でき、reconnect 自体は turn 数を
リセットしない。TS では
`packages/core/src/conductor/conductor-session-driver.ts` の
`runConductorSessionDriver`、`packages/core/src/conductor/session/select-dispatch-batch.ts`
の `selectDispatchBatch`、`packages/core/src/conductor/session-policy.ts` の
`canDispatchConductorSend` と `autonomousTurnsAfterConductorBatch` が対応する。

この開始状態と上記4種類・固定値の操作に限れば長さ3以下の85列に該当例はなく、
提示した4操作は最短である。初期状態からの全操作・全値域での最小性ではない。
operator input の到着・send・完了・後続 worker 選択という4操作で再開する。
同じ4記号の長さ3以下85列では対象 worker send は始まらない。別の固定列では
dispatch hold が reconnect 成功後にも残るため worker を held に保ち、hold 解除・
send 開始の後に再開する。これらの列は #855 `ReconnectResumes` の
`EligibleUntilDispatch` 前提を満たさず、弱公平性付き元命題の反例ではない。
TS runner 全体での無限待機の実行可能性、全操作・全値域に対する最小性は未検査。
-/
#guard (ReconnectExploration.blockedAfterSuccessfulReconnect ReconnectExploration.alphabet)
#guard ((Composition.tracesUpTo ReconnectExploration.alphabet 3).all
  (fun trace => !(ReconnectExploration.blockedAfterSuccessfulReconnect trace)))
#guard (ReconnectExploration.targetWorkerStarted ReconnectExploration.operatorInputRecoveryTrace)

end Ensemble.AsIs.Counterexamples
