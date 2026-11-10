# conductor send 経路の in-process 再接続

> **正本:** conductor send の認証エラー時に行う in-process 再接続の設計。認証情報・トークンの解決は [settings.md](settings.md) と [config.md](config.md)、CLI の入口は [cli/README.md](cli/README.md) を参照します。

Issue #101 の設計メモ。

## 背景

`@cursor/sdk` の local agent は長時間アイドルや sleep/wakeup 後、短命 access token の失効により次の `agent.send()` が `UNAUTHENTICATED` 相当で失敗することがある。API key 自体は有効で、`Agent.resume(sameId)` ですぐ復旧する（[Cursor forum #163819](https://forum.cursor.com/t/idle-local-agent-grpc-connection-returns-error-not-logged-in-authenticationerror-instead-of-networkerror-after-15-minutes/163819)）。

agents-ensemble の conductor は長寿命 `ConductorAgent` 1 本を保持する。worker（ACP）は別プロセスで SessionResumeStore に `acpSessionId` を保存するため、conductor 接続だけが切れても worker は生存しうる。

## 採用方式

send が auth-like error のとき:

`close` → `ConductorAgentFactory.resume(sameId)` → send 再試行（1 回）

まだ失敗する場合は PR #99 互換の backend 固有 `[auth]` ヒントへフォールバックする。Cursor は手動 `logout` → `login`、Pi は `ensemble auth login --provider <provider>` または project/user auth の確認を案内し、project 層の OAuth credential は stale token を使わず user 層へ移すよう案内する。いずれも `--resume` / `--continue` で再試行する。in-process での自動 `login` は行わない（オペレータ方針）。

**非採用**

- `agent.reload()` — filesystem config（hooks / MCP / subagents）の再読込のみ。gRPC / token の張り直しではない。
- `Agent.create()` — 新 `agentId` になり resume / SessionResumeStore モデルと不整合。

実装: `packages/core/src/conductor/conductor-send-reconnect.ts`（driver の全 send 経路から呼ぶ）。

## auth-like error の検知

1. 既存 `isConductorAuthError(message)` — 明示的な認証メッセージ。Pi の API key 解決失敗 `API key auth failed for provider ...` も含む
2. backend の error code — Pi 1.2.0 の `ModelsError.code === "auth"` を adapter が `ConductorSendResult.error.code` に保持する
3. **保守的 bare heuristic** — `status: "error"` かつ `error.message` も `result` も空（SDK idle 後の既知症状）。明示的な非 auth `error.code` がある場合は除外。

誤検知リスク: 他の原因でも message 欠落の error になりうる。その場合は 1 回だけ resume+retry し、失敗すれば従来の `[auth]` ヒントへフォールバック。

Pi 1.2.0 は `apiKey.resolve()` の失敗を `ModelsError("auth", "API key auth failed for provider ...")` に包み、cause の詳細も message に含める。これは provider request 前の失敗です（[auth resolver](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/src/auth/resolve.ts#L947-L969)、[ModelsError](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/src/utils/models-error.ts#L219-L245)）。adapter は `auth` code を保持し、同じ send 内で同一 prompt を 1 回だけ再試行します。2 回目も失敗した場合は `conductor.auth.recovery` と provider 固有 hint を出します。

## イベント

| イベント | タイミング |
|----------|------------|
| `conductor.auth.reconnect` | `resume(sameId)` 試行時 |
| `conductor.auth.recovery` | 自動再接続失敗後（PR #99 互換の `[auth]` hint） |

## transport stall の自動・手動再接続

`Connection stalled repeatedly` など、明示的な connection / transport timeout 系の
`error.message` または `error.code` は auth と分けて transport error と判定する。send ごとに
1 回だけ `close` → `resume(sameId)` → 同じ prompt の再送を行う。再接続に失敗しても
元の error 結果を返し、`continueOnConductorError` が有効な対話セッションは継続する。

この経路では `conductor.transport.reconnect` を attempt / success / failure の各状態で
emit し、auth の `[auth]` recovery hint は表示しない。オペレータは `/reconnect`（または
`reconnect`）で同じ `resume(sameId)` を手動実行できる。手動操作は直近 send の完了後に
行います。`/reconnect` 自体は prompt を送信しません。

Pi の API key resolver failure（`error.code === "auth"` かつ
`API key auth failed for provider ...: Failed to resolve API key ...`）で send が終わった場合、
手動 resume の成功後に失敗した dispatch batch を再キューします。ただし、その send 中に
tool call が一度でも始まっていた場合は再キューしません。resolver failure は該当する provider
request より前に起きますが、Pi は同じ send の tool round ごとに API key を解決するため、
その前の round で tool が動いた可能性までは否定できないからです。transport error など処理結果が
曖昧な batch も再送しません。いずれも状態を確認してから新しい operator message で続行してください。
resume 自体は conductor agent の差し替えだけを行います。再キューされた batch は通常の dispatch として処理されます。

stall が続き、worktree を残したままプロセスを終了したい場合は `/close` の後に
`ensemble issue <same> --continue` で再開します。Ctrl+C も worktree を削除しませんが、
セッション結果は `interrupted` になります。`/exit` は isolated worktree の cleanup を
試みます。プロセスを維持して conductor だけ再接続する場合は `/reconnect` を使います。

### reconnect 経路の境界

| 経路 | 対象 | 再接続後 |
|------|------|----------|
| send 中の自動 reconnect | `ensemble issue` と `ensemble operator-agent` の通常 send | auth / transport error を受けた send の中で `resume(sameId)` し、同じ prompt を 1 回だけ再送します。resume 失敗または再送失敗は通常の send error として呼び出し元へ返します |
| 手動 `/reconnect` | `ensemble issue` の `operator.reconnect` | コマンド自体は prompt を送りません。成功後、Pi の API key resolver failure で終わり、初回 send と自動 retry のどちらでも tool call が始まっていない batch に限り、driver がその event を session 中 1 回だけ再キューします |
| 手動 `/reconnect` | `ensemble operator-agent` の TTY command | operator-agent 自身の agent を `close` → `resume(sameId)` します。失敗した operator-agent prompt は再送しません |

手動再キュー後の send も失敗した場合、同じ event は再びキューへ戻しません。現在の状態を確認し、
必要なら認証を直した後、新しい operator message で未完了の作業を伝えてください。

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
| TTY / 非 TTY | auth / transport error ごとに in-process `resume` + 1 回再試行。TTY の手動 `/reconnect` は、tool call が始まる前に Pi の API key resolver failure で終わった batch を再キュー |
| `CURSOR_API_KEY` | 環境変数モードの挙動は変更しない（#58）。hint は key ローテーション案内 |
| Pi backend | 各 send の Pi 1.x `ModelRuntime.getAuth(provider)` で stored API key / OAuth token を解決する。期限切れ OAuth token は Pi の refresh 処理に委ね、失敗時は provider-specific hint を表示 |
| 起動時 `create` / `resume` auth 失敗 | スコープ外（別 Issue 候補） |
| worker `agent login` | スコープ外 |

## 関連

- #58 / PR #99 — 手動 `[auth]` ヒント
- [ADR 0011](adr/0011-session-sidecar-resume.md) — cross-process resume
