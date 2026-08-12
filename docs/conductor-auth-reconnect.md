# conductor send 経路の in-process 再接続

Issue #101 の設計メモ。利用者向け概要は [README.md](../README.md#conductor-send-の認証エラーと-in-process-再接続) を正本とする。

## 背景

`@cursor/sdk` の local agent は長時間アイドルや sleep/wakeup 後、短命 access token の失効により次の `agent.send()` が `UNAUTHENTICATED` 相当で失敗することがある。API key 自体は有効で、`Agent.resume(sameId)` ですぐ復旧する（[Cursor forum #163819](https://forum.cursor.com/t/idle-local-agent-grpc-connection-returns-error-not-logged-in-authenticationerror-instead-of-networkerror-after-15-minutes/163819)）。

agents-ensemble の conductor は長寿命 `ConductorAgent` 1 本を保持する。worker（ACP）は別プロセスで sidecar に `acpSessionId` を保存するため、conductor 接続だけが切れても worker は生存しうる。

## 採用方式

send が auth-like error のとき:

`close` → `ConductorAgent.resume(sameId)` → send 再試行（1 回）

まだ失敗する場合は PR #99 互換の `[auth]` ヒント（手動 `logout` → `login` → `--resume` / `--continue`）へフォールバックする。in-process での自動 `login` は行わない（オペレータ方針）。

**非採用**

- `agent.reload()` — filesystem config（hooks / MCP / subagents）の再読込のみ。gRPC / token の張り直しではない。
- `Agent.create()` — 新 `agentId` になり resume / sidecar モデルと不整合。

実装: `packages/core/src/conductor/conductor-send-reconnect.ts`（driver の全 send 経路から呼ぶ）。

## auth-like error の検知

1. 既存 `isConductorAuthError(message)` — 明示的な認証メッセージ
2. **保守的 bare heuristic** — `status: "error"` かつ `error.message` も `result` も空（SDK idle 後の既知症状）。明示的な非 auth `error.code` がある場合は除外。

誤検知リスク: 他の原因でも message 欠落の error になりうる。その場合は 1 回だけ resume+retry し、失敗すれば従来の `[auth]` ヒントへフォールバック。

## イベント

| イベント | タイミング |
|----------|------------|
| `conductor.auth.reconnect` | `resume(sameId)` 試行時 |
| `conductor.auth.recovery` | 自動再接続失敗後（PR #99 互換の `[auth]` hint） |

## 制限

| 経路 | 挙動 |
|------|------|
| TTY / 非 TTY | いずれも in-process `resume` + 1 回再試行のみ |
| `CURSOR_API_KEY` | 環境変数モードの挙動は変更しない（#58）。hint は key ローテーション案内 |
| 起動時 `create` / `resume` auth 失敗 | スコープ外（別 Issue 候補） |
| worker `agent login` | スコープ外 |

## 関連

- #58 / PR #99 — 手動 `[auth]` ヒント
- [ADR 0011](adr/0011-session-sidecar-resume.md) — cross-process resume
