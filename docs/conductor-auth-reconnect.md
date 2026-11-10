# conductor send 経路の in-process 再接続

> **正本:** conductor send の認証エラー時に行う in-process 再接続の設計。認証情報・トークンの解決は [settings.md](settings.md) と [config.md](config.md)、CLI の入口は [cli/README.md](cli/README.md) を参照します。

Issue #101 の設計メモ。

## 背景

`@cursor/sdk` の local agent は長時間アイドルや sleep/wakeup 後、短命 access token の失効により次の `agent.send()` が `UNAUTHENTICATED` 相当で失敗することがある。API key 自体は有効で、`Agent.resume(sameId)` ですぐ復旧する（[Cursor forum #163819](https://forum.cursor.com/t/idle-local-agent-grpc-connection-returns-error-not-logged-in-authenticationerror-instead-of-networkerror-after-15-minutes/163819)）。

agents-ensemble の conductor は長寿命 `ConductorAgent` 1 本を保持する。worker（ACP）は別プロセスで SessionResumeStore に `acpSessionId` を保存するため、conductor 接続だけが切れても worker は生存しうる。

## 採用方式

send が auth-like error のとき:

`close` → `ConductorAgentFactory.resume(sameId)` → send 再試行（1 回）

tool 開始通知があった場合は、同じ prompt の再送を行わず元の error を返す。それ以外は同じ prompt を 1 回だけ再試行する。まだ auth error が残る場合は PR #99 互換の backend 固有 `[auth]` ヒントへフォールバックする。Cursor は手動 `logout` → `login`、Pi は `ensemble auth login --provider <provider>` または project/user auth の確認を案内し、project 層の OAuth credential は stale token を使わず user 層へ移すよう案内する。TTY が継続中なら認証修復後に `/reconnect` を試すか、状態確認後に新しい operator message を送る。process 終了後は `--resume` / `--continue` で session を再開し、新しい message から作業を続ける。in-process での自動 `login` は行わない（オペレータ方針）。

**非採用**

- `agent.reload()` — filesystem config（hooks / MCP / subagents）の再読込のみ。gRPC / token の張り直しではない。
- `Agent.create()` — 新 `agentId` になり resume / SessionResumeStore モデルと不整合。

実装: `packages/core/src/conductor/conductor-send-reconnect.ts`（driver の全 send 経路から呼ぶ）。

## auth-like error の検知

1. 既存 `isConductorAuthError(message)` — 明示的な認証メッセージ。Pi の API key 解決失敗 `API key auth failed for provider ...` も含む
2. backend の error code — Pi 1.2.0 の `ModelsError.code === "auth"` を adapter が `ConductorSendResult.error.code` に保持する
3. **保守的 bare heuristic** — `status: "error"` かつ `error.message` も `result` も空（SDK idle 後の既知症状）。明示的な非 auth `error.code` がある場合は除外。

誤検知リスク: 他の原因でも message 欠落の error になりうる。その場合は同じ agent ID で resume する。tool 開始通知がなければ 1 回 retry し、tool が始まっていれば prompt は再送せず、auth-like error が残れば `[auth]` ヒントへフォールバックする。

Pi 1.2.0 は `apiKey.resolve()` の失敗を `ModelsError("auth", "API key auth failed for provider ...")` に包み、cause の詳細も message に含める（[auth resolver](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/src/auth/resolve.ts#L947-L969)、[ModelsError](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/src/utils/models-error.ts#L219-L245)）。adapter は `auth` code を保持する。provider request の前に出る error でも、同じ send の先行 round で tool が実行済みの場合があるため、tool 開始通知があれば同じ prompt を再送しない。tool が始まっていない send に限り、同じ agent ID で resume した後、同一 prompt を 1 回だけ再試行する。send の最終結果が auth error の場合は `conductor.auth.recovery` と provider 固有 hint を出す。

## イベント

| イベント | タイミング |
|----------|------------|
| `conductor.auth.reconnect` | `resume(sameId)` 試行時 |
| `conductor.auth.recovery` | send の最終結果が auth error のとき。resume / retry の失敗や、tool 開始後に retry を抑止した場合を含む（PR #99 互換の `[auth]` hint） |

## transport stall の自動・手動再接続

`Connection stalled repeatedly` など、明示的な connection / transport timeout 系の
`error.message` または `error.code` は auth と分けて transport error と判定する。send ごとに
1 回だけ `close` → `resume(sameId)` を行う。tool 開始通知がなければ同じ prompt を 1 回だけ
再送し、tool が始まっていた場合は副作用の重複を避けて再送せず元の error 結果を返す。
再接続または再送に失敗しても元の error 結果を返し、`continueOnConductorError` が有効な
対話セッションは継続する。

この経路では `conductor.transport.reconnect` を attempt / success / failure の各状態で
emit し、auth の `[auth]` recovery hint は表示しない。オペレータは `/reconnect`（または
`reconnect`）で同じ `resume(sameId)` を手動実行できる。手動操作は直近 send の完了後に
行います。`/reconnect` 自体は prompt を送信しません。

`ensemble issue` の通常の `SessionEvent` dispatch が最終的に Pi の API key resolver failure（`error.code === "auth"` かつ
`API key auth failed for provider ...: Failed to resolve API key ...`）で終わると、driver は失敗 batch
を再送用 queue に戻さず、手動復旧用の report 候補を一つ保持します。候補には `sendCount`、
`runId`、`sourceKey`、event type / count、最大20件の安全な event 参照、自動 retry 回数、初回 send / retry 中に
`onToolCallStarted` callback を受け取ったかを記録します。tool 開始 callback の有無は Pi transcript から推測しません。
参照には failed dispatch 内の 1-based `eventIndex` を付け、同じ種別・参照の event も区別します。
参照の超過分は `eventReferencesTruncated` で示します。
認証 error の本文、shell command / path、operator 入力、worker の prompt / 結果、permission の raw
payload は載せません。event に共通の永続 ID はないため、`eventIndex` と参照はこの dispatch 内の照合用で、
元の task 本文を復元するものではありません。

operator が `/reconnect` を実行すると、agent を `close` して同じ ID で `resume` します。これは
prompt を送らない制御操作です。resume 成功時に候補があれば、一回限りの
`conductor.recovery.report` に変えます。次の通常 dispatch に report を先頭の文脈としてまとめ、
reconnect の await 中に届いた operator / worker input も同じ send に含めます。dispatch 可能な入力が
なければ report 単独を次の一回の send とします。元 event batch はどの場合も再投入しません。

report は send 開始時に消費し、二つ目の遅れた通知として戻しません。report を含む send も通常の
send 内自動 retry の対象です。tool が一度も始まらなければ同じ prompt を1回だけ retry しますが、
これは report event の再投入ではありません。tool が始まった場合は再送せず、send が失敗しても report の
別個の redelivery はしません。send に新しい実入力が含まれ、その最終結果も Pi resolver failure なら、
その実入力について新しい候補を作ります。これは元 report の再送ではありません。通常の auth hint /
send error から状態を確認し、新しい operator message で必要な続きを伝えてください。

候補は、手動 reconnect 前に別の通常 send が始まった時点で失効します。その send 自体が Pi resolver
failure なら、新しい send の候補に置き換えます。operator message と `/reconnect` が同時に queue に
ある場合は既存の優先順位で operator message を先に処理します。reconnect await 中の input は queue に
順序どおり残り、resume failure 時も捨てません。failure で今回の `/reconnect` は消費しますが、candidate は
成功するまで process 内に保持します。再接続中に重ねて queue された `/reconnect` は、成功時は同じ復旧操作
としてまとめ、失敗時は次の一度の resume 試行にまとめます。resume failure 後の旧 agent は closed /
unavailable として扱い、通常 input を dispatch せず、次の `/reconnect` を待ちます。failed resume 後の
再試行では、すでに close が完了した同じ handle を再度 close せず `resume(sameId)` を試します。
shutdown signal が reconnect await 中に立った場合、await 完了後に queue / report を dispatch せず終了します。
resume 自体は AbortSignal で中断できないため、その応答が返るまで driver の終了が遅れる可能性があります。

recovery report は dispatch hold を解除せず、hold 中に単独 send を起こしません。hold 中は既存規則で
送信できる operator message や `permission.stall` が選ばれた場合に限り、その束へ report を含めます。
`permission.pending` や通常の worker / GitHub event は hold の対象です。hold を解除した後は、
max-turns で待機中の held worker event が残っていても report 単独 send を許します。max-turns 到達後の
report 単独 send は有限の回復通知として許し、自律 turn 数は増減させません。report も通常の conductor
send なので model が tool を呼ぶ可能性はありますが、失敗 batch を実行する権限や再送指示を与えるものでは
ありません。batch に operator message が含まれる場合は既存どおり operator input が turn 数を reset します。
worker event は既存の max-turns 判定を受けます。

Pi は一つの send 中でも後続 model request の前に API key を再解決し、先行する tool round が動いた後に
resolver failure を返す場合があります。このため、初回 send / 自動 retry のどちらかで tool が始まれば
同一 prompt の自動再送を止めます。手動 recovery は失敗 batch を一切再送せず、report に
`toolCallStarted` を載せて conductor に現在の状態を確認させます。副作用や元の operator 意図を特定
できなければ、推測せず operator に確認します。transport error など resolver failure 以外の曖昧な失敗は
この report 候補にしません。

candidate / report と `SessionEventQueue` はメモリ上だけにあり、SessionResumeStore には保存しません。
`/close` または Ctrl+C で process を止めると queue と未送信 report は失われます。Pi transcript に元入力が
残っている保証も置きません。再開後は conductor / worker / worktree の現在の状態を確認し、未完了分を新しい
operator message で伝えてください。report の send が失敗した場合や shutdown 前に未送信の場合、conductor
への到達は保証しません。durable replay には stable event identity、atomic commit、tool 副作用の重複排除が
必要なため、別設計とします。

stall が続き、worktree を残したままプロセスを終了したい場合は `/close` の後に
`ensemble issue <same> --continue` で再開します。Ctrl+C も worktree を削除しませんが、
セッション結果は `interrupted` になります。`/exit` は isolated worktree の cleanup を
試みます。プロセスを維持して conductor だけ再接続する場合は `/reconnect` を使います。

### reconnect 経路の境界

| 経路 | 対象 | 再接続後 |
|------|------|----------|
| send 中の自動 reconnect | `ensemble issue` と `ensemble operator-agent` の通常 send | auth / transport error を受けた send の中で `resume(sameId)` します。tool が始まっていなければ同じ prompt を 1 回だけ再送し、始まっていれば再送せず元の error を返します |
| 手動 `/reconnect` | `ensemble issue` の `operator.reconnect` | コマンド自体は prompt を送りません。Pi resolver failure の最終失敗候補があれば、成功後の次の dispatch に安全な one-shot report を含めます。失敗 batch 自体は再送しません |
| 手動 `/reconnect` | `ensemble operator-agent` の TTY command | operator-agent 自身の agent を `close` → `resume(sameId)` します。失敗した operator-agent prompt は再送しません |

手動 reconnect 後の report 送信も通常の send です。失敗した report は再投入せず、通常の error / auth
hint で operator に状況を返します。認証を直した後、新しい operator message で未完了の作業を伝えてください。

`ensemble issue` と `ensemble operator-agent` は自動 send retry の helper を共有しますが、
手動 reconnect の後処理は別です。operator-agent の `send_operator_message` は、明示的な tool
呼び出しで Issue session の UDS に新しい `operator.message` を送る経路です。どの reconnect
経路もこの tool を自動実行しません。

`conductor.transport.reconnect` は transport error 後の自動 reconnect と手動 `/reconnect` の
両方で使われます。イベント payload に発火元は含まれず、手動操作の `operator.reconnect` も
専用の SessionLogEvent としては記録されません。そのため `status=succeeded` の行だけでは
どちらの経路か、prompt が再送されたかは分かりません。Issue #650 のログ抜粋も発火元を
特定できる情報がなく、手動操作だったとは断定できません。

## 制限

| 経路 | 挙動 |
|------|------|
| TTY / 非 TTY | auth / transport error ごとに in-process `resume`。tool が始まっていないときだけ同一 prompt を 1 回再試行。TTY の `ensemble issue` 手動 `/reconnect` は Pi resolver failure の安全な report を一度だけ送り、失敗 batch は再送しない |
| `CURSOR_API_KEY` | 環境変数モードの挙動は変更しない（#58）。hint は key ローテーション案内 |
| Pi backend | 各 send の Pi 1.x `ModelRuntime.getAuth(provider)` で stored API key / OAuth token を解決する。期限切れ OAuth token は Pi の refresh 処理に委ね、失敗時は provider-specific hint を表示 |
| 起動時 `create` / `resume` auth 失敗 | スコープ外（別 Issue 候補） |
| worker `agent login` | スコープ外 |

## 関連

- #58 / PR #99 — 手動 `[auth]` ヒント
- [ADR 0011](adr/0011-session-sidecar-resume.md) — cross-process resume
