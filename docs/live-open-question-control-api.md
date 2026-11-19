# 稼働中 harness control API

この文書は、稼働中の `ensemble issue` harness が提供する UDS control interface の利用者・integrator 向け reference です。設計判断の履歴は [ADR 0033](adr/0033-live-open-question-control-uds.md)、[ADR 0035](adr/0035-open-question-shutdown-commit-order.md)、[ADR 0036](adr/0036-live-open-question-answer-contract.md) を参照してください。

## Scope と役割

- session ごとの listener は、稼働中 `ensemble issue` プロセス内の harness が起動・停止します。
- operator-agent は client です。listener の起動や停止中 session の回答保存は行いません。
- API は稼働中 session の Open Question 一覧・回答、watch 用 observation snapshot、operator-agent から conductor への明示メッセージ、最後の conductor 成功応答取得、成功応答と対応する inbound の bounded list を提供します。質問の保存・resume の正本は引き続き Open Questions YAML です。UDS の `session.conductor_messages.list` は稼働中 harness のメモリ内 ring buffer を使います。一方、operator-agent tool の `list_conductor_messages` は provider session history を直接読み、停止後も利用できます。

operator-agent には `list_live_open_questions` / `answer_live_open_question`、watch pool の `register_session_watch` / `unregister_session_watch`、`send_operator_message`、`get_last_conductor_message`、`list_conductor_messages`、`list_worker_messages`、`register_conductor_message_listen` / `unregister_conductor_message_listen` の tool があります。session を指定する tool は `list_operator_sessions` で得た `conductorAgentId` を受け取ります。回答 tool は `questionId` と `answer`、送信 tool は `text` と任意の `delivery` を要求します。各 tool の input schema は未知の field を許可しません。

operator-agent tool の input は次のとおりです。

`list_live_open_questions`:

```json
{"conductorAgentId":"agent-123"}
```

`answer_live_open_question`:

```json
{"conductorAgentId":"agent-123","questionId":"inq-1","answer":"yes"}
```

`send_operator_message`:

```json
{"conductorAgentId":"agent-123","text":"Please wait for active work to settle.","delivery":"idle"}
```

operator-agent tool は任意の `listen: true` も受け付けます。この場合、送信前に対象 session の persistent message listen を準備し、既存登録があれば cursor と debounce を変更せず再利用します。新規登録では live baseline の確立と保存が成功するまで送信しません。結果には対象 `conductorAgentId` と `listen: "created" | "reused"` を含めます。準備失敗は未送信ですが、準備後の送信で接続が切れた場合は従来の unknown outcome 契約に従い、自動再送しません。`queued` は受理だけを示します。listen は特定送信への返答を識別せず、返答の有無も判定しません。通常の persistent listen と同じ report 経路、hold、debounce、再起動時の扱いを使い、focus は変更しません。切断中の offline replay は保証しません。`listen` を省略または `false` にすると従来どおり準備せず送信します。

`get_last_conductor_message`:

```json
{"conductorAgentId":"agent-123"}
```

`list_conductor_messages`:

```json
{"conductorAgentId":"agent-123","limit":20,"order":"desc","cursor":"provider-run-or-entry-id"}
```

tool は SessionResumeStore に保存した conductor backend / cwd から provider history を読みます。返却件数は直近 100 件が上限で、`cursor` は返却した `providerId` を指定する排他的な境界です。UDS method の integer `sendCount` cursor とは別の pagination 契約です。

`register_conductor_message_listen`:

```json
{"conductorAgentId":"agent-123","messageDebounceMs":10000}
```

## 停止後の operator-agent 履歴参照

`list_operator_sessions` は `issueUrl` と `conductorAgentId` の完全一致 filter を受け付けます。同一 Issue に複数の run がある場合も run ごとに別行で返すため、対象の `conductorAgentId` を後続 tool に指定してください。一覧は run の SessionResumeStore、保存 harness phase、statusLine YAML、Open Questions の履歴を投影します。`openQuestionHistory` は Open Questions YAML を読み、回答本文・回答者などを含みます。YAML が存在しない旧 session では `openQuestionHistorySource: "resume_store_compatibility"` として ResumeStore の互換コピーを返します。YAML が破損・読取不能なら status / 件数を `unavailable` にし、互換コピーへ fallback しません。

`discovery.firstObservedAt` は repository watch がその run を初めて列挙した時刻です。SessionResumeStore の `updatedAt` は flush 時刻であり、作成・開始時刻や新着判定には使いません。観測時刻がない旧 run は `null` として first-observed sort の末尾に置きます。`live.connectivity` は応答直前の `dataAsOf` で最後の probe から10秒を超えると `unknown` になり、`live.lastKnownConnectivity` と `checkedAt` に古い観測を残します。watch がなく観測が一度もなければ `freshness: "not_observed"` です。

`keyword` は現在の statusLine または未回答 Open Question の本文を大文字・小文字を区別しない部分一致で検索します。各 run で live snapshot があればそれを使い、なければ保存値を使います。検索対象の出典は `statusLineSource` と `openQuestionCountSource` で確認できます。`groupByIssue: true` は絞り込み後の run を Issue ごとにまとめて `issues[].runs` で返します。`limit`、`total`、`returned` と cursor は Issue 単位になり、各 Issue の順序は指定 sort で最初に現れる run に従います。個々の run には接続、保存 phase、最終報告を含みます。ページ間で観測が変わると重複・欠落があり得ます。

組み合わせ例: ライブ接続中で未回答の質問がある run は `{ "liveConnectivity": "reachable", "hasOpenQuestions": true }`、終了済みは `{ "harnessPhase": "close" }`、接続状態が未確認の run は `{ "liveConnectivity": "unknown" }`。これらに `keyword` や `groupByIssue` を組み合わせられます。

`openQuestionObservation` は watch pool が保存する未回答（`status: open`）の Open Question 件数を返します。回答済みの質問は含めません。現在・前回の件数と各観測時刻・出典、前回からの増減 `delta`、比較元の時刻 `comparedAt` を示し、回答による件数の減少も反映します。比較元がないときの `previous` / `delta` は `null` です。`openQuestionCount` は現在の一覧取得で選択した live または保存値です。

一覧は保存 phase が終了済みでも socket path があれば `session.observe` を試みます。watch pool の10秒以内の観測は再利用し、それ以外の問い合わせは同時8件、1件あたり1秒で打ち切ります。ローカル UDS の通常応答を待ちつつ、多数の停止・無応答 run による遅延と接続数を抑えるための上限です。応答ありは `reachable`、socket 不在・接続拒否は `unreachable`、時間切れ・未対応やその他の判定不能は `unknown` です。保存 phase と接続状態は別の事実で、接続可能は worker の作業中を意味しません。

`statusLine` / `reportedAt` と `openQuestionCount` は live 応答があればその snapshot、なければ保存値を使い、それぞれ `statusLineSource` / `statusLineObservedAt`、`openQuestionCountSource` / `openQuestionCountObservedAt` で出典と観測時刻を示します。保存 Open Question 件数の時刻は YAML 読取完了時刻、旧 ResumeStore 互換コピーでは Store 読取開始時刻です。`openQuestions` / `openQuestionHistory` は保存値なので、live の `openQuestionCount` と一致しない場合があります。`hasStatusLine` と `openQuestionCount` は従来の保存値のみから live 優先に変わっています。`liveConnectivity`、`harnessPhase`、`hasOpenQuestions`、`minOpenQuestions`、`reportedBefore`（`dataAsOf` 時点の最新報告からの経過ミリ秒）で絞り込めます。接続が stale になっても、採用済みの質問・報告は観測時刻とともに保持します。`reportedAtDesc` / `reportedAtAsc` は報告時刻順で、報告がない run は末尾です。filter と sort はページ分割前に適用され、cursor は条件に紐づきます。接続結果や報告はページ間で変化するため、重複や欠落が起こり得ます。

`pullRequests` は Issue ごとの GitHub API snapshot で、PR の head、各 check run / status context、`reviewDecision` とその出典を含みます。1一覧ページで問い合わせるのは最大5つの異なる Issue、各 Issue 最大5件の PR、各 PR 最大20件の check context です。GitHub 取得後に filter を再評価してページが変わった場合、新たにページに入った Issue は `not_checked` / `page_changed_during_lookup` です。成功値は30秒 cache し、更新に失敗して cache を使う場合は `status: "stale"` と失敗理由を示します。`none` は repository、Issue、timeline を確認したうえで PR reference が0件だった状態です。repository / Issue / timeline が欠けていて確認できない場合や問い合わせに失敗した場合は `unavailable` と理由を示し、未照会は `not_checked`、GitHub 側で結果を切り詰めた場合は `partial` です。check が0件、または review decision が `null` でも成功・承認を意味しません。`includeGithub: false` は外部問い合わせをせず `not_requested` を返します。

`list_worker_messages` は Issue URL、run ID、worker 名を必須とし、保存された ACP session ID / cwd に対応する Pi / Codex / Cursor transcript を読みます。既定は最新20件、最大100件です。`nextCursor` は Issue URL / run ID / worker / `order` / reader と transcript 内の境界位置に結び付いた不透明な値です。続きは同じ対象・同じ `order` で取得してください。別 run などから cursor を流用した場合や、現在の transcript に境界がない場合は `paginationStatus: invalid_cursor` と理由を返し、メッセージを返しません。先頭から取得し直してください。応答の `status` は `supported`（読めた）、`unsupported`（preset / reader 未対応）、`unavailable`（保存 session や transcript がない、または照合できない）を区別します。profile に構成がある worker の session record がない場合も `unavailable` と理由を返します。これは prompt failure の証拠ではありません。SessionResumeStore は worker failure event を保存せず、終了 JSON の `workerFailureCount` も件数だけを示します。どの worker が失敗したかを確認するには captured harness log などの詳細な記録が必要です。

これらは read-only tool です。`list_live_open_questions` などの live control が停止時に保存 YAML へ fallback する方針は変更しません。Open Question の質問・回答は保存値のまま返り、secret redaction は行われません。

`list_worker_messages`:

```json
{"issueUrl":"https://github.com/owner/repo/issues/691","conductorAgentId":"agent-123","worker":"implementer","limit":20,"order":"desc"}
```

初回の応答に `nextCursor` が含まれる場合、次のページでは同じ Issue / run / worker / `order` を指定し、その値を加工せず `cursor` に渡します。`providerId` から cursor を組み立てないでください。以下の値は説明用 placeholder です。

前ページの応答:

```json
{"nextCursor":"<tool が返した不透明な値>"}
```

次ページのリクエスト:

```json
{"issueUrl":"https://github.com/owner/repo/issues/691","conductorAgentId":"agent-123","worker":"implementer","limit":20,"order":"desc","cursor":"<前ページの nextCursor をそのままコピー>"}
```

list tool の `structuredContent` は UDS の `result`（`{ "questions": [...] }`）です。answer tool の text content は UDS result (`{ "question": {...} }`) を JSON 表示し、`structuredContent` は `questionId`, `status`, 任意の `answeredBy`, `approved` を持つ object に整形します。これは operator-agent tool wrapper の出力で、UDS wire response とは形が異なります。

## Operator-agent watch state の欠損・破損と復旧

watch pool は選択 profile と Issue URL の canonical repository slug ごとに `~/.ensemble/operator-agents/<profile>/watch/github.com/<owner>/<repo>/watch-state.json` を使い、watch 登録、session ごとの cursor、未 dispatch report を atomic に保存します。同じ profile の複数 operator-agent process は `~/.ensemble/operator-agents/<profile>/watch/watch-state-lock.sqlite` の SQLite transaction lock で更新を直列化し、poll / ack / 登録変更の前に state file 群を読み直します。cursor と pending report は同じ lock 内で保存するため、古い全体 snapshot による他 process の更新消失を防ぎます。poll 中も lock を保持するので、同一 profile の poll は session / repository をまたいで直列になります。さらに各 state refresh と2秒間隔の pending refresh で、稼働中 peer も disk 上の未 ack report を queue に反映します。通常は保存から次の refresh まで最大2秒で、poll 起点の refresh が先に走ればそれより早く回収します。lock 取得に失敗した refresh は最大40回・25ms間隔で retry して error を記録し、次の2秒周期で再試行します。継続的に lock を取得できない場合の有限な配送期限はありません。lock は時間で失効せず、OS suspend 中も生きた owner が保持します。process 終了時は OS が lock を解放します。lock 保証は SQLite の file locking を実装する local filesystem が前提です。旧 user path-hash / slug-keyed watch bundle と列挙 checkout の project-local watch state は明示 migration tool の source で、runtime は読みません。profile state がなければ空の state として扱い、legacy source を自動で統合・変更・削除しません。

`register_repository_watch` / `unregister_repository_watch` は profile 全体の repository discovery 設定を、同じ SQLite lock で保護される `~/.ensemble/operator-agents/<profile>/watch/repository-watch-state.json` に atomic 保存します。登録対象は profile の include 設定と起動時 `--repo-filter` の両方に含まれる、完全一致 `owner/repo` の repository です。profile あたり最大20 repository を登録できます。20件目までは成功し、21件目以降の新しい repository は `At most 20 repositories can be watched in one profile.` で拒否されます。登録済み repository の重複登録は上限に達していても設定を更新し、登録件数は増やしません。登録済み repository 数は再起動後も復元され、引き続き上限に数えます。unregister が成功すると登録枠が空き、別 repository を登録できます。発見履歴は再登録時の新着判定用に保持します。

登録時の既存 run は baseline として first-observed 時刻を記録し、以後は既定30秒（5〜300秒に設定可）で canonical slug の repository directory だけを列挙します。1回の走査は500 runずつページングして最後まで確認し、`updatedAt` は使いません。再起動時は登録と観測時刻を読み戻し、起動直後の走査で停止中に追加された run を新規発見します。重複登録は監視設定を更新しますが、保存済み first-observed 時刻は維持します。unregister は repository scan と repository watch が管理する session watch を止めます。個別に明示登録した session watch と、別経路の live 自動発見による watch は対象外です。repository の発見記録は再登録時の新着判定に使うため保持します。設定ファイルが不正なら起動を失敗させ、空 state に置き換えません。

repository 登録数（最大20 repository）とは別に、repository watch による自動 session watch は選択 profile 全体で最大20 run、既定10秒間隔です。repository watch 下の候補から first-observed が新しい順に枠を割り当てるため、新しい run が来ると古い自動 watch が枠外になることがあります。手動の `register_session_watch` と live 自動発見による watch はこの上限外です。`unregister_session_watch` は保存された session watch を解除し、repository watch が管理していた対象 run はその自動再登録を抑制します。repository watch の対象に戻すには、その repository watch を解除して再登録してください。live 自動発見は別経路のため、この抑制の対象外です。live 自動 watch だけの session に対する unregister は保存登録がないため解除対象にならず、保存登録を解除した場合も次の自動 scan で live watch が再開され得ます。scan 失敗は前回成功時刻を維持し、一覧の `repositoryScan` を stale / `scan_failed` として示します。

profile state 内の ID に対して一意な SessionResumeStore が見つからない、同じ ID の Store が複数ある、state file の repository scope または pending report の Issue URL が Store と一致しない場合、その session bundle（watch / cursor / listener / pending report）は元の state file に残して dispatch しません。原因と field 件数を session 単位で診断し、同じ内容の persist ごとには繰り返しません。Store が後から一意になり、repository path と pending report の Issue identity も一致すれば `register_session_watch` / `register_conductor_message_listen` による再登録時に元の cursor と report ID を復旧します。食い違いが残る間は自動割当・自動破棄を行いません。

- **state file が存在しない場合:** 欠損した repository の watch state は empty state として扱われ、そこに保存されていた session watch 登録・cursor・未 ack report は復元されません。別ファイルの repository watch 登録が残っていれば、その登録による監視は継続できます。`repository-watch-state.json` 自体が欠損した場合は、その登録・発見履歴・停止抑制状態も復元されず、repository watch を使うには再登録が必要です。通常起動ではそれとは別に、profile の include と `--repo-filter` の範囲にある保存 session を起動時と30秒ごとに走査し、一意な SessionResumeStore に記録された UDS の `session.observe` に応答があれば live 自動 watch します。到達不能な session の自動 watch は再接続できるまで始まりません。手動で `register_session_watch` する選択肢もあり、こちらは UDS に到達できない場合に保存済み snapshot へ fallback します。

  cursor が戻らなかった session では、どの経路で watch しても最初に成功した snapshot は Open Question の silent baseline になります。その snapshot にすでに含まれる質問（state 欠損中に追加された質問も含む）は新規通知として replay されず、失われた未 ack report も復元されません。baseline 後に追加された ID は通常どおり通知されます。未回答の質問は `list_operator_sessions` や `list_live_open_questions`（live 接続時）で別途確認してください。session-state は別 cursor のため、初回 poll で最新状態が報告される場合があります。
- **JSON または state schema が不正な場合:** operator-agent の初期化は失敗し、empty state へ黙って置き換えません。保存ファイルを退避してから、有効な backup を戻すか、version と必須 field を修復して再起動してください。state を意図的に破棄する場合も、まず必要ならコピーを保全してください。ファイルを取り除いて再起動すると empty state から始まり、上記の自動発見または手動登録から再開し、cursor を戻せなかった session では silent baseline となります。
- **report hold:** hold は watch state には保存されない会話中の状態です。再起動後は解除状態で始まります。

## SessionResumeStore の選択と legacy data の migration

Issue session の通常保存・読み取り先は canonical GitHub slug 配下（`~/.ensemble/sessions/github.com/<owner>/<repo>/`）だけです。SessionResumeStore、Open Questions / session-state YAML、tool-call snapshot、Pi transcript をこの location に保存します。別 clone からも Issue URL と slug を使って同じ session を見つけられます。

ResumeStore の探索は全ローカル canonical slug を `repoRoot` の一致条件なしで調べます。path-hash と project-local legacy data は runtime read candidate ではありません。選択後の Open Questions / session-state YAML、tool-call 履歴、Pi transcript も canonical slug のみを読みます。移行が必要な旧データは [一括 inventory / copy 手順](session-logging.md#legacy-data-の一括-inventory-copy)を参照してください。

operator-agent は user root の canonical slug SessionResumeStore と選択 profile の watch state を読みます。path-hash / project-local Issue data は互換 fallback として読みません。Pi operator transcript は `~/.ensemble/operator-agents/conversations/<operatorAgentId>/pi-sessions/` に conversation ID ごとに保存し、launch cwd / repository `.ensemble/pi/` を参照しません。global conversation record は `~/.ensemble/operator-agents/conversations/<operatorAgentId>/conversation.json` に profile、workspace、backend、provider session ID を記録します。

`scripts/migrate-project-ensemble-runtime-to-user.mjs` は runtime fallback ではなく、残る old data を利用者が明示的に inventory / copy する tool です。user path-hash 全体と operator が指定した checkout の Issue session / watch data を対象にし、現在再開されない session や別 clone の data も棚卸しします。旧 `~/.ensemble/operator-agent/<repoKey>/watch-state.json` / slug-keyed watch と project-local watch state も copy / archive 候補です。既定は dry-run で、`--apply` を指定した場合だけ copy / archive します。source は削除・renameせず、destination は上書きしません。同一 checksum は no-op、異なる内容の collision は manifest に理由と recovery を記録します。Issue data は有効かつ一意な Store の `issueUrl` が slug を証明する場合だけ割り当てます。watch は cursor・listener・pending report を conductor ごとにまとめ、Store と pending report の Issue URL が一致し、旧 slug-keyed source では source path の slug も Store の Issue URL と一致し、operator が `--profile` を選んだ場合だけ profile / slug 配下へ移します。割当根拠が足りない bundle は checksum 付きで `~/.ensemble/operator-agents/legacy/watch/` に保全します。旧 watch bundle の復旧では manifest の `recovery` と cursor / pending report の状態を確認してください。cursor を戻さず手動登録または live 自動発見で watch を再開すると最初の snapshot は silent baseline となり、既存 Open Question は再通知されません。`--accept-watch-archive-limitations` を指定すると、operator が archive の制約を受け入れた判断（operator acceptance）と対象 archive / checksum を manifest に記録できます。共有 Pi transcript の所属が確認できない場合は source を保全して unresolved とし、旧 operator conversation record とそれに一意に対応する provider transcript は inventory 対象外です。旧 slug-keyed watch の親 path component または source file が symlink で userRoot 外へ解決される場合は、source 内容を読まずに unresolved として記録し、copy / archive を行いません（[Issue #723](https://github.com/otolab/agents-ensemble/issues/723)、[PR #724](https://github.com/otolab/agents-ensemble/pull/724)）。引数・manifest・checkout inventory の完全性は [session logging の migration 手順](session-logging.md#legacy-data-の一括-inventory-copy) を参照してください。

## Endpoint discovery と lifecycle

operator-agent は user root の canonical slug SessionResumeStore だけを読み、そこから `harnessSocketPath` を得ます。hash / project-local Store は走査しません。socket は OS の一時 directory 内の `ens-oq-*` runtime directory に作成されます。socket path を推測せず、選択した SessionResumeStore に記録された値を使ってください。

path の記録は listener の稼働確認ではありません。session が停止中、終了処理中、または接続不能なら UDS request は失敗します。`list_live_open_questions`、`answer_live_open_question`、`send_operator_message`、`get_last_conductor_message` と発言 listen は直接 live control であり、保存 YAML へ fallback しません。operator-agent tool の `list_conductor_messages` はこの UDS 経路を使わず、SessionResumeStore の session ID / backend / cwd から provider history を読みます。watch pool は手動・repository watch・live 自動 watch の poll で `session.observe` を試し、UDS が到達不能または method 未対応なら選択した ResumeStore location に対応する保存 snapshot へ切り替えます。ただし live 自動発見は UDS の応答を確認してから watch を開始し、接続不能と判定した自動 watch は外します。発言 listen は UDS が利用できない間も保存値へ切り替えず、次の poll で再接続を試します。

listener の起動後に `harnessSocketPath` を含む初回 SessionResumeStore flush が失敗しても、warning を記録して session は続行し、listener は稼働したままの場合があります。このとき SessionResumeStore に新しい path が書かれていなければ client は endpoint を発見・接続できません。別の接続先を探す自動 fallback はありません。

停止時は listener が新しい request を受け付けなくなり、受理済み request の処理を最大5秒 drain します。期限内に終わらなければ driver を abort し、server と一時 runtime directory を閉じて削除し、SessionResumeStore から `harnessSocketPath` を外します。

## Wire format

Transport は Unix domain socket 上の JSON-RPC 2.0 over NDJSON です。1 connection につき request は1件、response も1件です。JSON object を1行（末尾に newline）で送り、response の `id` は request の `id` と一致します。request ID は string または finite number、`params` は object です。

実装上の上限は request / response あたり1 MiB、client socket timeout は30秒です。server にも request line を受信するまでの socket timeout がありますが、newline を受け取ると解除して handler を実行します。このため server の handler / dispatch 処理時間は30秒では打ち切られません。追加の request を同じ connection に送る interface ではありません。

## Methods

### `session.observe`

稼働中 harness の観測 snapshot を返します。operator-agent watch pool は polling のたびにこの method を呼びます。初回 snapshot は Open Question cursor に限って silent baseline とし、既存質問の OQ report は生成しません。session-state report は別の `reportedAt` cursor で管理するため、session-state を含む初回 poll では最新状態を報告することがあります。以後は新しい open 質問、既知質問の `open → answered`、前回 open だった ID の一覧からの消失を差分報告します。UDS が利用できる間は Registry snapshot を優先し、記録された socket が到達不能、または古い harness が snapshot method に未対応の場合は、保存済み Open Questions YAML / session-state YAML / legacy SessionResumeStore を poll します。report には観測元 `稼働中 UDS` または `保存済み SessionResumeStore / YAML` を付け、同一質問の UDS / YAML 間の再観測は cursor で重複排除します。

Request:

```json
{"jsonrpc":"2.0","id":3,"method":"session.observe","params":{}}
```

Response:

```json
{"jsonrpc":"2.0","id":3,"result":{"sequence":2,"openQuestions":[{"id":"inq-1","question":"Proceed?","responseType":"yes_no","source":"conductor","status":"open","askedAt":1792512000000}],"workStatus":"waiting","sessionState":{"current":{"statusLine":"CI 待ち","reportedAt":1792512001000},"history":[]}}}
```

`workStatus` は harness の live 状態から判定した `working` / `waiting` / `unknown` です。旧 harness では含まれません。判定条件、観測時刻の扱い、内部の待ちや進捗を観測できない限界は [operator input reference](operator-input.md) を参照してください。

`openQuestions` は live Registry の全質問（未回答・回答済み）です。`sessionState` は報告がある場合だけ含みます。`sequence` は質問の enqueue cursor です。operator-agent は質問 ID ごとの fingerprint に加え、直近の質問文・status・`askedAt` を cursor に保存し、状態差分と UDS / YAML 間の重複排除に使います。Open Question cursor がないときは初回 snapshot 内の質問を silent baseline とします。これは Open Question report だけに適用され、session-state report は別 cursor で判定されます。その後、未登録 ID の `open` 質問を新規追加として、既知 ID の `open → answered` を回答として報告します。前回 `open` だった ID が次の snapshot から消えた場合も一覧からの消失を報告します。回答済みで初めて観測した ID は解決報告せず、既知 ID の回答遷移を新規追加として二重計上しません。

新規 open report には question ID・response type・質問文と、あれば context を含めます。回答 report には question ID、短く整えた質問文と、snapshot にある `answer` / `assent` / `selectedChoice` / `answeredBy` / `answeredAt` を含めます。長い質問・回答文はそれぞれ最大240文字に整えます。`answeredBy: operator` は記録された operator ロールを示すだけで、人間の operator と operator-agent のどちらが回答したかは特定できません。`answeredBy: conductor` の場合は conductor 側の操作と説明できます。これらの値がない場合も、回答主体を推測しません。

消失 report は ID と直近 cursor に保存された質問文を示しますが、消えたことだけから回答済み・解決済みとは判断せず、回答や回答者も推測しません。旧形式の cursor でも、回答済み snapshot から回答情報を除いた状態が保存済み fingerprint と一致すれば `open → answered` を検出できます。一方、旧 cursor には質問文・status が保存されていないため、そこからの消失は前回 status 不明として報告され、質問文を復元できない場合があります。同じ poll で複数の追加・回答・消失を検知した場合は質問 ID 順に並べ、番号付き section でまとめます。

live UDS を使った report には稼働中 UDS、UDS が到達不能または未対応で保存 snapshot に切り替えた report には保存済み SessionResumeStore / YAML という観測元を付けます。session-state report の変更検出には各質問 fingerprint とは独立した `reportedAt` cursor を使います。初回 poll では snapshot に session-state があれば最新の status を1件報告し、以後は `reportedAt` ごとに内容の変化を検出して報告します。この method は読み取り専用で、各 poll は独立した短い JSON-RPC 接続です。

Open Question / session-state / conductor-message report は、同じ `conductorAgentId` の source にまとめます。各 report の ID と到着順は保ち、質問・status・発言を本文付きの別 section として同じ `agent.send` に渡します。Open Question を含む session は通常の status report より優先され、別 session の report は混ぜません。report ID は process 内の queue で重複 enqueue を抑え、disk から ack 済みになった未 dispatch copy は refresh 時に取り除きます。send が未完了なら同じ ID を5秒後に通常 dispatch queue へ戻し、`agent.send` を再試行します。send 完了後に ack 保存だけが失敗した場合は、report を in-flight に保って同じ batch の ack だけを5秒間隔で最大3回 retry し、完了済み turn は再送しません。全 retry に失敗すると pending state を残して明示 error で runner を停止します。再起動後は at-least-once 契約により同じ ID が再送される可能性があります。poll refresh は retry deadline を早めません。どの process からの ack でも pending state から削除できます。別 process が同じ report をすでに send 中なら止められず重複配送になることがあり、exactly-once は保証しません（設計判断は [ADR 0081](adr/0081-operator-watch-pending-report-handoff.md)、[ADR 0082](adr/0082-operator-watch-acknowledgement-retry.md)）。

watch の poll interval は既定 2,000ms、`debounceMs` は既定 250ms（0〜10,000ms）です。conductor message listen は別の既定 2,000ms poll と `messageDebounceMs` 既定 10,000ms（0〜120,000ms）を持ちます。message listen 中は watch report も `max(debounceMs, messageDebounceMs)` の期限を待ちます。message report が届くたび同一 session の未 dispatch report 全体を最新 message の quiet window まで延長するため、短いやり取りの report をまとめやすくなります。message listen がある場合、message が来なくても watch report は最大設定値まで待ち、message が続けば quiet window がその都度延びます。遅延を抑えたい場合は `register_conductor_message_listen` の `messageDebounceMs` を短くしてください。hold 中も report は個別に保存され、両 hold 解除後に到着順で batch されます。

### `open_questions.list`

一覧は稼働中 Registry の `status: open` の質問だけを含みます。各 item に `status` や回答本文は含まれません。

Request:

```json
{"jsonrpc":"2.0","id":1,"method":"open_questions.list","params":{}}
```

Response:

```json
{"jsonrpc":"2.0","id":1,"result":{"questions":[{"id":"inq-1","question":"Proceed with the release?","responseType":"yes_no","askedAt":1792512000000,"source":"conductor","relatedPermissionId":"perm-7"}]}}
```

`result.questions[]` の schema:

| Field | Type | Presence / meaning |
|-------|------|--------------------|
| `id` | string | Open Question ID |
| `question` | string | 質問本文 |
| `responseType` | `"yes_no" \| "text" \| "choice"` | 回答の既存 response type |
| `choices` | `{ id: string, label: string }[]` | 任意。choice question の候補 |
| `context` | string | 任意の context |
| `askedAt` | number | 質問作成時刻（Unix epoch milliseconds） |
| `source` | `"conductor" \| "max_turns"` | 質問の既存 source |
| `relatedPermissionId` | string | 任意。permission に関連付く場合の ID |

### `open_questions.answer`

Request の `params.questionId` と `params.answer` は、trim 後に空でない string が必要です。回答先が open でなければ処理されません。

Request:

```json
{"jsonrpc":"2.0","id":2,"method":"open_questions.answer","params":{"questionId":"inq-1","answer":"yes"}}
```

Response:

```json
{"jsonrpc":"2.0","id":2,"result":{"question":{"id":"inq-1","status":"answered","answeredBy":"operator","approved":true}}}
```

`result.question` は `id` と `status` を返し、`answeredBy` と `approved` は該当する場合に返します。回答本文や `selectedChoice` はこの response に含まれません。

回答は既存の `submitOperatorInput` / `recordOpenQuestionAnswer` semantics を使います。`yes_no` は trim 後の回答文を保持しつつ `assent: yes | no | unclear` を判定します。permission に関連付く yes/no question の `approved` は明確な yes/no assent から導出され、`unclear` では設定されません。`choice` は一意に解決できる option ID、label、または1始まりの候補番号から `selectedChoice` を記録します。重複 label や解決できない自由記述でも trim 後の回答文は保存し、候補を推測しません。API の answer request に送るのは `questionId` と回答文字列で、permission ID や `selectedChoice` を別に指定する schema ではありません。

受理した回答は既存の `operator.message` 相当として event queue に入り、conductor の通常 dispatch 経路へ渡ります。operator-agent は worker を直接 dispatch しません。

### `operator.message.send`

Request の `params.text` は trim 後に空でない string が必要です。`params.delivery` は省略可能で、省略時は `next` です。有効値は `idle`、`next`、`interrupt` です。

Request:

```json
{"jsonrpc":"2.0","id":3,"method":"operator.message.send","params":{"text":"Please wait for active work to settle.","delivery":"idle"}}
```

Response:

```json
{"jsonrpc":"2.0","id":3,"result":{"queued":true,"delivery":"idle"}}
```

成功 response は message が harness の event queue に受理されたことだけを示します。conductor への dispatch や処理の完了を待ちません。メッセージ本文は session log / TTY 活動ログに記録されますが、Open Questions YAML には保存されません。

| `delivery` | 配信 |
|------------|------|
| `next` | 次に選ばれる dispatch で operator message を最優先に送ります。進行中の conductor run は完了を待ちます |
| `idle` | conductor send 中、worker 実行中、または送信可能な自律イベントが残る間は event queue に保持し、処理が落ち着いた後に送ります。post-loop 待機中と max-turns 到達後も、送信可能になれば dispatch します |
| `interrupt` | 進行中の conductor run に cancel を試み、cancel 完了後に operator message を優先 dispatch します。backend が cancel を提供しない、または cancel が失敗した場合は warning を記録し、通常の次回 dispatch に戻ります（[#86](https://github.com/otolab/agents-ensemble/issues/86)） |

dispatch hold 中も operator message は hold buffer を通りません。hold が有効な間は hold 自体も `idle` の待機理由ではないため、worker と通常 queue の送信可能イベントがなければ、held buffer に自律イベントが残っていても `idle` message を dispatch します。hold 解放後に送信可能な held event が残っている場合は、先に flush / dispatch し、その処理後に `idle` message を送ります。したがって `idle` は hold の解除を待つ指定ではありませんが、解除時点ですでに送信可能な held work があれば、それを追い越す指定でもありません。

### `operator.session.shutdown`

稼働中 Issue session に `close` または `exit` を要求します。TTY の `/close` / `/exit` と同じ内部 shutdown 経路を通る専用 method です。`close` は worktree を残して再開可能に終了し、`exit` は通常の exit teardown と isolated worktree cleanup を要求します。受付応答は shutdown を受理したことを示し、teardown の完了までは待ちません。

Request:

```json
{"jsonrpc":"2.0","id":6,"method":"operator.session.shutdown","params":{"mode":"close"}}
```

Response:

```json
{"jsonrpc":"2.0","id":6,"result":{"accepted":true,"mode":"close"}}
```

`params` には `mode` だけを指定します。`mode` は必須で `close | exit` のいずれかです。未知 field を含む request や不正な mode は `-32602` になります。live server が request を処理できる状態で teardown が始まっている、または終了要求がすでに受理されている場合は `-32000` です。shutdown callback が使えない server は `-32601` を返します。終了要求を受理すると UDS server は quiesce するため、その後の接続は JSON-RPC error ではなく transport error になる場合があります。

operator-agent の `shutdown_issue_session` tool は `conductorAgentId` と `mode` を受け、SessionResumeStore に記録された socket だけを使います。停止中・接続不能の session には transport error を返し、保存 YAML への fallback はしません。request を送信した後に接続が切れた場合は受付結果が不明です。自動再送せず、session 状態を確認してください。

`operator.message.send` は終了要求として解釈されません。たとえば `text: "/close"` は従来どおり通常の operator message queue に送られます。session を終了するには専用 method / tool を使ってください。

### `session.last_conductor_message.get`

稼働中 harness が保持する最後の成功応答を取得します。読み取り専用で、`session.observe` や Open Questions YAML / SessionResumeStore には含めません。セッション内に成功応答がまだない場合は `message: null` です。成功応答の後に失敗または本文なしの send があっても、直前の成功応答を返します。

Request:

```json
{"jsonrpc":"2.0","id":4,"method":"session.last_conductor_message.get","params":{}}
```

Response（応答あり）:

```json
{"jsonrpc":"2.0","id":4,"result":{"message":{"text":"回答本文","at":1792512003000,"sendCount":44}}}
```

Response（応答なし）:

```json
{"jsonrpc":"2.0","id":4,"result":{"message":null}}
```

| Field | Type | 意味 |
|-------|------|------|
| `message.text` | string | `conductor.send` が `finished` で本文が空でない場合の trim 済み応答本文 |
| `message.at` | number | harness が send 完了を処理した時刻（Unix epoch milliseconds） |
| `message.sendCount` | number | 対応する `conductor.send` の通し番号 |

operator の入力、応答履歴、失敗応答は返しません。状態は稼働中プロセスのメモリ内だけにあり、再開した session には引き継がれません。operator-agent tool の `structuredContent` と text content は、UDS result と同じ `{ "message": ... }` です。

### `session.conductor_messages.list`

成功した conductor 応答と、その応答に対応する conductor 向け inbound を一覧します。記録対象は bootstrap の `agent.send` を除く send のうち、`status=finished` かつ trim 後の `result` が空でないものです。`inbound` は通常、その send に渡した `formatSessionEventsForConductor(batch)` の全文です。Cursor の初回 bootstrap が未完了のまま後続 dispatch に進む場合、実際の `agent.send` には compiled prompt も付けますが、この UDS record は formatted event text だけを保持します。bootstrap send 自体は対象外です。

稼働中 session ごとに直近 100 件を保持します。これは bounded なプロセス内履歴で、harness 停止時に破棄されます。この UDS method は停止後に YAML / sidecar へ fallback しません。operator-agent tool の `list_conductor_messages` は別の provider history projection であり、停止後の取得方法と出力は次節のとおりです。

Request:

```json
{"jsonrpc":"2.0","id":5,"method":"session.conductor_messages.list","params":{"limit":20,"order":"desc","cursor":44}}
```

| Parameter | Type | Default / meaning |
|-----------|------|-------------------|
| `limit` | integer 1–100 | 既定 20。返却件数 |
| `order` | `"asc" \| "desc"` | 既定 `desc`。`sendCount` 順 |
| `cursor` | integer | 排他的な keyset 境界。`desc` は `sendCount < cursor`、`asc` は `sendCount > cursor` |
| `before` | integer | 排他的な上限。`sendCount < before` |
| `after` | integer | 排他的な下限。`sendCount > after` |

`cursor` は `before` / `after` と併用できません。`before` と `after` は併用でき、その場合は両方の排他的境界に挟まれた範囲を返します。`before` / `after` は順序指定とは独立した filter で、結果の並びは `order` に従います。境界パラメータの組み合わせが不正、範囲外の `limit`、不正な `order` は JSON-RPC `-32602` です。

Response:

```json
{"jsonrpc":"2.0","id":5,"result":{"messages":[{"text":"回答本文","inbound":"## Open Question 追加\n...","at":1792512003000,"sendCount":44,"dispatchSource":"operator"}],"hasMore":true}}
```

`messages` は要求された順序で並びます。`hasMore` は同じ filter の結果に次ページがあることを示します。通常の keyset pagination では、返却末尾の `sendCount` を次の `cursor` に渡してください。`dispatchSource` は識別可能な場合に限って付きます。operator-agent の `list_conductor_messages` は provider history 上の別 API で、`providerId` string cursor を使います。既存の `get_last_conductor_message` / `session.last_conductor_message.get` は応答本文・`at`・`sendCount` のみを返し、変更しません。

UDS response の上限は従来どおり **1,048,576 bytes（1 MiB）** です。list の JSON response 全体がこの上限を超えると、部分結果や切り詰めた inbound は返さず、JSON-RPC `-32603` / `Response is too large.` を返します。1件だけの要求でも、その1件の全文 inbound を含む response が上限を超えれば同じ error になります。単独の1件だけが上限超過の原因と特定できる場合、error の `data.oversizedSendCount` にその `sendCount` が付きます。これは listen が cursor を進めるための識別情報で、list の呼び出し自体は引き続き error です。上限内に収まる場合は inbound 全文を返します。

### 発言 listen と OQ watch の分離

`register_conductor_message_listen` は `conductorAgentId` と任意の `messageDebounceMs`（既定 10,000ms、0–120,000ms）を受け取ります。登録直後の live poll は既存の最新 `sendCount` を baseline とし、その後に増えた発言だけを poll します。baseline の最新 record が単独で上限を超える場合は、size error の `data.oversizedSendCount` を使ってその record を silent baseline に含め、登録を完了します。debounce window に複数の発言があれば、sendCount 昇順で inbound / response の section を 1 report にまとめます。`unregister_conductor_message_listen` は以後の polling を止めます。

発言 listen は operator-agent が UDS を polling し、独立した `messageCursors` を使います。`register_session_watch` の Open Question / status cursor と混ぜません。harness が停止中、UDS が到達不能、または method 未対応の場合は発言 listen に fallback はありません。通常の session watch の保存 YAML fallback とも別動作です。

新しい listen の登録は、最初の baseline poll が成功してから完了します。baseline 取得に失敗した場合、register は error を返し、その呼び出しで追加した listener と timer を撤去します。既存 listen の設定変更中に poll が失敗した場合は、変更前の listener 設定と timer に戻します。

operator-agent の listen は limit 20 の page から読み始め、aggregate response が 1 MiB を超えた場合は同じ exclusive cursor から limit を下げて再試行します。取得できた複数 page はその poll の debounce report にまとめ、sendCount 昇順で通知します。cursor は取得済み page の最後までだけ進めるため、retry で発言を飛ばしたり並べ替えたりしません。

limit 1 でも単独 response が上限を超える発言に達した場合、その発言の `sendCount` を使って listen cursor を安全に進めます。読み取れなかった発言は内容を切り詰めずに読み飛ばし、同じ debounce window の複数 poll で見つかった oversized warning は隣り合うものを1 sectionにまとめます。間に読み取り可能な発言や別 report がある場合は warning を分け、`sendCount` と report の到着順を保ちます。その後も polling を続け、後続の読み取り可能な発言を順序どおり通知します。先に取得した page、読み飛ばした発言、後続 page は同じ report window にまとめられます。list API はこの動作をせず、単独 oversized record を含む response に対して従来どおり明示的な size error を返します。

### operator-agent の provider history list

operator-agent tool の `list_conductor_messages` は稼働中・停止後とも SessionResumeStore の conductor ID / backend / `issueUrl` / `repoRoot` / `conductorCwd` を使い、SDK が保存した local session history から最大 100 件を読みます。

Pi transcript は canonical slug のみから探します。保存済み `conductorCwd` は、その canonical location 内で session を照合するために使います。provider store が見つからない、破損している、または読み出せない場合は session ID と backend を含む error を返します。Cursor で保存 run が0件の場合も取得不能として error になります。保存済み bootstrap run だけが存在する場合は、正常な空一覧です。core API は旧 repository root の transcript path-hash fallback を受け付けません。

- **共通 filter:** user inbound と final assistant response だけを返します。system prompt、tool call / result、thinking、その他 provider event は出力しません。bootstrap、失敗・cancelled・running・空 response は対象外です。inbound / final response の本文は保存値のままで、secret redaction は行いません。`ensemble session messages` もこの本文をそのままローカル出力します。秘密値を含む可能性のある生データとして扱い、集計・蓄積・共有する前に利用側でサニタイズしてください。既存の同一 OS user access boundary も適用されます。
- **Cursor bootstrap context:** Cursor SDK に system-prompt API がないため、初回 bootstrap が未完了の session では、後続 dispatch の user inbound に compiled prompt が再度含まれる場合があります。これは provider に実際に送った内容であり、provider-history list と `ensemble session messages` では user inbound の一部として返ります。recovery inbox と Issue workflow の UDS message list にはこの prompt を複製しません。
- **利用側の sanitizer:** `@agents-ensemble/core/operator-runtime` の `listConductorProviderHistory` は、呼び出しごとに任意の `sanitizer(value, field)` を受け取れます。`field` は自由文の `inbound` または `text` です。provider history の選択とページングの後、返却する各 message のこの2 field だけに適用します。`backend`、`providerId` / `requestId`、`at`、`sendCount` / `dispatchSource`、`hasMore` は変えず、元の message も変更しません。省略時は従来どおり保存値を返します。sanitizer が throw / reject するか文字列以外を返すと、raw 値へフォールバックせず、本文を含まないエラーで呼び出し全体が失敗し、途中までの結果も返しません。ページを分けて読む場合は各呼び出しに sanitizer を渡してください。`session messages` と operator-agent の `list_conductor_messages` は渡さないため、引き続き raw 出力です。
- **限界:** callback は未加工の本文を受け取ります。自由文の秘密値を完全に見つける保証はなく、どの値を検出・置換できるかは利用側の実装に依存します。callback 自身が本文をログ・保存・転送すれば、この API の適用境界外です。本文以外の metadata に秘密値が含まれる場合も sanitizer の対象外です。後段で利用する場合は、返却された結果を集計・蓄積へ渡してください。

```ts
import {
  listConductorProviderHistory,
  type ConductorProviderHistorySanitizer,
} from '@agents-ensemble/core/operator-runtime';

const sanitizer: ConductorProviderHistorySanitizer = (value, field) =>
  sanitizeForStorage(value, field);
const history = await listConductorProviderHistory({
  backend,
  conductorAgentId,
  cwd, // Pi SessionManager に渡す cwd
  repoRoot, // 現在 clone。Issue context と canonical slug の解決に使う root
  issueUrl, // canonical slug の repository identity
  resumeCwds: [savedCwd], // canonical transcript 内で保存済み CWD の session を照合
  query: { limit: 20, order: 'desc' },
  sanitizer,
});
await aggregateOrStore(history);
```

- **Pi 1.2.0:** active branch の user / assistant entry ID を custom metadata から引き、保存済み本文を再構成します。metadata に本文は複製せず、LLM context にも入りません。順序は active branch の履歴順、`at` は harness が記録した send 完了時刻（Unix ms）、`providerId` は final assistant entry ID です。別 branch に移った発言は一覧から外れます。初回 `initial` send は marker を作りません。機能導入前のPi sessionは過去のtranscriptを遡ってmarker付けしません。そのため、導入後にcustom metadata markerが記録されたsendだけが一覧に出ます。markerが一件もないsessionは、session fileを正常に読める限りエラーではなく、空一覧（`messages: []`, `hasMore: false`）を返します。
- **Cursor 1.0.27:** pinned `Agent.listRuns()` / `Agent.getRun()` と run の `conversation()` から再構成し、cursor pagination で直近 100 件を選びます。順序は SDK run order、`at` は run 作成時刻（Unix ms）、`providerId` は run ID、取得できる場合は `requestId` も返します。新規 session は bootstrap run ID を SessionResumeStore に保存します。これを持たない既存 session では先頭 run を bootstrap とみなします。Cursor は `sendCount` / `dispatchSource` を提供しないため、それらの field は返しません。
- **ページング:** `order` は provider history order の `asc` / `desc`、`cursor` は返却行の `providerId` を使う排他的境界です。`hasMore` は保持対象の直近 100 件内に次ページがある場合に true です。Pi の `sendCount` / `dispatchSource` は harness metadata で、Cursor の provider ID / request ID と共通通し番号ではありません。
- **retention:** Pi JSONL と Cursor local store の保持・削除期間は SDK / local store の管理に委ねます。今回、長期保持や削除保証は追加しません。Pi では active branch と marker が参照する entry が必要です。Cursor では対象 run と conversation が必要です。

この tool の出力は UDS `session.conductor_messages.list` の integer `sendCount` pagination / 1 MiB response 契約とは別です。`get_last_conductor_message` と終了 JSON は引き続き既存経路・既存形式を使います。

## Persistence、acknowledgment、errors

回答候補は Open Questions YAML に atomic save されてから live Registry と event queue に反映されます。YAML は回答永続化・resume の正本で、SessionResumeStore は JSON mirror として更新されます。通常の success response は YAML save と conductor dispatch receipt の成功後に返ります。SessionResumeStore の flush 成功は success 条件ではありません。回答処理で mirror 更新に失敗すると warning を記録し、後続 flush を一度 schedule して再同期を試みます。これは再同期の保証ではなく、その flush も失敗した場合は warning を記録してこの経路での再試行を終えます。

通常の永続化先は `~/.ensemble/sessions/github.com/<owner>/<repo>/{conductorAgentId}/open-questions.yaml`、SessionResumeStore は `~/.ensemble/sessions/github.com/<owner>/<repo>/{conductorAgentId}.json` です。`~/.ensemble/sessions/<repoKey>/` は migration source であり、runtime は読みません。SessionResumeStore は `harnessSocketPath` の endpoint index を持ち、Open Question snapshot も mirror として含みます。

JSON-RPC error は次の envelope です。`data` は該当する場合だけ付きます。

```json
{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"Open Question operation failed."}}
```

| Code | 意味 |
|------|------|
| `-32700` | JSON parse error |
| `-32600` | 不正 request。過大 request や1 connectionに複数 request を含めた場合を含む |
| `-32601` | 未対応 method |
| `-32602` | answer の `questionId` / `answer`、operator message の `text` / `delivery`、または shutdown の `mode` / params が不正・不足 |
| `-32603` | 汎用 operation error。YAML save に失敗した場合はこの error となり、live Registry と event queue は更新されません |
| `-32000` | live server が request を処理できる状態で session shutdown が進行中、または終了要求がすでに受理されています（`operator.message.send` / `operator.session.shutdown`） |
| `-32004` | question が存在しない、またはすでに回答済み |
| `-32005` | 保存済み回答の conductor dispatch 完了を確認できない（send failure / shutdown を含む） |

`operator.message.send` は `text` が空、または `delivery` が `idle` / `next` / `interrupt` 以外なら `-32602` を返します。session が shutdown 処理中なら `-32000`、message 送信が利用できない server なら `-32601` です。message 送信の JSON-RPC 成功 response は event queue への受理を確認するだけであり、conductor dispatch の receipt ではありません。

YAML save 前に失敗した場合、generic `-32603` に `outcome` data はなく、回答は live Registry に適用されず conductor に通知されません。回答が YAML に保存された後、dispatch 完了を確認できない場合は成功とみなさず、通常は次の `-32005` error data を返します。

```json
{"outcome":"unknown","answerStatus":"recorded","dispatchStatus":"unknown"}
```

保存済みだが dispatch receipt を作れなかった error path は `-32603` となる場合があります。その場合も同じ `data` が付き、outcome は unknown です。JSON-RPC error の message / code だけで保存済み回答を再送しないでください。

## Retry、fallback と運用

- UDS client は request を自動再送しません。client が `connect` event を受け取る前の transport failure だけが `outcome: not_sent` です。`connect` 時点で client は `requestSent` を true にし、その後に `socket.write` が失敗した場合も、response を受け取れない transport failure は `outcome: unknown` です。これらは JSON-RPC response ではなく client 側の transport error で、`unknown` は request 全体が server に届いたことを保証するものではありません。operator message の場合も、server が受理済みか分からないため、同じ指示をそのまま再送しないでください。
- `operator.session.shutdown` の受理後、server が新しい接続を閉じ始めます。その後の接続失敗も成功 response ではなく transport error です。受付 outcome が不明な場合は自動再送せず、live session の状態を確認してください。
- client の30秒 timeout や切断後も、server が request newline を受信して handler を開始済みなら、YAML commit や conductor dispatch が続く場合があります。特に `outcome: unknown` のときは、その時点で YAML に回答が見えないことだけを根拠に再送しないでください。保存・dispatch の結果が不確定なままなので、session の状態とログを確認して運用者が次の操作を判断してください。
- shutdown intent 後は bounded drain 中も conductor reconnect / 同一 message retry を抑止します。回答 dispatch の完了を確認できない場合は `outcome: unknown` となり、回答は保存済みの可能性があります。
- live Open Question list / answer / operator message / last conductor response tool は listener がない場合に YAML fallback をしません。watch pool の `session.observe` poll だけが停止中・未対応 session の YAML / SessionResumeStore に保存された情報を読み取ります。YAML への書き込み fallback、filesystem event watch、固定 TCP、GitHub comment 同期、自動解決はありません。
- operator message の queue 受理 response が返る前に接続が切れた場合も、message が受理済みの可能性があります。client は request を自動再送しないため、unknown outcome では session と会話を確認してから次の操作を判断してください。
- `outcome: unknown` の場合、回答を自動再送しないでください。`open-questions.yaml` と保存済み session state / session log を確認して運用者が次の操作を判断します。ただし、その時点で YAML に回答が見つからなくても、元の handler がまだ処理中の可能性があるため、それだけを根拠に再送しないでください。SessionResumeStore は mirror のため、YAML と一時的に一致しない可能性があります。

conductor send の通常時の再接続方針は既存 dispatch policy に従います。この UDS client protocol 自体は retry を行わず、shutdown 後に同じ `operator.message` を再 dispatch しません。

## Security と privacy

- user-scoped canonical slug session directory と session data directory、UDS runtime directory は owner-only (`0700`) です。SessionResumeStore の JSON、Open Questions YAML、socket は owner read/write (`0600`) です。legacy migration sources の権限は user / repository directory の ACL / mode に従います。
- token 認証はありません。同じ OS user の別 process は socket に接続できる trust boundary です。
- UDS server は request / response body を access log に出しません。一方、既存 CLI の operator observation は質問本文・回答本文を非 TTY では stderr、TTY では TUI activity log に表示し、SessionResumeStore / YAML にも保存します。最後の conductor 応答 API も同じ OS user の client に本文を返します。
- API は質問・context・choice を保存値のまま返します。自由文中の secret や repository 外情報を検出する一般的な redaction はありません。機密値を質問・context・回答へ含めないでください。詳細は [session-logging.md](session-logging.md) を参照してください。

## 関連文書

- [Operator input](operator-input.md)
- [Architecture](architecture.md)
- [ADR 0033: UDS control API](adr/0033-live-open-question-control-uds.md)
- [ADR 0035: bounded shutdown / persistence ordering](adr/0035-open-question-shutdown-commit-order.md)
- [ADR 0036: answer acknowledgment contract](adr/0036-live-open-question-answer-contract.md)
