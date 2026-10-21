# 稼働中 Open Question control API

この文書は、稼働中の `ensemble issue` harness が提供する UDS control interface の利用者・integrator 向け reference です。設計判断の履歴は [ADR 0033](adr/0033-live-open-question-control-uds.md)、[ADR 0035](adr/0035-open-question-shutdown-commit-order.md)、[ADR 0036](adr/0036-live-open-question-answer-contract.md) を参照してください。

## Scope と役割

- session ごとの listener は、稼働中 `ensemble issue` プロセス内の harness が起動・停止します。
- operator-agent は client です。listener の起動や停止中 session の回答保存は行いません。
- API は稼働中 session の未回答 Open Question の一覧取得と回答、および最後の conductor 成功応答の取得を提供します。質問の保存・resume の正本は引き続き Open Questions YAML です。

operator-agent には `list_live_open_questions`、`answer_live_open_question`、`get_last_conductor_message` の tool があります。いずれも `conductorAgentId` を受け取り、`list_operator_sessions` で得た session を選びます。回答 tool はさらに `questionId` と `answer` を要求します。各 tool の入力に未知の field は許可されません。

operator-agent tool の input は次のとおりです。

`list_live_open_questions`:

```json
{"conductorAgentId":"agent-123"}
```

`answer_live_open_question`:

```json
{"conductorAgentId":"agent-123","questionId":"inq-1","answer":"yes"}
```

`get_last_conductor_message`:

```json
{"conductorAgentId":"agent-123"}
```

list tool の `structuredContent` は UDS の `result`（`{ "questions": [...] }`）です。answer tool の text content は UDS result (`{ "question": {...} }`) を JSON 表示し、`structuredContent` は `questionId`, `status`, 任意の `answeredBy`, `approved` を持つ object に整形します。これは operator-agent tool wrapper の出力で、UDS wire response とは形が異なります。

## Endpoint discovery と lifecycle

operator-agent は JSON sidecar `.ensemble/sessions/{conductorAgentId}.json` の `harnessSocketPath` を読み、接続先を得ます。socket は OS の一時 directory 内の `ens-oq-*` runtime directory に作成されます。socket path を推測せず、sidecar に記録された値を使ってください。

path の記録は listener の稼働確認ではありません。session が停止中、終了処理中、または接続不能なら接続は失敗します。YAML への自動 fallback はありません。

listener の起動後に `harnessSocketPath` を含む初回 sidecar flush が失敗しても、warning を記録して session は続行し、listener は稼働したままの場合があります。このとき sidecar に新しい path が書かれていなければ client は endpoint を発見・接続できません。別の接続先を探す自動 fallback はありません。

停止時は listener が新しい request を受け付けなくなり、受理済み request の処理を最大5秒 drain します。期限内に終わらなければ driver を abort し、server と一時 runtime directory を閉じて削除し、sidecar から `harnessSocketPath` を外します。

## Wire format

Transport は Unix domain socket 上の JSON-RPC 2.0 over NDJSON です。1 connection につき request は1件、response も1件です。JSON object を1行（末尾に newline）で送り、response の `id` は request の `id` と一致します。request ID は string または finite number、`params` は object です。

実装上の上限は request / response あたり1 MiB、client socket timeout は30秒です。server にも request line を受信するまでの socket timeout がありますが、newline を受け取ると解除して handler を実行します。このため server の handler / dispatch 処理時間は30秒では打ち切られません。追加の request を同じ connection に送る interface ではありません。

## Methods

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

### `session.last_conductor_message.get`

稼働中 harness が保持する最後の成功応答を取得します。読み取り専用で、`session.observe` や Open Questions YAML / sidecar には含めません。セッション内に成功応答がまだない場合は `message: null` です。成功応答の後に失敗または本文なしの send があっても、直前の成功応答を返します。

Request:

```json
{"jsonrpc":"2.0","id":3,"method":"session.last_conductor_message.get","params":{}}
```

Response（応答あり）:

```json
{"jsonrpc":"2.0","id":3,"result":{"message":{"text":"回答本文","at":1792512003000,"sendCount":44}}}
```

Response（応答なし）:

```json
{"jsonrpc":"2.0","id":3,"result":{"message":null}}
```

| Field | Type | 意味 |
|-------|------|------|
| `message.text` | string | `conductor.send` が `finished` で本文が空でない場合の trim 済み応答本文 |
| `message.at` | number | harness が send 完了を処理した時刻（Unix epoch milliseconds） |
| `message.sendCount` | number | 対応する `conductor.send` の通し番号 |

operator の入力、応答履歴、失敗応答は返しません。状態は稼働中プロセスのメモリ内だけにあり、再開した session には引き継がれません。operator-agent tool の `structuredContent` と text content は、UDS result と同じ `{ "message": ... }` です。

## Persistence、acknowledgment、errors

回答候補は Open Questions YAML に atomic save されてから live Registry と event queue に反映されます。YAML は回答永続化・resume の正本で、JSON sidecar は mirror です。通常の success response は YAML save と conductor dispatch receipt の成功後に返ります。sidecar の flush 成功は success 条件ではありません。回答処理で mirror 更新に失敗すると warning を記録し、後続 flush を一度 schedule して再同期を試みます。これは再同期の保証ではなく、その flush も失敗した場合は warning を記録してこの経路での再試行を終えます。

永続化先は `.ensemble/sessions/{conductorAgentId}/open-questions.yaml`、sidecar は `.ensemble/sessions/{conductorAgentId}.json` です。sidecar は `harnessSocketPath` の endpoint index を持ち、Open Question snapshot も互換用 mirror として含みます。

JSON-RPC error は次の envelope です。`data` は該当する場合だけ付きます。

```json
{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"Open Question operation failed."}}
```

| Code | 意味 |
|------|------|
| `-32700` | JSON parse error |
| `-32600` | 不正 request。過大 request や1 connectionに複数 request を含めた場合を含む |
| `-32601` | 未対応 method |
| `-32602` | answer の `questionId` または `answer` が空・不足 |
| `-32603` | 汎用 operation error。YAML save に失敗した場合はこの error となり、live Registry と event queue は更新されません |
| `-32000` | session が shutdown 処理中 |
| `-32004` | question が存在しない、またはすでに回答済み |
| `-32005` | 保存済み回答の conductor dispatch 完了を確認できない（send failure / shutdown を含む） |

YAML save 前に失敗した場合、generic `-32603` に `outcome` data はなく、回答は live Registry に適用されず conductor に通知されません。回答が YAML に保存された後、dispatch 完了を確認できない場合は成功とみなさず、通常は次の `-32005` error data を返します。

```json
{"outcome":"unknown","answerStatus":"recorded","dispatchStatus":"unknown"}
```

保存済みだが dispatch receipt を作れなかった error path は `-32603` となる場合があります。その場合も同じ `data` が付き、outcome は unknown です。JSON-RPC error の message / code だけで保存済み回答を再送しないでください。

## Retry、fallback と運用

- UDS client は request を自動再送しません。client が `connect` event を受け取る前の transport failure だけが `outcome: not_sent` です。`connect` 時点で client は `requestSent` を true にし、その後に `socket.write` が失敗した場合も、response を受け取れない transport failure は `outcome: unknown` です。これらは JSON-RPC response ではなく client 側の transport error で、`unknown` は request 全体が server に届いたことを保証するものではありません。
- client の30秒 timeout や切断後も、server が request newline を受信して handler を開始済みなら、YAML commit や conductor dispatch が続く場合があります。特に `outcome: unknown` のときは、その時点で YAML に回答が見えないことだけを根拠に再送しないでください。保存・dispatch の結果が不確定なままなので、session の状態とログを確認して運用者が次の操作を判断してください。
- shutdown intent 後は bounded drain 中も conductor reconnect / 同一 message retry を抑止します。dispatch の完了を確認できない場合は `outcome: unknown` となり、回答は保存済みの可能性があります。
- listener がない場合に YAML を直接読む・書く fallback、file watch、固定 TCP、GitHub comment 同期、自動解決はありません。
- `outcome: unknown` の場合、回答を自動再送しないでください。`open-questions.yaml` と保存済み session state / session log を確認して運用者が次の操作を判断します。ただし、その時点で YAML に回答が見つからなくても、元の handler がまだ処理中の可能性があるため、それだけを根拠に再送しないでください。sidecar は mirror のため、YAML と一時的に一致しない可能性があります。

conductor send の通常時の再接続方針は既存 dispatch policy に従います。この UDS client protocol 自体は retry を行わず、shutdown 後に同じ `operator.message` を再 dispatch しません。

## Security と privacy

- `.ensemble/sessions/` と session data directory、UDS runtime directory は owner-only (`0700`) です。JSON sidecar、Open Questions YAML、socket は owner read/write (`0600`) です。
- token 認証はありません。同じ OS user の別 process は socket に接続できる trust boundary です。
- UDS server は request / response body を access log に出しません。一方、既存 CLI の operator observation は質問本文・回答本文を非 TTY では stderr、TTY では TUI activity log に表示し、sidecar / YAML にも保存します。最後の conductor 応答 API も同じ OS user の client に本文を返します。
- API は質問・context・choice を保存値のまま返します。自由文中の secret や repository 外情報を検出する一般的な redaction はありません。機密値を質問・context・回答へ含めないでください。詳細は [session-logging.md](session-logging.md) を参照してください。

## 関連文書

- [Operator input](operator-input.md)
- [Architecture](architecture.md)
- [ADR 0033: UDS control API](adr/0033-live-open-question-control-uds.md)
- [ADR 0035: bounded shutdown / persistence ordering](adr/0035-open-question-shutdown-commit-order.md)
- [ADR 0036: answer acknowledgment contract](adr/0036-live-open-question-answer-contract.md)
