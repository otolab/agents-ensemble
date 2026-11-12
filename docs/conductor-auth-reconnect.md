# conductor send の再接続と失敗後の確認

> **正本:** conductor send の再接続、入力の確認、失敗後に後続 dispatch を再開する契約。認証情報の解決は [settings.md](settings.md) と [config.md](config.md)、利用者向けの入力操作は [operator-input.md](operator-input.md) を参照します。

## 再接続と prompt の再送

auth-like / transport error で `agent.send()` が結果を返した場合、共通 helper は同じ `agentId` の `close` → `resume` を一度試みます。**resume は失敗した prompt の再送を意味しません。** send の返却結果だけでは provider が request を受け付けていないと証明できないため、auth / transport を含む全 failure class で同一 prompt の自動 retry は行いません。

auth-like 判定は `error.code === "auth"`、認証・401 を示す message、および明示的な code / message / result がない bare `status: "error"` を含みます。bare error は stale connection 等を拾う保守的な既存 heuristic で、明示的な非 auth code があれば対象外です。transport 判定は connection stall / reset / timeout 等の既知 signal に限ります。Pi の API-key resolver failure、Pi のその他の auth / provider 401、Cursor auth error はいずれも auth-like として扱います。

`agent.send()` が reject した場合は `send_rejected`（結果不明）として扱います。例外本文は recovery data に残さず、auth / transport reconnect を自動実行せず、同じ prompt も再送しません。agent は unavailable とし、operator が明示的に `/reconnect` するまで queue の次の dispatch を止めます。

## workflow ごとの queue と共通 lifecycle

Issue session と operator-agent は、それぞれの queue、selector、優先順位、hold、batching を維持します。共通 `ConductorDispatchLifecycle` は一つの send / reconnect だけを lease し、availability、結果の settle、未確定 send 後の confirmation gate を管理します。lease は in-flight attempt の所有権で、第二の scheduling queue ではありません。

```text
workflow 固有 queue / selector / priority / hold
  → send 前 admission と reservation
  → 単一 lease（send または reconnect）
  → 共通 lifecycle が結果を settle
       成功: workflow 固有の完了処理
       operator input の未完了: TTY recovery inbox と confirmation gate
       watch report の未完了: 既存 report retry
  → dispatch 可能な状態なら次の selector へ
```

send / reconnect の await 中に届いた入力は既存 queue が保持し、復帰後に workflow 固有 selector が優先順位と到着順を適用します。失敗した user input は通常 queue に戻しません。resume に失敗した closed handle へ後続入力を送ることもありません。

## failure ごとの挙動

| workflow / backend / failure | 自動 reconnect | 同一 prompt の自動 retry | 入力・通知・後続処理 |
|---|---|---|---|
| Issue の初回 send — Cursor の compiled prompt または Pi の kickoff — auth-like / transport | 該当 signal なら同じ agent ID で1回 | しない | 初回 prompt は operator-authored input ではないため inbox に保存しない。CLI / env の初回 operator message は別の `operator.message` として queue に残る。TTY は失敗状態を確認して `/recovery continue` できる。非 TTY one-shot は本文を確認できない旨を出して error 終了し、queue に残った初回 operator message も process 終了時に失われる |
| Issue の初回 send — 未分類 error / その他の未完了 status / `cancelled` | auth / transport 判定にも該当する場合だけ同じ agent ID で1回 | しない | compiled prompt は inbox に保存しない。TTY は結果確認まで後続 dispatch を止める。明示的な interrupt 入力で cancel された場合はその入力を次に処理する。非 TTY one-shot は確認不能の案内を出して終了する |
| Issue の初回 send — `send()` reject | しない。`send_rejected` として agent を unavailable にする | しない | compiled prompt は inbox に保存しない。TTY は `/reconnect` 成功後、状態を確認して `/recovery continue` する。非 TTY one-shot は本文を確認できない旨を出して error 終了し、queue に残った初回 operator message も process 終了時に失われる |
| Issue の通常 event batch — Pi API-key resolver failure | auth-like として同じ agent ID で1回 | しない | TTY では batch 中の operator-authored input だけを snapshot に保存し、local `harness.warning` と Pi 向け auth hint を表示する |
| Issue の通常 event batch — Pi のその他の auth / provider 401、Cursor auth error | auth-like として同じ agent ID で1回 | しない | resolver failure と同じ recovery inbox / confirmation gate を使う。snapshot がない初回 / 自律 dispatch でも未確定結果の gate は適用する |
| Issue の通常 event batch — 認識対象の transport error | 同じ agent ID で1回 | しない | TTY の operator input は同じ inbox 境界で保持する。resume 成功でも元 send は未完了として扱い、operator の確認まで後続 send を止める。resume 失敗時はさらに `/reconnect` を待つ |
| Issue の通常 event batch — 未分類 `status: error`、その他の未完了 status | しない（auth / transport 判定に該当しない場合） | しない | TTY では operator-authored input だけを保存し、結果確認後の `/recovery continue` を待つ。`cancelled` も未完了として扱うが、新しい明示的 `interrupt` 入力がある場合はその入力を次の dispatch とする |
| Issue の通常 event batch — `send()` reject | しない | しない | `send_rejected` として input を TTY inbox に保存し、agent を unavailable にする。`/reconnect` で agent を戻し、状態を確認してから `/recovery continue` を実行する |
| operator-agent の user batch — Pi / Cursor の上記各 failure | Issue と同じ分類 | しない | TTY で user input だけを保存し、operator confirmation まで後続 user send を止める。send reject は unavailable にし、手動 `/reconnect` を待つ |
| operator-agent の watch report のみ — 未完了 result | auth / transport に該当すれば1回 | しない | report は既存の report ID を保って5秒後に retry queue へ戻す。user input は同じ batch に入れず、inbox にも保存しない。pending report の永続化により restart 後も再配送され得る |
| いずれかの workflow — 手動 `/reconnect` | 明示操作で同じ agent ID の `resume` を1回 | しない | 成否を `source=manual` と `status` で通知する。成功しても失敗 prompt は送らず、先に立った confirmation gate は `/recovery continue` まで維持する。失敗時は後続 queue を保持して再 reconnect を待つ |
| いずれかの workflow — shutdown 中 / shutdown intent 後 | suppression signal により新たな reconnect を始めない | しない | failure snapshot を作らず、queue / inbox は process teardown で破棄する |

Issue workflow は send の `finished` / `completed` に加えて `running` を dispatch 完了として扱います。operator-agent は `finished` / `completed` だけを完了とし、watch report のその他の status は既存の retry 契約に従います。report retry は at-least-once であり、内容 dedupe や conductor / tool 側の副作用 idempotency は提供しません。

`conductor.auth.reconnect` / `conductor.transport.reconnect` は reconnect の `source`（automatic / manual）と `status`（attempt / succeeded / failed）を示します。send の failure class は local recovery warning と TTY inbox metadata で確認できます。auth send の最終結果には従来の backend 固有 hint も表示します。reconnect が成功しても失敗 prompt は送っていません。`toolCallStarted: false` は callback を観測しなかったことだけを示し、副作用がなかった証拠にはなりません。結果不明の後続作業を送るには、状態を確認して `/recovery continue` を実行します。unavailable の場合は `/reconnect` 成功後に confirmation を行います。

## 初回 prompt と operator input の分離

Issue session の初回 `initialPrompt` は operator 入力ではありません。Cursor では compiled conductor prompt、Pi では Issue URL を含む kickoff を送ります。CLI / environment から届く初回 operator message は binding が別の `operator.message` として queue に入れ、initial send 後に通常 dispatch します。初回 send failure の snapshot に compiled system prompt を複製せず、後続の operator message が実際に dispatch されたときだけ通常の recovery 対象にします。

operator-agent の最初の send には compiled system prompt が含まれる場合がありますが、recovery inbox が保存するのは selector が選んだ user event の本文だけです。watch report のみが最初に選ばれた場合は operator input snapshot を作りません。

## operator 専用 recovery inbox

`/recovery list` は metadata のみを示し、`/recovery show <recoveryId>` が本文を明示表示します。`/recovery clear <recoveryId>` は snapshot 参照を外し、`/recovery hide` は表示を閉じ、`/recovery continue` は後続 dispatch の confirmation gate を解放します。`show`、`clear`、`hide` は送信を行いません。`continue` も失敗した入力を replay しません。

本文を取得できるのは stdin / stdout / stderr のすべてが対話 TTY の実行だけです。非 TTY では失敗本文を保存・表示せず、「この実行環境では本文を確認できず、同一 process 内でも確認できない」旨を本文なしで通知します。process-local のため、終了後には復元できません。通常の TTY session では最大4 snapshot、failure から30分、合計4 MiBを保持し、1 dispatch あたりの operator-authored text は最大1 MiBです。サイズは UTF-8 byte 数で数えます。

個別入力が1 MiBを超える場合は enqueue 前に拒否し、短縮または分割を案内します。同 source の operator batch は1 MiBまでに分け、順序を維持します。send 前に件数と byte 数を予約します。容量不足なら選択した入力を既存 queue に残して dispatch を待ち、TTY operator が snapshot を clear するか TTL が切れて空きができてから再開します。失敗後に古い snapshot を eviction したり、内容を切り詰めたりしません。この byte 上限は inbox の operator input copy に適用し、event queue や process memory 全体の最大値を保証するものではありません。

inbox に含むのは operator-authored text と failure class、workflow / backend、send・event metadata、reconnect outcome、tool 開始 callback の観測有無です。raw error、compiled prompt、formatted dispatch 全体、worker / permission / GitHub 本文は含めません。本文は secret を含み得ます。一般的な secret redaction は行わず、表示時に terminal control / bidi 制御文字を可視表記にします。TTY の scrollback、terminal recording、capture、画面共有からの秘匿は保証しません。

この inbox は SessionLogEvent、SessionSummary、SessionResumeStore、UDS、conductor-facing message に recovery 本文を追加しません。これは既存ログ契約を消す意味ではありません。たとえば `operator.input` / `operator.dispatched` が扱う operator message と `worker.round` / session summary が扱う worker result は従来の経路に残ります。この機能がそこへ失敗 batch の本文を新たに複製することはありません。`clear` / expiry / teardown は store から参照を外すだけで、runtime memory の zeroization は保証しません。

`/close`、`/exit`、Ctrl+C、crash で process が終わると inbox と未送信 queue は失われ、`--resume` / `--continue` で復元・自動 replay しません。確認後は worker / worktree と起きた副作用を見て、確認できた未完了分だけを新しい operator message として入力します。`toolCallStarted: false` は副作用がなかった証拠ではありません。

## 設計境界

一時ファイルだけでは、local queue の消費、provider request の受理、tool effect を一つの transaction にできません。送信前の durable ack は欠落、送信後の ack は crash window の重複を残します。本文 hash も同じ文章を別の意図で再送したい場合を区別せず、副作用 dedupe を実現しません。現行契約は process-local の確認と安全な再開に留めます。process 間の replay が必要な場合は、stable event identity、atomic な送受信境界、受け手側の副作用 idempotency を別の ADR で設計します。

関連: [ADR 0061](adr/0061-conductor-dispatch-lifecycle-and-recovery-boundary.md)、[operator input](operator-input.md)、[session logging](session-logging.md)。
