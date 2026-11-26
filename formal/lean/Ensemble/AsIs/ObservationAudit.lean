import Ensemble.AsIs.StoppedRecovery

/-! # 停止状態の観測候補の照合

対象は停止・保存成功で分岐する2つの到達例であり、全状態の観測の完全性は示さない。
-/
namespace Ensemble.AsIs.ObservationAudit

open Ensemble.AsIs.StoppedRecovery

/- operator のすべてのフィールドは stopped を除き一致する。
   System 側の retry 出口理由は意図的に一致しない。 -/
#guard ({ liveExample.operator with stopped := true } == stoppedExample.operator)
#guard (liveExample.operator.queue == stoppedExample.operator.queue)
#guard (liveExample.operator.lifecycle == stoppedExample.operator.lifecycle)
#guard (liveExample.operator.stopped == false && stoppedExample.operator.stopped)

/-- 停止状態を availability に畳み込む候補。実際の lifecycle availability とは異なる。 -/
def readinessEncodedAvailability (s : Ensemble.AsIs.Composition.System) : Bool :=
  s.operator.lifecycle.available && !s.operator.stopped

/- この候補は到達例を区別できるが、停止側の lifecycle の true を false に変える。 -/
#guard (stoppedExample.operator.lifecycle.available &&
  !(readinessEncodedAvailability stoppedExample) &&
  readinessEncodedAvailability liveExample)

end Ensemble.AsIs.ObservationAudit
