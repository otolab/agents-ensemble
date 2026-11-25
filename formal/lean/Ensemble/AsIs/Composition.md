# 合成モデルの検査状況

この文書は作業途中の対応表であり、TS 全体の形式化や #855 の全命題の判定を示すものではない。TS を現状の基準とし、抽象仕様との違いは検査結果として扱う。

## TS と Lean の対応

| TS の対象 | 合成モデルの状況と限界 |
| --- | --- |
| conductor の batch 選択・send・reconnect | `ConductorQueue` と lifecycle を接続。非同期 driver の全停止・割り込み・予約失敗は未対応。 |
| operator の input、hold、send、retry 保存、ack、reconnect | `OperatorDispatch` を接続。commit 待機を分離し、成功後の同期的な send 開始までを同じ遷移とする。永続化と外部通信の詳細は未対応。 |
| `handleInputEnd`、`/exit`、`handleSubmittedInput` | 入力終了後の通常入力・reconnect・resume-watch・recovery continue は受け付けない。`/exit` の戻り値 `exitContinuity` や focus 等の表示操作は未表現。 |
| `retryWatchLock` の retry 保存 | 入力終了または `requestStop` 後の停止、timeout 以外の例外、成功を区別する。lock の timeout 回数や操作の開始・完了タイミングは外部から与え、実際の lock や保存自体は表さない。 |
| 入力終了後のループ終了 | pending user と reconnect がなく、send・retry・ack 等の処理が終わった時点で終了可能とした。driver の control point を厳密には表しておらず、他の途中状態との網羅的な照合が必要。 |
| 両主体間の通信 | operator message の conductor 到着や watch report は外部イベントとして与える。transport、poll、重複、再起動、プロセス間競合は表さない。 |

`operatorRequestStop` は停止要求を記録するが、TS の TUI 無効化、signal、他の待機処理への同時作用を完全には再現していない。たとえば別の遷移が停止要求と競合する場合の順序は未検査である。したがって合成モデル上の任意の経路を TS の実行と同一視できない。

## ADR 0086 §7 と停止境界

ADR §7 が純粋 step 関数への**差分テスト**から除くのは、非同期 driver 全体、lock 競合、プロセス間競合である。停止結果や停止後に残る lifecycle・queue まで検査対象から除外する趣旨ではない。Phase 0 の本作業では TS を静的に照合し、観察する停止境界を明示する。実際のスレッド間順序や lock の網羅、TS との実行時差分・イベントログ検証はここでは実施していない。

| TS の待機箇所 | モデル上の扱いと残る限界 |
| --- | --- |
| send と `stopping` の race | 停止要求後に send 中断を選ぶと runner は停止し、lease を残す。send 結果が先に得られる競合もあり得るが、Promise の完了順序を実行時に検証していない。 |
| retry 保存 | 入力終了または停止要求による通常停止と、例外を区別する。timeout の再試行中も入力終了で停止し得る。 |
| ack retry の待機 | `waitForAcknowledgementRetry` は ack から既定値で呼ばれるため、入力終了ではなく停止要求で止まる。ack 操作自体の完了・失敗は外部結果として扱う。 |
| batch commit の待機 | 選択・予約・lease 取得後を保持し、停止時に reservation を解放、lease を settle して終了する。commit 前と queue 更新後の停止を区別する。reservation の識別子と byte 数を保持し、予約容量の可否は外部から与える。例外時の rollback は `afterCommitError` を使う。 |
| reconnect・idle 待機 | TS は停止 signal により待機を抜け得る。合成モデルには要求・結果はあるが、待機箇所ごとの停止境界は未表現。 |

reconnect・idle 待機の行は、単に lock 競合の全列挙が対象外という話ではなく、対象とする停止結果が具体モデルにまだ含まれないという未達である。予約から lease 取得までの同期区間は単一の `operatorBeginCommit` 遷移であり、commit 成功後の同期区間も send 開始と一体にする。送信結果の予約有無・capture 設定は保持した状態から決め、空入力には予約を作らず、入力 byte 数の上限を確認する。ただし snapshot の容量・期限切れ・dispose と外部入力 `reservationOk` との整合、reservation token の失効、他の非同期 control point の全イベント制約は未検査である。静的照合は TS との対応の根拠になるが、実行時テストや網羅性の証明にはならない。

容量などを外部結果として扱う場合、具体経路として使うには、TS の inbox 状態でその結果が実際に起き得ることが前提となる。モデルはこれを検証しないため、`reservationOk` を任意に選ぶ探索は過大近似である。そこで見つかった列を、実行可能性を別途確かめず TS の反例とは扱わない。

user batch と凍結済み batch の queue commit は `commitBatch` の呼び出し中に実行され、その後に await が制御を戻す。未凍結 report は lock の取得後、`isBatchCurrent` で再選択してから同期的に queue 更新と永続化を行う。モデルでは user と凍結済み batch の queue 更新を待機開始と同じ遷移に置き、report は待機中の callback と再選択、queue 更新後の callback を区別する。lock 解放失敗や永続化例外の細かな時点までの全経路はまだ照合していない。

## #855 の性質

| 性質 | 現時点の検査 |
| --- | --- |
| `ObservationConsistent` | **限定例・未判定**。`DelayedRetry` の限定例は成立。残作業は主体別履歴の全遷移と項目・attempt の全 ID について観測と状態変化の双方向対応を検査すること。 |
| `RecoveryPossible` | **到達反例・未判定**。停止後に限定回復操作の任意長の列で具体回復しない例がある。残作業は停止・実行可能性と元命題の量化の対応を構成すること。元命題自体の反例ではない。 |
| `ReconnectRestoresAvailability` | **局所証明・未判定**。operator の有効な成功結果は主体別履歴の観測でも availability を回復する。conductor は具体状態の局所定理まで。残作業は両主体の全結果イベントの観測条件を接続すること。 |
| `ResumeWatchPreservesReportHold` | **局所証明・未判定**。任意の主体別履歴で resume-watch 前後の観測が report hold を保持することを証明。残作業は全体遷移との対応を証明すること。 |
| `ReleaseIndependent` | **局所証明・未判定**。個別操作の一部を証明。残作業は全解除操作の項目・hold・lease・retry の観測を主体別に検査すること。 |
| `NoEventLoss` | **限定射影の到達反例**。commit 後停止の固定具体列で受理済み入力が dispatch・明示破棄なく pending でなくなる。全体接続と TS 実行時の到達性は未検証。 |
| `AcceptedEventRetained` | **限定射影の到達反例**。同じ固定列の受理直後からの保持が成立しない。全体接続と TS 実行時の到達性は未検証。 |
| `NoAutomaticInputReplay` | **限定例・未判定**。有限例と条件付き含意のみ。残作業は失敗 attempt と input ID を履歴上で対応付け、以後の全遷移で再 dispatch されないことを証明すること。 |
| `ScheduledDispatches` | **到達例・未判定**。operator は選択後の停止で send に至らない。残作業は抽象 schedule の対応を定め、元命題を直接検査すること。選択との同時対応では十分条件を満たさない。 |
| `HoldExemptDelivered` | **条件付き証明・未判定**。抽象上の含意と、選択・dispatch を分けた具体実行の条件付き定理がある。残作業は permission stall の具体到達列と無限実行で公平性・選択後進行を検査すること。 |
| `ReconnectResumes` | **限定探索・未判定**。上限待機の到達済み無限列は限定観測では弱公平でなく、元命題の反例にならない。残作業は具体公平性と抽象公平性の対応、選択後進行、対象ごとの無限実行の検査。 |

ここでいう具体履歴への片方向の含意は、具体遷移の両端を射影した遷移で**元命題が成立する場合**の一般定理である。全履歴の観測・イベント対応を構成したという意味でも、抽象経路を具体経路へ逆向きに持ち上げられるという意味でもない。

`ObservedHistory.lean` は主体付きの具体履歴を保持し、operator の user・report の受理、batch の dispatch、完了、report 再投入・retry 停止、完了後 ack の試行・待機・終了、reconnect 要求・開始・結果、resume-watch・recovery continue・report hold、conductor の単一 worker の受理・dispatch・完了と dispatch hold を記録する部分実装である。再投入では report ID を用い、queue の物理 ID と論理 ID を分ける。両主体で同じ数字の ID を使用する例と、初期状態からの reconnect 成功列、主体別の hold 操作列を検査する。完了後に ack が失敗してから待機し、再試行に成功する限定列では send を繰り返さず、観測に ack の期限と operator の時刻を保持する。ack 操作が具体 dispatch 記録を追加しないことも証明した。

operator の commit・ack の時刻は履歴に保持し、後退する指定を未対応として扱う。これはモデル側の限定であり、TS の `Date.now()` が単調であるとの証明ではない。conductor の時刻や各入力・外部結果の時刻、待機の全順序を接続したわけではない。未対応遷移・空の report ID・conductor の複数項目 batch、全履歴の状態射影と観測整合性・公平性は未検査であり、この部分実装によって全性質が成立すると主張しない。

user input の commit 後、send 開始前に停止する初期状態からのモデル列では、入力はモデルの queue と準備中 batch の双方に存在せず、send は始まらない。履歴は dispatch 対象からの不在を保持し、明示的な破棄観測を追加しない。この固定列だけの射影について、`NoEventLoss`、`AcceptedEventRetained`、`ObservationConsistent` の不成立を Lean で証明した。固定した4操作・固定値の長さ3以下の85列には同現象がなく、提示した4操作がその範囲で最短である。

TS では user batch の queue commit の後、待機結果が停止なら runner は return する。reservation の解放は queue への入力復元ではなく、この経路に明示破棄操作もない。合成モデルの当該遷移には runner 停止を反映した。ただし TS 実行時にこの停止が commit 後の await 間で実際に起こるかは未検証である。限定射影の結果を全遷移の観測接続や TS 実行時の反例と同一視しない。

受付時の文字列は queue だけでなく、TUI の表示用 dialogue entries にも追加される。commit 待機中はローカル変数の batch と `operatorInputTexts` にも存在する。recovery inbox の reservation は容量と token を保持するが入力本文は保持せず、停止時に release される。送信前の停止分岐は recovery snapshot の commit や agent send に到達しない。表示用履歴が自動 dispatch に使われることは上記経路では確認できないが、全保管先の不在や内容の完全消失は証明していない。

停止通知は stdin の終了、SIGINT / SIGTERM、TUI の interrupt 等から生じる。queue commit の `notify` は登録済み listener を同期呼び出しする。調査した標準の hold 表示・idle gate と待機解除の listener には停止要求を起こす経路を確認できなかったが、公開 subscribe のすべての利用可能な callback や外部イベント順序を網羅した証明ではない。同期 commit と waiter 継続の間に実際の停止通知が入る根拠は確定しておらず、この列は **モデル反例候補**として扱う。

独立確認で、当初の固定例は「非空入力」としつつ byte 数が既定値 0 だったため、1 byte に修正して証明と限定探索を再実行した。また、限定射影では選択と停止要求をそれぞれ tick に対応させるが、現状の `History.entries` はその tick を保存しない。この証明は固定列の射影についてのものであり、記録済み entries の全遷移接続や観測整合性を証明しない。TS の user commit は同期的に queue を更新してから解決済み Promise を返すため、外部停止イベントが await 後の継続より先に割り込めるかは別途の実行時確認が必要である。

停止済み report 失敗例では、具体側の dispatch に必要な条件に停止していないことを含める。初期状態からの具体列で停止に到達した後、`StoppedRecovery.Action` に列挙した回復操作の任意の有限列では、この必要条件を満たせず、新しい commit も開始できない。再起動や対象外イベントは含まない。一方、同じ履歴の暫定観測では後続入力が #855 の `Eligible` に該当する。これは #855 の `RecoveryPossible` の反例ではなく、抽象経路の存在と具体回復可能性を同一視できないことを示す。停止を availability に織り込むことはしていない。

operator の具体履歴は batch の選択と send 開始を別々に保持する。選択後の停止要求により send が始まらない限定列も検査した。暫定的な抽象 `schedule` は send 開始時に記録するため、これを具体 scheduler の選択と同一視して弱公平性を移すことはできない。具体選択を抽象 `schedule` に対応させると、その限定列では `ScheduledDispatches` の同一遷移での dispatch という十分条件が成立しない。ただし、この十分条件が成立しなくても進行性の命題自体が成立する可能性は残る。

`ConcreteTrace.concrete_fair_eventually_dispatched` は、具体実行において対象が dispatch まで可能であり続け、具体選択が弱公平で、可能な状態での選択が後の dispatch に至るなら、最終的に dispatch されることを直接証明する。最後の進行条件は公平性とは独立の仮定であり、合成モデルで成立することは未証明である。上記の停止例は選択から send への無条件の進行を否定するが、dispatch まで可能であり続けるという命題の前提まで満たす反例ではない。`ReconnectExploration` の上限待機を繰り返す到達済み無限実行は、限定観測では連続 eligible にもかかわらず対象選択がなく、#855 の弱公平性を満たさない。全体モデルの具体公平性と抽象公平性との対応は未構成である。

`Counterexamples.lean` に限定範囲の反例を記載する。停止例の最小性は未検査。reconnect 例の最小性は、固定した開始状態と4種類の固定操作についてのみ長さ3以下を全探索した結果である。いずれも #855 の元命題自体の反例とは主張しない。

## 全体判定までの未解決点

- operator の send 中断と retry 保存例外を履歴に追加した。send 中断の固定列では結果を捏造せず、lease を保持した停止を観測する。ただし commit 例外、停止した ack、空 report ID、入力・report の全到着条件と各観測の一対一対応は未検査。
- conductor の履歴は単一 worker の成功経路と hold に限る。複数項目 batch、permission stall、reconnect、失敗・例外、operator からの到着を同じ主体別履歴に接続する必要がある。
- 遅延 send 結果、保留中の他イベント、時刻と retry 期限について、各具体遷移の両端と記録したイベントの整合性を証明する必要がある。`supported` は全遷移の忠実性を保証する不変条件として証明されていない。
- 無限実行では具体 scheduler の選択と dispatch を区別し、具体側の弱公平性、選択後の進行、抽象命題の `Eligible` を結ぶ必要がある。有限探索はこの証明にならない。
- 停止済み具体 runner と #855 の停止フラグを持たない状態の間では、具体回復可能性と `RecoveryPossible` の存在量化が一致する一般的な接続を構成できていない。既存の限定観測の反例は全ての観測方法の不可能性までは示さない。候補となる観測の全項目・全遷移の忠実性を示す作業が残る。

これらは単一の不足定理を補えば解ける段階には至っていない。特に全遷移と無限実行の具体的な接続・証明方法が未確定のまま、同じ全体未判定が続いている。現状の部分結果を完成と扱うことはできず、作業範囲や #855 を独断で変更せずに完了できる見通しは立っていない。

## #859 の受け入れ条件

| 条件 | 現状 |
| --- | --- |
| #855 の全性質を合成モデル上で検査 | 未達。主体別の全履歴の観測接続がなく、上表の未判定を残す。 |
| 破れる性質ごとの最小反例と日本語説明 | 部分的。限定例は記録済みだが、#855 の命題違反を確定できず、停止例の最小性も未検査。 |
| reconnect 後の再開 | 限定された具体列と、その範囲での最小性を記録済み。弱公平な無限実行の命題に対する判定は未達。 |
| 探索範囲外と抽象化の限界の一覧 | 本文書に記載。追加の未対応が見つかれば更新する。 |
| #848 の Phase 1 判断材料 | 途中経過を記録済み。全性質の判定・重大度を欠き、最終材料は未達。 |
| `sorry` と標準外公理がない | 現在の追加モジュールについて build と公理監査を実施。成果物全体の最終確認は PR 前に再実施する。 |

## #848 Phase 1 の途中判断材料

- 停止、通信可能、確認待ち、処理中は別々に保持する必要がある。availability が true でも同一 runner が停止していれば再開可能とは限らない。
- reconnect 成功は availability の回復を意味し、dispatch 再開までを保証しない。自律ターン上限など別の条件を含めて確認する必要がある。上限待機の到達例を弱公平な無限実行の反例とは扱えない。
- commit と send の間の停止時に入力をどこで保持し、運用者が確認・再投入できるかを検討する価値がある。ただし候補列の TS 実行時到達性は未確定で、現時点では障害の発生を断定できない。
- 完了済み send の ack だけを再試行することは、限定モデルの具体列で検査できる。実運用の再起動・永続化・副作用の重複まではこの結果から判断できない。
- 全性質の判定と公平性・観測の接続が未達であるため、Phase 1 の最終判断や変更範囲を確定する材料としては不足する。
