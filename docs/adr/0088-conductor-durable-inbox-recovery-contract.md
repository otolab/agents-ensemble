# ADR 0088: Issue workflow の durable inbox と recovery 契約

- Status: accepted
- Date: 2026-11-28
- Related: [Issue #909](https://github.com/otolab/agents-ensemble/issues/909), [Issue #855](https://github.com/otolab/agents-ensemble/issues/855), [Issue #896](https://github.com/otolab/agents-ensemble/issues/896), [Issue #897](https://github.com/otolab/agents-ensemble/issues/897), [Issue #898](https://github.com/otolab/agents-ensemble/issues/898), [Issue #899](https://github.com/otolab/agents-ensemble/issues/899), [Issue #900](https://github.com/otolab/agents-ensemble/issues/900), [Issue #668](https://github.com/otolab/agents-ensemble/issues/668), [ADR 0072](0072-conductor-dispatch-lifecycle-and-recovery-boundary.md)

## Context

現行の Issue workflow は、通常 queue、dispatch hold、選択済み batch、recovery inbox を process 間で復元しない。accepted ADR 0072 はこの実装と従来契約を記録しており、operator-agent の watch report には別の pending report と retry 契約がある。

Issue #909 では、operator が process 再開後の通知・送信結果不明 batch・未選択通知の扱いを段階的に判断した。本 ADR は承認済みの将来契約を記録する。サイズ preflight で選択済み batch が過大と判明するのは通常経路ではなく異常経路であり、通常は batch 編成時の計測と text 分割で回避する。異常停止時は元 batch を保持して conductor 向け送信を止め、operator が batch 全体を明示破棄できる。破棄と producer 再取込防止を保存上確定する境界は、3回上限後の batch discard と同じである。容量や設定値、worker outbox の具体的な handoff protocol などの実装設計も残るが、それらは別の範囲である。

本 ADR は Issue #909 で明示承認された将来契約であり、runtime の現状説明ではない。現行挙動は lifecycle 文書の As-Is に従い、ADR 0072 は Issue workflow の本 ADR 対象部分に限って supersede される。

現行の send error 分類は再接続向けで、再送の安全性を判定するものではない。[`ConductorSendResult`](../../packages/core/src/conductor/conductor-agent.ts) は status と error message / code を持つが、send 呼び出しの有無、provider の受理、retryability を表す共通フィールドはない。[send helper](../../packages/core/src/conductor/conductor-send-reconnect.ts) は auth / transport の既知 signal を分類して同一 agent ID の reconnect を試すが、prompt は再送しない。send の reject は [`runEventConductorSend`](../../packages/core/src/conductor/conductor-session-driver.ts) で `send_rejected`（結果不明）に変換される。Cursor の `CursorAgentError.isRetryable` は例外 message に文字列化され、Pi は error message / code を返すため、backend をまたいで使える retryability 判定にはなっていない。Pi の adapter では send 前の local check も send method 内にあり、共通結果だけから request invocation の段階は区別できない。

## Decision

### 1. 適用範囲と ADR 0072 との関係

- 本 ADR の対象は Issue workflow の conductor 向け通知 inbox、process restart 後の復旧、batch delivery ack と producer handoff である。
- 本 ADR は conductor の共有 single lease、lifecycle の既存状態所有権、operator-agent の `pendingReports` / watch report の retry 契約を変更しない。GitHub monitor の cursor / `pendingUpdates` と operator-agent 用 queue や報告先は、それぞれの producer 側状態として扱い、conductor inbox と統合しない。
- 本 ADR は ADR 0072 のうち Issue workflow の process-local inbox、payload 除外、restart 後に復元しないこと、同一 operator input を自動 replay しないこと、およびその inbox に限った容量・寿命の方針を置き換える。ADR 0072 の他の適用範囲、とりわけ operator-agent の watch report 契約は維持する。
- ADR 0072 は本文を変更せず、Status のみ Issue workflow の本 ADR 対象範囲について部分 supersede とする。operator-agent の watch report 契約など対象外の判断は維持する。将来契約は現行 runtime には未実装である。

### 2. 保存対象と利用者から見える意味

| 通知種別 | 承認済みの保存範囲 | 再開後の意味・限界 |
|---|---|---|
| Operator input | TTY / 非TTY のいずれから受理した本文も inbox の保存対象とする。 | inbox の確認・管理 UI は TTY にまとめる。保存と表示は自動 dispatch とは別であり、保存された入力が直ちに送信される意味ではない。未選択項目は通常の eligibility・優先順位・hold に戻る。 |
| Permission | secret を含みうる raw payload を保存する。operator は session log にも残りうる情報であることを踏まえ、inbox に情報を残す方を選んだ。 | 復元表示は過去の通知であり、payload から live resolver や待機中 request は復元しない。古い request ID に allow / deny せず、有効な判断には worker からの live request を要する。 |
| Worker completed / failed | `worker.completed` の `WorkerDispatchResult` 全体と `worker.failed` の `WorkerFailureRecord` 全体を保存対象とする。 | inbox commit 前の process crash を越える回収保証は、producer outbox の application commit 成功後から始める。outbox commit 前の crash による欠落、電源断後の保持、最終配信は保証しない。 |
| GitHub notification | 既存の `GitHubUpdateItem` を保存する。既存 body preview は含むが、全文 comment や追加の raw API payload は含めない。 | producer pending の削除と inbox item の追加を同じ snapshot に含め、同じ atomic rename で確定する。既存 item ID で復元時の二重追加を識別する。 |

Operator input の保存判断は #668 で導入された TTY / 非TTY 差の由来を取り消すものではない。TTY と非TTY の入力受理・永続化を揃えた上で、UI と内部処理を分け、確認・管理だけを TTY に集約する将来方針である。

inq-15 は worker completed / failed outcome を inbox commit 前の process crash 後にも回収する契約を選び、producer outbox 等を必要とした。inq-24 の `outbox_commit` はその方針を取り消さず、回収保証の開始点を producer outbox の application commit 成功後と明確にした。したがって outbox commit 前の欠落窓は契約上残る。

現行の [`formatSessionEventsForConductor`](../../packages/core/src/conductor/session/format-session-event.ts) は、worker outcome・permission・GitHub の構造化 payload を YAML fenced text にし、複数 event には見出しと番号を付ける。operator message は text として整形する。したがって将来のサイズ検査で raw text だけを測ると、conductor に渡す実際の本文を過小評価する。accepted ADR 0072 の operator input 1 MiB 上限と operator queue の batch 分割は As-Is の契約であり、本 ADR の全通知種別に対する分割・拒否規則とは別である。

### 3. Inbox commit、producer handoff、delivery ack

これらは異なる境界である。

- **Inbox application commit:** inbox 更新を含む snapshot の atomic rename 成功を commit とする。成功前に通知を受理済みとして扱わず、conductor に送信しない。保存失敗時は受理・send を行わない。
- **電源断耐久性:** file / directory `fsync` はこの契約に含まれない。rename 成功は application commit であり、電源断後の保持を保証しない。
- **Producer handoff:** GitHub は pending item の削除と inbox 追加を一つの snapshot rename で確定する。worker outcome の process crash 越しの回収保証は producer outbox の application commit 成功後から inbox commit までを対象とする。outbox commit 前の crash は対象外で、outbox による回収元ができる前に outcome が失われる窓がある。サイズ検査で inbox が受理前拒否した場合は handoff 成功と扱わず、GitHub pending の削除も worker outbox の ack も確定しない。inq-24 の保証境界を保つには、worker outcome の inbox admission 検査を producer outbox commit 後・inbox commit 前に行い、拒否された item を outbox に未 ack で残す必要がある。outbox commit 前に拒否する場合、その outcome は q24 の回収保証境界外となる。上限超過 item が producer pending に留まり続ける可能性があり、最終的な inbox 受理・配信や滞留解消は保証しない。outbox の保存形式、安定 ID、再試行と inbox への handoff / ack protocol は実装設計に残る。
- **Delivery ack:** send が `finished` になった後、完了状態を含む snapshot の atomic rename 成功で ack を確定する。これは producer handoff ack とは別であり、外部副作用の exactly-once を意味しない。
- 稼働中に send 成功を確認した後で ack 保存が失敗し続ける場合、batch を再送・破棄せず ack 保存だけを retry し、conductor 向け送信停止を維持して operator に通知する。retry の具体回数・間隔や ack 確定までの時間は保証しない。
- send 完了後、delivery ack の rename より前に crash した場合、再開後は送信結果を不明として扱う。先の send が外部で実行済みだった可能性があり、同じ batch の復旧再送で副作用が重複しうる。ack 前 crash によるこの重複窓は残る。rename 後でも fsync がないため電源断後の保持は保証しない。

#### Crash 境界

| crash / 保存境界 | 再開時に言えること | 契約上の扱い |
|---|---|---|
| worker outcome が届いてから producer outbox application commit 前 | outcome は揮発状態にあり、process crash で欠落しうる。 | inq-24 で選ばれた保証境界より前なので回収を保証しない。 |
| worker outbox application commit 後、inbox commit 前 | producer outbox を再提示元として process crash 後に outcome を inbox へ回収する。 | ここから process crash 越しの回収保証を開始する。handoff / ack protocol は実装設計に残り、電源断後の保持や最終配信は保証しない。 |
| size preflight が inbox acceptance 前に拒否 | inbox item は未受理で、producer handoff / ack は未完了。 | GitHub pending は削除せず、worker outbox commit 済み outcome は未 ack で保持する。outbox commit 前に拒否する実装は q24 の回収保証境界外となる。拒否 item の滞留解消や最終配信は保証しない。 |
| worker outbox application commit 後、電源断 | rename / fsync 等の耐久性は outbox 実装に依存する。 | operator は application commit を選んだが、電源断後の保持は保証しない。 |
| GitHub pending item の inbox 移送前 | 同一 snapshot の atomic rename が未成功なら pending item を削除しない。 | item 追加と pending 削除を一つの snapshot commit にする。既存 ID で二重追加を識別する。 |
| inbox commit 後、選択前 | 受理済み未選択 item が残る。 | restart 後に復元し、通常の eligibility・優先順位・hold に戻す。 |
| batch 選択後、send 開始前 | send 未開始を永続状態から確実に判定できるかは未設計。 | 確実な未送信と結果不明を混同しない。どの境界を永続化するかは実装設計で詰める。 |
| send 開始後、結果が確定する前 | 外部 send の受理・処理・副作用は不明。 | delivery-unknown として元 batch / item identity を保ち、結果不明を明示した recovery request を送る。 |
| `finished` 確認後、delivery ack rename 前 | send 成功は観測済みだが、永続 ack はない。 | 稼働中は batch を再送・破棄せず ack-only retry を続け、conductor 向け送信停止を維持して operator に知らせる。ここで crash すれば再開時は delivery-unknown となり、同じ batch の復旧再送で副作用が重複しうる。 |
| delivery ack の atomic rename 後 | application-level delivery ack が確定している。 | fsync がないため電源断後の保持は保証しない。 |
| size preflight で送信前に過大と確定 | send は開始しておらず、配信結果は unknown ではない。通常経路での発生は想定しない。 | 元 batch と item を保持し、operator の応答を待つ間は後続を含む conductor 向け送信を停止する。send 試行回数には数えない。operator は batch 全体を明示破棄できる。破棄と producer 再取込防止が保存上確定した後に、この size-stop gate だけを解除する。3回上限停止とは別 gate。 |

### 4. Pending item と batch の復旧

- atomic rename で受理済みの未選択 item は process restart 後に inbox へ復元し、通常の eligibility・優先順位・hold に従って dispatch 対象に戻す。これは一定時間内の送信や最終配信を約束しない。
- 送信結果が不明な選択済み batch は、process 再開時に元の logical batch / item identity を保って復旧送信する。新しい ID に付け替えて #855 の規則を迂回しない。harness は conductor 内部の部分実行を推測せず、元通知・再送であること・結果不明を明示する。agent が正しく部分実行することや外部副作用の重複防止は保証しない。
- 送達不明 batch がある再開では、process 再開通知を先頭に置き、元 batch と同じ request で送る。再失敗が続く場合は古い recovery notice を積み重ねず、最新の通知だけを残す。これは conductor 内部の実行段階を表すものではない。
- 送達不明 batch がない場合も process 再開通知を送信対象とし、通常の集中 dispatch hold を通過させる。これは通常 queue の一括解除を意味しない。
- harness から conductor agent 内部の部分実行状況は見えない。再送時には元の通知・再送であること・結果不明を明示し、引き継ぐ情報は conductor が判断する。これは agent が正しく部分実行することや外部副作用の重複を防ぐ保証ではない。
- worker の同一 ACP session への再接続と、worker agent の作り直しによる context 喪失は別の状況として扱う。`session/load` の成功だけでは transcript を読めたとは判断しない。これらの状態を harness が通知し、conductor が引き継ぎを判断することは、inbox の producer handoff や最終配信保証とは別である。
- `finished` が確認された batch の ack 保存が失敗し続ける稼働中 process は、batch を再送・破棄せず ack-only retry を続ける。conductor 向け送信停止を維持して operator に通知する。retry の回数・間隔・完了時刻に保証値は置かない。process crash 後に ack が存在しない場合は delivery-unknown として扱い、同じ batch の再送で副作用が重複する窓が残る。
- 同一 batch の自動 send は初回を含め合計3回までとし、process restart をまたいで回数を保持する。ack-only retry はこの回数に含めない。自動 retry は `ConductorAgent.send()` 呼び出し前の一時的失敗だと根拠をもって確認できる場合に限る。この失敗は3回に数えず、具体的な retry 回数・間隔・停止時間は定めない。operator が希望した `retriable` の分類だけでは、自動再送の許可・安全性を意味しない。上限到達時には pending batch を破棄せず、conductor 向け送信全体を停止する。TTY operator は対象 batch を明示的に破棄するか、元 identity を保って再送するか選ぶ。operator の resend 操作1回につき対象 batch を1回だけ send し、自動 send の3回枠はリセット・補充しない。結果不明なら batch を保持して全体停止を続け、再度 operator の判断を求める。成功時は delivery ack の atomic rename が確定した後に後続送信を再開できるが、他の gate と hold はそのまま適用する。operator が明示 discard を選んだ場合は、batch と全構成 item の破棄、および同じ producer item の再取り込みによる復活を防ぐ状態が永続保存上確定した後で、この batch が起点の送信停止を解除する。解除後も残りは通常の gate と hold に従う。破棄は送達成功を意味せず、結果不明や外部副作用の重複可能性は残る。
- inq-30 / inq-31 により、3回の自動 send 上限は実際の `ConductorAgent.send()` 呼び出し回数で数える。呼び出し前の一時的な失敗だと根拠をもって確認できる場合に限り自動 retry し、その失敗は3回上限に数えない。これは harness の send 呼び出し前に起きた一時的失敗を根拠とする扱いであり、conductor / agent 内部の進行状況や provider が request を受理しなかったことを推測するものではない。
- `conductor.send.started` 通知と既存 `sendCount` は send 関数の呼び出し前に更新されるため、単独では実際の呼び出し境界を証明しない。将来の実装ではこの観測と send invocation の区別を保つ。既存の `auth` / `transport` 分類は reconnect の判断に限り、`retriable` signal だけでは自動 retry の根拠にならない。
- サイズ超過など、send 呼び出し前に一時的失敗ではないと確定できる場合は、自動 retry せず元 batch / item を保持し、operator に通知する。選択済み batch の size preflight が過大と判明した場合は、異常経路として「Batch の組み立てとサイズ」に記した全体停止と batch 単位 discard の扱いを適用する。これは結果不明や3回上限到達とは異なり、send 試行回数には数えない。その他の非一時的な send 前 failure class の停止範囲・解除動作は、この size-stop 契約から拡張しない。
- send invocation に到達した後の error / reject / timeout、または invocation 前かどうか・一時的かどうかを確定できない失敗は delivery-unknown として扱う。provider が未受理だったとは推定せず、同じ process 内で `retriable` を理由に再送しない。process 再開時は既承認の同一 batch recovery と3回上限を適用する。
- inq-31 は send 前一時失敗に対する retry の具体回数・間隔・停止時間を定めていない。これらは実装設計に残り、有限時間内の成功や回復を保証しない。確実な send 前失敗を3回上限から除く判断は維持する。
- operator が batch の破棄を選んだ場合、その logical batch と構成する全 item を明示破棄する。同じ producer item が再取り込みされても破棄済み item を復活させない。これは batch を解体して item を通常 queue に戻す操作ではない。3回到達後、または size preflight 異常停止中の明示 discard では、batch・items の破棄と再取込抑止が永続状態として確定してから、その batch が起点の送信停止を解除する。解除後も他の gate と hold は維持し、残りの通知は通常の eligibility・優先順位に従う。破棄は producer handoff ack / delivery ack や送達成功を意味せず、すでに起きた外部副作用も取り消さない。
- 同一 producer item の再取り込みによる復活を防ぐ仕組み（安定 ID、tombstone 等）と、その保持・容量の設計は未確定である。これらの設計は、上記の非復活契約を満たす必要がある。
- 明示 resend の結果が不明なら、同じ batch identity のまま全体停止を維持し、追加の operator 判断なしに再送しない。TTY operator の次の resend 操作があれば、その操作につき1回だけ再送する。3回到達後は、この対象 batch への operator 明示 resend だけが全体停止中に許される。この一回の操作は hold 状態や他 gate を解除しない。対象 recovery request は既承認の hold 取扱いに従い、他の item / 通知は停止したままで、自動枠も戻さない。send 成功後は ack rename の確定を待ち、確定後に後続送信を再開できる。再開時も他の gate と hold に従う。
- 3回到達後の明示 resend が失敗確定した場合も batch を保持し、conductor 向け全体送信停止を維持する。operator は再認証など環境を整えた後、同じ batch identity の resend をもう一度明示選択するか、batch と構成 item の discard を選べる。再送は operator の選択ごとに1回で、自動 send の3回枠を初期化・補充しない。失敗確定と結果不明は区別し、failure を理由に自動再送したり provider 未受理を推定したりしない。環境の再認証・修復そのものは保証しない。
- 3回到達による conductor 向け全体停止中は、通常なら集中 hold を通る GitHub の切断・復旧通知も送信せず inbox に保持する。この判断は、全体停止がない場合の通常 hold bypass を変更しない。batch のない process 再開通知も、hold bypass 以外の gate を通過しない。
- inbox item 単体の明示 discard は設けず、破棄操作は既承認の logical batch 単位に限る。3回到達後または size preflight 異常停止中の batch discard では、その batch と構成 item 全体を破棄し、同じ producer item の再取り込みで復活しない状態を永続確定してから当該停止を解除する。ユーザ message の取消機能は将来別途検討される可能性があるが、本 ADR では採用せず、利用者向け機能・保証として扱わない。

#### Batch の組み立てとサイズ

- 通常の優先順位・hold を守り、通知 item と分割済み text part を順番に batch へ詰める。item と batch の上限は別々に調整可能とする。整形後の conductor request サイズが batch 上限を超える前に batch を確定し、request heading / section 番号などの envelope と recovery notice も完成 request の測定に含める。
- 今回の対象である text は常に分割可能とする。「分割不能な text item」を通常の扱いとして残さない。一方、分割後の part 数または展開後サイズが item 上限を超える text は inbox acceptance 前に拒否する。受理前拒否は未受理として明示し、本文の切り詰めや、受理済み item の黙った破棄で代替しない。part 上限を超えた際の受付元への通知方法は実装設計に残る。
- 分割対象の正本は source item の内容と構造化 payload であり、サイズは raw text だけでなく conductor 向けに整形した全表現を対象にする。現行 formatter が YAML payload、fence、event heading、batch 番号を付加するため、それらと continuation marker の分を含める。各 part は元 item の内容・順序・構造化 payload との対応を保つ。full payload の各 part への重複添付や、構造化 field を無視した text だけの分割は、完成表現のサイズ検査をすり抜けてはならない。source payload と ordered part の具体的な対応付けは実装設計に残る。
- 上限の単位、既定値、設定方法、item の展開上限を part 数または同等のサイズで表す方法は未決である。数値は指定しない。画像等の media payload は今回の対象外であり、分割・拒否・保持の契約をここから推定しない。provider が追加する全 context のサイズや request の受理可否も保証しない。
- 通常は batch 編成時に整形後サイズを測り、text を分割して上限内に収める。選択済み batch がその後の size preflight で過大と判明するのは異常経路である。その場合は送らず、元 batch / item を保持して operator に通知し、後続 batch を含む conductor 向け送信を停止する。これは送達結果不明とも3回上限到達とも異なり、send 呼び出しがないため3回の自動 send 上限には算入しない。operator は batch 全体と構成 item の明示破棄を選べる。破棄と producer 再取込防止の永続確定後に size-stop gate を解除し、他の gate / hold は維持する。再検査は通常の運用経路にも必須手順にも定めないが、operator による再検査を禁止する判断もしていない。再検査の手段・結果や、それ以外の応答後の遷移は本 ADR では規定しない。

#### 状態の要約

| 状態 | 主な意味 | 再開・解決 |
|---|---|---|
| Producer pending / outbox | Inbox commit 前に producer が保持する再提示元。GitHub pending と worker outbox は別々の所有者を持つ。 | GitHub の移送は同一 snapshot rename。size rejection は handoff ack ではない。worker outcome は outbox application commit 成功後から process crash 越しの回収対象。拒否後も producer source は未 ack で保持するが、handoff の進行・最終配信は保証しない。outbox 前の欠落窓と電源断・最終配信の非保証は残る。outbox の ack・再試行方式は実装設計に残る。 |
| Inbox pending | rename 成功で application commit された未選択 item。 | restart 後に復元し、通常の eligibility・priority・hold に従う。 |
| Selected / delivery unknown | 選択済み logical batch の send 結果を harness が確認できない状態。 | restart recovery は元 identity を保つ。conductor 内の部分実行は推測せず、重複副作用を防がない。 |
| Ack pending | send `finished` を確認したが完了 snapshot の rename が未確定。 | batch を再送・破棄せず ack-only retry。operator に通知し、確定まで conductor 向け送信停止を維持する。回数・間隔・完了時刻は保証しない。crash 後は delivery-unknown となり、復旧再送による重複窓がある。 |
| Retry exhausted | 同一 batch の自動 send が合計3回に到達。 | batch を保持し、conductor 向け送信全体を停止。TTY の明示 resend は操作ごとに1回だけ行い、自動枠をリセットしない。結果不明なら停止を維持して再判断を求める。明示 resend の失敗確定後も停止を維持し、環境を整えた operator が resend / discard を選べる。send 成功後も ack rename の確定まで停止し、確定後は他 gate / hold に従って後続送信を再開する。明示 discard を選んだ場合は batch・構成 item の破棄と再取込抑止の永続保存が確定してから、この batch が起点の停止を解除する。 |
| Size preflight blocked | 通常は編成時のサイズ計測・text 分割で避ける異常経路。完成 request が send 前にサイズ上限を超えたと確定し、send は始まっていない。 | 元 batch / item を保持し、operator に通知して後続を含む conductor 向け送信を停止する。3回上限には数えない。operator は batch 全体を明示破棄でき、破棄と producer 再取込防止の永続確定後に size-stop gate だけを解除する。他 gate / hold は解除しない。再検査は必須でも通常手順でもないが、禁止もしない。 |
| Discarded / completed | operator が明示 discard した batch とその構成 item、または ack 済み batch。 | discard 済み item は同じ producer item の再取り込みで復活させない。retry-exhausted / size-stop batch の停止解除は破棄と再取込抑止の永続確定後に限り、残りは他 gate / hold に従う。discard は送達成功・ack ではなく、外部副作用も取り消さない。再取込抑止の方式と completed item の寿命は未決。 |

### 5. Hold、stale permission、保持と容量

- 集中 dispatch hold は restart 後も復元する。通常通知は保留する。
- 全体停止がない通常時は、GitHub の切断・復旧通知と delivery-unknown batch の recovery request は hold を通る。ただし通常 queue を解放せず、active send を中断せず、他の gate を通過させない。未選択 item は通常の hold・優先順位に従う。
- delivery-unknown batch がない場合の process 再開通知も集中 hold を通るが、通常 queue の一括解除はしない。3回到達による conductor 向け全体停止を含む別 gate は通過しない。
- 3回到達による conductor 向け送信全体停止中は、GitHub の切断・復旧通知も送信せず inbox に保持する。これは通常時の hold bypass とは別の停止 gate である。delivery-unknown batch は TTY operator の明示 resend によって、その操作につき1回だけ送信できる。成功後の ack 確定までは停止を保ち、確定後も他の gate と hold は維持する。
- size preflight stop は通常経路ではなく異常経路であり、batch 編成時の計測と text 分割で通常は回避する。発生時は3回上限による停止と理由を区別して、元 batch / item を保持し、後続を含む conductor 向け送信を止めて operator に通知する。通常時の hold bypass 対象もこの size-stop gate を通過しない。operator は batch 全体の明示破棄を選べる。batch・構成 item の破棄と producer 再取込防止が保存上確定してから size-stop gate だけを解除する。他の gate / hold は解除しない。再検査を通常ルート・必須手順にはしないが、operator が再検査することを禁止もしない。具体的な再検査手段・結果は実装設計に残る。
- 未完了 inbox item は期限で自動削除しない。容量不足時は新規受理を止め、operator に通知する。個別 item の discard は設けず、破棄は既承認の logical batch 単位に限る。retry-exhausted batch の discard では構成 item も破棄し、再取込抑止の永続確定後に当該 batch が起点の送信停止を解除する。ユーザ message の取消機能は将来別途検討される可能性があるが、この契約には含めない。数値容量と完了 item の寿命、抑止に使う安定 ID / tombstone 等とその保持・容量は実装設計に残る。

### 6. #855 の形式性質と保証の境界

- #855 の `NoAutomaticInputReplay` に対し、process restart 後の delivery-unknown batch 回収に限り、同じ input identity の recovery dispatch を例外として認める。この例外を形式モデルにも明示する。
- `restartRecoveryDispatch` は結果不明後の復旧再送に限る。3回上限後に TTY operator が選ぶ一回の明示 resend は別 event とし、元 input ID を保つ。さらに、その明示 resend が失敗確定した後は自動再送せず、環境を整えた operator が再度選ぶ `operatorResend` に限って同じ ID の再 dispatch を許す。通常 send の失敗確定からは再 dispatch しない。Lean は failure / unknown の判定根拠、再認証などの環境準備、operator が実際に選ぶこと、send 回数上限を保証しない。
- send invocation 前の一時失敗に対する retry はこの Lean property ではモデル化しない。これは dispatch 開始前の実行層の retry 判断であり、結果不明後の同一 ID replay 例外を広げない。
- 例外は ID 付け替えによる回避ではない。外部副作用の exactly-once、受信側での重複排除、内部の部分実行推定、最終配信を保証しない。
- 本 ADR は `NoEventLoss` / `AcceptedEventRetained` 等に restart durability や最終配信を追加しない。形式モデル上の abstract ID は runtime の永続 ID と同一であることを証明しない。3回 batch 上限や batch ID、永続化・fsync は、この `NoAutomaticInputReplay` の変更だけでは表現されない。
- 通常の priority / eligibility / hold を通した選択と、上限停止・容量不足・agent unavailable 等の gate が有限回で解消することを保証しない。公平性や最終配信は追加承認なしに主張しない。
- 将来 eventual dispatch の性質を提案するなら、少なくとも再開機会、保存成功、対象 item が継続して eligible であること、関連 gate が解除されること、scheduler の弱公平性、恒常的な高優先度項目による飢餓がないことを前提候補として明示する必要がある。これは本 ADR で採用する進行性保証ではなく、provider send / tool effect の成功も含まない。

## Consequences

この将来契約では、operator がどの通知を再開後に見られるか、どの送信結果が不明か、どの境界で inbox が受理・handoff・delivery ack を確定するかを区別できる。一方、rename の application commit は電源断耐久性を持たず、ack 前 crash の重複窓と外部副作用の重複可能性が残る。

現行 runtime は本 ADR の永続 inbox、payload 範囲、restart replay、batch 上限停止を実装していない。現行 lifecycle 文書は As-Is を保ち、本 ADR への案内と未実装である旨だけを示す。

## 未決の実装設計事項

worker outbox の保存形式、stable ID、retry / ack protocol、inbox への安全な handoff は実装設計上の依存であり、inq-24 で決めた保証開始点を満たす方法を詰める。これらは operator が選んだ契約境界を広げない。ack-only retry の具体回数・間隔、通知方法、discard 後の producer item 再取込抑止方式（安定 ID / tombstone と保持・容量）、send 開始前の永続状態も実装設計に残る。ack retry に数値・時間の利用者保証は置かない。

item / batch 上限の単位・既定値・設定経路、item の part 数または展開後サイズの上限、容量値・completed item の保持期間は実装設計に残る。これらは、「未完了 item を期限削除しない」「満杯時は受理を止めて通知する」契約を保つ必要がある。数値・設定経路だけを operator 承認待ちにはしない。size rejection で inbox が受理しない場合、producer handoff は確定せず、source item を未 ack で残す。outbox 内の rejected item の可視化・滞留解消は、受理境界を変えない実装設計として詰める。batch discard 後の再取込抑止も、安定 ID / tombstone と保持・容量を設計し、破棄済み item を復活させない契約を守る。inq-31 が定めたのは「send 呼び出し前の一時的失敗に限り自動 retry する」という境界である。失敗分類を裏付ける実装根拠、具体的な retry 回数・間隔・停止時間は実装設計に残り、agent 内部の部分実行や provider の未受理を推定する根拠に使わない。

これらの設計値・手段は Issue #909 で承認された利用者向け契約を実装するための詳細であり、別途変更判断がない限り本 ADR の保証を広げない。
