# 稼働中 harness control API

この文書は、稼働中の `ensemble issue` harness が提供する UDS control interface の利用者・integrator 向け reference です。設計判断の履歴は [ADR 0033](adr/0033-live-open-question-control-uds.md)、[ADR 0035](adr/0035-open-question-shutdown-commit-order.md)、[ADR 0036](adr/0036-live-open-question-answer-contract.md) を参照してください。

## Scope と役割

- session ごとの listener は、稼働中 `ensemble issue` プロセス内の harness が起動・停止します。
- operator-agent は client です。listener の起動や停止中 session の回答保存は行いません。
- API は稼働中 session の Open Question 一覧・回答、watch 用 observation snapshot、operator-agent から conductor への明示メッセージ、最後の conductor 成功応答取得、成功応答と対応する inbound の bounded list を提供します。質問の保存・resume の正本は引き続き Open Questions YAML です。conductor 発言一覧は live harness のメモリ内 ring buffer で、SessionResumeStore・YAML・session log には保存しません。

operator-agent には `list_live_open_questions` / `answer_live_open_question`、watch pool の `register_session_watch` / `unregister_session_watch`、`send_operator_message`、`get_last_conductor_message`、`list_conductor_messages`、`register_conductor_message_listen` / `unregister_conductor_message_listen` の tool があります。session を指定する tool は `list_operator_sessions` で得た `conductorAgentId` を受け取ります。回答 tool は `questionId` と `answer`、送信 tool は `text` と任意の `delivery` を要求します。各 tool の input schema は未知の field を許可しません。

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

`get_last_conductor_message`:

```json
{"conductorAgentId":"agent-123"}
```

`list_conductor_messages`:

```json
{"conductorAgentId":"agent-123","limit":20,"order":"desc","cursor":44}
```

`register_conductor_message_listen`:

```json
{"conductorAgentId":"agent-123","messageDebounceMs":10000}
```

list tool の `structuredContent` は UDS の `result`（`{ "questions": [...] }`）です。answer tool の text content は UDS result (`{ "question": {...} }`) を JSON 表示し、`structuredContent` は `questionId`, `status`, 任意の `answeredBy`, `approved` を持つ object に整形します。これは operator-agent tool wrapper の出力で、UDS wire response とは形が異なります。

## Operator-agent watch state の欠損・破損と復旧

watch pool は `.ensemble/operator-agent/watch-state.json` に watch 登録、session ごとの cursor、未 dispatch report を atomic に保存します。

- **state file が存在しない場合:** empty state として起動し、watch pool は空です。保存済み watch 登録・cursor・未 dispatch report は復元されません。監視を再開するには対象 session ごとに `register_session_watch` を実行してください。cursor がないため、再登録後の最初の成功した snapshot は既存 Open Question ID の silent baseline になります。その snapshot にすでに含まれる質問（state 欠損中に追加された質問も含む）は新規通知として replay されません。baseline 後に追加された ID は通常どおり通知されます。
- **JSON または state schema が不正な場合:** operator-agent の初期化は失敗し、empty state へ黙って置き換えません。保存ファイルを退避してから、有効な backup を戻すか、version と必須 field を修復して再起動してください。state を意図的に破棄する場合も、まず必要ならコピーを保全してください。ファイルを取り除いて再起動すると empty state から始まり、上記の再登録と silent baseline が必要です。
- **report hold:** hold は watch state には保存されない会話中の状態です。再起動後は解除状態で始まります。

## Endpoint discovery と lifecycle

operator-agent は `.ensemble/sessions/{conductorAgentId}.json` にある SessionResumeStore から `harnessSocketPath` を読み、接続先を得ます。socket は OS の一時 directory 内の `ens-oq-*` runtime directory に作成されます。socket path を推測せず、SessionResumeStore に記録された値を使ってください。

path の記録は listener の稼働確認ではありません。session が停止中、終了処理中、または接続不能なら接続は失敗します。`list_live_open_questions`、`answer_live_open_question`、`send_operator_message`、`get_last_conductor_message`、`list_conductor_messages` は直接 live control であり、YAML / SessionResumeStore へ fallback しません。watch pool の `register_session_watch` のみが `session.observe` を試し、UDS が到達不能または method 未対応なら保存 snapshot へ切り替えます。発言 listen は UDS が利用できない間も保存値へ切り替えず、次の poll で再接続を試します。

listener の起動後に `harnessSocketPath` を含む初回 SessionResumeStore flush が失敗しても、warning を記録して session は続行し、listener は稼働したままの場合があります。このとき SessionResumeStore に新しい path が書かれていなければ client は endpoint を発見・接続できません。別の接続先を探す自動 fallback はありません。

停止時は listener が新しい request を受け付けなくなり、受理済み request の処理を最大5秒 drain します。期限内に終わらなければ driver を abort し、server と一時 runtime directory を閉じて削除し、SessionResumeStore から `harnessSocketPath` を外します。

## Wire format

Transport は Unix domain socket 上の JSON-RPC 2.0 over NDJSON です。1 connection につき request は1件、response も1件です。JSON object を1行（末尾に newline）で送り、response の `id` は request の `id` と一致します。request ID は string または finite number、`params` は object です。

実装上の上限は request / response あたり1 MiB、client socket timeout は30秒です。server にも request line を受信するまでの socket timeout がありますが、newline を受け取ると解除して handler を実行します。このため server の handler / dispatch 処理時間は30秒では打ち切られません。追加の request を同じ connection に送る interface ではありません。

## Methods

### `session.observe`

稼働中 harness の観測 snapshot を返します。operator-agent watch pool は polling のたびにこの method を呼び、質問 sequence と質問ごとの fingerprint、session-state の `reportedAt` を cursor として保存します。watch に保存済み cursor がない場合、初回 snapshot の質問 ID を通知なしで baseline に登録します。以後、新しい ID で現在 `open` の質問だけを追加報告し、同じ質問の YAML / SessionResumeStore への flush は session ごとの cursor で重複排除します。UDS が利用できる間は Registry snapshot を優先し、記録された socket が到達不能、または古い harness が snapshot method に未対応の場合は、保存済み Open Questions YAML / session-state YAML / legacy SessionResumeStore を poll します。報告には観測元を付けます。

Request:

```json
{"jsonrpc":"2.0","id":3,"method":"session.observe","params":{}}
```

Response:

```json
{"jsonrpc":"2.0","id":3,"result":{"sequence":2,"openQuestions":[{"id":"inq-1","question":"Proceed?","responseType":"yes_no","source":"conductor","status":"open","askedAt":1792512000000}],"sessionState":{"current":{"statusLine":"CI 待ち","reportedAt":1792512001000},"history":[]}}}
```

`openQuestions` は live Registry の全質問（未回答・回答済み）です。`sessionState` は報告がある場合だけ含みます。`sequence` は質問の enqueue cursor で、operator-agent は質問 ID の fingerprint を cursor に保存し、新規 open 質問の判定と YAML / UDS 間の重複排除に使います。新規 watch または cursor 欠損時は、初回 snapshot にすでに含まれる質問を既存状態として扱い、以後に追加された ID だけを通知します。session-state report の変更検出には各質問 fingerprint とは別に `reportedAt` を使います。この method は読み取り専用で、各 poll は独立した短い JSON-RPC 接続です。

watch report は既存 operator-agent queue の `open_question:${conductorAgentId}` source と debounce / batch / report hold を通ります。質問本文を含む report は operator-agent への入力であり、複数 session は session ごとに別の batch として Issue URL・conductor ID 付きで整形されます。

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

成功した conductor 応答と、その応答に対応する conductor 向け inbound を一覧します。記録対象は bootstrap の `agent.send` を除く send のうち、`status=finished` かつ trim 後の `result` が空でないものです。`inbound` はその send に渡した `formatSessionEventsForConductor(batch)` の全文です。bootstrap send は compiled `initialPrompt` を送るため対象外です。

稼働中 session ごとに直近 100 件を保持します。これは bounded なプロセス内履歴で、harness 停止時に破棄され、停止後に YAML / sidecar へ fallback しません。

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

`messages` は要求された順序で並びます。`hasMore` は同じ filter の結果に次ページがあることを示します。通常の keyset pagination では、返却末尾の `sendCount` を次の `cursor` に渡してください。`dispatchSource` は識別可能な場合に限って付きます。operator-agent の `list_conductor_messages` は同じページング規約を使います。既存の `get_last_conductor_message` / `session.last_conductor_message.get` は応答本文・`at`・`sendCount` のみを返し、変更しません。

UDS response の上限は従来どおり **1,048,576 bytes（1 MiB）** です。list の JSON response 全体がこの上限を超えると、部分結果や切り詰めた inbound は返さず、JSON-RPC `-32603` / `Response is too large.` を返します。1件だけの要求でも、その1件の全文 inbound を含む response が上限を超えれば同じ error になります。単独の1件だけが上限超過の原因と特定できる場合、error の `data.oversizedSendCount` にその `sendCount` が付きます。これは listen が cursor を進めるための識別情報で、list の呼び出し自体は引き続き error です。上限内に収まる場合は inbound 全文を返します。

### 発言 listen と OQ watch の分離

`register_conductor_message_listen` は `conductorAgentId` と任意の `messageDebounceMs`（既定 10,000ms、0–120,000ms）を受け取ります。登録直後の live poll は既存の最新 `sendCount` を baseline とし、その後に増えた発言だけを poll します。baseline の最新 record が単独で上限を超える場合は、size error の `data.oversizedSendCount` を使ってその record を silent baseline に含め、登録を完了します。debounce window に複数の発言があれば、sendCount 昇順で inbound / response の section を 1 report にまとめます。`unregister_conductor_message_listen` は以後の polling を止めます。

発言 listen は operator-agent が UDS を polling し、独立した `messageCursors` を使います。`register_session_watch` の Open Question / status cursor と混ぜません。harness が停止中、UDS が到達不能、または method 未対応の場合は発言 listen に fallback はありません。通常の session watch の保存 YAML fallback とも別動作です。

新しい listen の登録は、最初の baseline poll が成功してから完了します。baseline 取得に失敗した場合、register は error を返し、その呼び出しで追加した listener と timer を撤去します。既存 listen の設定変更中に poll が失敗した場合は、変更前の listener 設定と timer に戻します。

operator-agent の listen は limit 20 の page から読み始め、aggregate response が 1 MiB を超えた場合は同じ exclusive cursor から limit を下げて再試行します。取得できた複数 page はその poll の debounce report にまとめ、sendCount 昇順で通知します。cursor は取得済み page の最後までだけ進めるため、retry で発言を飛ばしたり並べ替えたりしません。

limit 1 でも単独 response が上限を超える発言に達した場合、その発言の `sendCount` を使って listen cursor を安全に進めます。読み取れなかった発言は内容を切り詰めずに読み飛ばし、同じ debounce window に複数 poll で見つかったものも含め、report ごとに件数と `sendCount` を列挙した warning section 1つにまとめます。その後も polling を続け、後続の読み取り可能な発言を順序どおり通知します。先に取得した page、読み飛ばした発言、後続 page は同じ report window にまとめられます。list API はこの動作をせず、単独 oversized record を含む response に対して従来どおり明示的な size error を返します。

## Persistence、acknowledgment、errors

回答候補は Open Questions YAML に atomic save されてから live Registry と event queue に反映されます。YAML は回答永続化・resume の正本で、SessionResumeStore は JSON mirror として更新されます。通常の success response は YAML save と conductor dispatch receipt の成功後に返ります。SessionResumeStore の flush 成功は success 条件ではありません。回答処理で mirror 更新に失敗すると warning を記録し、後続 flush を一度 schedule して再同期を試みます。これは再同期の保証ではなく、その flush も失敗した場合は warning を記録してこの経路での再試行を終えます。

永続化先は `.ensemble/sessions/{conductorAgentId}/open-questions.yaml`、SessionResumeStore は `.ensemble/sessions/{conductorAgentId}.json` です。SessionResumeStore は `harnessSocketPath` の endpoint index を持ち、Open Question snapshot も互換用 mirror として含みます。

JSON-RPC error は次の envelope です。`data` は該当する場合だけ付きます。

```json
{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"Open Question operation failed."}}
```

| Code | 意味 |
|------|------|
| `-32700` | JSON parse error |
| `-32600` | 不正 request。過大 request や1 connectionに複数 request を含めた場合を含む |
| `-32601` | 未対応 method |
| `-32602` | answer の `questionId` / `answer`、または operator message の `text` / `delivery` が不正・不足 |
| `-32603` | 汎用 operation error。YAML save に失敗した場合はこの error となり、live Registry と event queue は更新されません |
| `-32000` | session が shutdown 処理中 |
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
- client の30秒 timeout や切断後も、server が request newline を受信して handler を開始済みなら、YAML commit や conductor dispatch が続く場合があります。特に `outcome: unknown` のときは、その時点で YAML に回答が見えないことだけを根拠に再送しないでください。保存・dispatch の結果が不確定なままなので、session の状態とログを確認して運用者が次の操作を判断してください。
- shutdown intent 後は bounded drain 中も conductor reconnect / 同一 message retry を抑止します。回答 dispatch の完了を確認できない場合は `outcome: unknown` となり、回答は保存済みの可能性があります。
- live Open Question list / answer / operator message / last conductor response tool は listener がない場合に YAML fallback をしません。watch pool の `session.observe` poll だけが停止中・未対応 session の YAML / SessionResumeStore に保存された情報を読み取ります。YAML への書き込み fallback、filesystem event watch、固定 TCP、GitHub comment 同期、自動解決はありません。
- operator message の queue 受理 response が返る前に接続が切れた場合も、message が受理済みの可能性があります。client は request を自動再送しないため、unknown outcome では session と会話を確認してから次の操作を判断してください。
- `outcome: unknown` の場合、回答を自動再送しないでください。`open-questions.yaml` と保存済み session state / session log を確認して運用者が次の操作を判断します。ただし、その時点で YAML に回答が見つからなくても、元の handler がまだ処理中の可能性があるため、それだけを根拠に再送しないでください。SessionResumeStore は mirror のため、YAML と一時的に一致しない可能性があります。

conductor send の通常時の再接続方針は既存 dispatch policy に従います。この UDS client protocol 自体は retry を行わず、shutdown 後に同じ `operator.message` を再 dispatch しません。

## Security と privacy

- `.ensemble/sessions/` と session data directory、UDS runtime directory は owner-only (`0700`) です。SessionResumeStore の JSON、Open Questions YAML、socket は owner read/write (`0600`) です。
- token 認証はありません。同じ OS user の別 process は socket に接続できる trust boundary です。
- UDS server は request / response body を access log に出しません。一方、既存 CLI の operator observation は質問本文・回答本文を非 TTY では stderr、TTY では TUI activity log に表示し、SessionResumeStore / YAML にも保存します。最後の conductor 応答 API も同じ OS user の client に本文を返します。
- API は質問・context・choice を保存値のまま返します。自由文中の secret や repository 外情報を検出する一般的な redaction はありません。機密値を質問・context・回答へ含めないでください。詳細は [session-logging.md](session-logging.md) を参照してください。

## 関連文書

- [Operator input](operator-input.md)
- [Architecture](architecture.md)
- [ADR 0033: UDS control API](adr/0033-live-open-question-control-uds.md)
- [ADR 0035: bounded shutdown / persistence ordering](adr/0035-open-question-shutdown-commit-order.md)
- [ADR 0036: answer acknowledgment contract](adr/0036-live-open-question-answer-contract.md)
