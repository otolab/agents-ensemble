# ADR 0013: プロセスライフサイクルと自律ループ停止の分離

- Status: accepted
- Date: 2026-08-11

## Context

Issue #65。マージ完了・Issue 作業の一区切り（conductor `finished` + 待ち事項なし）後も、dogfooding ではオペレータが追加指示や状態確認をしたい。しかし現状は `shouldStopIssueLoop` が true になると `runConductorSession` が return し、CLI プロセスが終了 JSON を出して落ちる。

[ADR 0009](0009-conductor-session-event-queue.md) では「終了条件は harness が握る」とあるが、`shouldStopIssueLoop` が **自律ループ停止** と **プロセス終了** の両方に直結していた。

### 用語

| 用語 | 意味 |
|------|------|
| **自律ループ停止** | `shouldStopIssueLoop` が成立して自律的な連続処理を止めること。非 TTY / `--no-wait` では SessionDriver がイベント消費ループを抜け、TTY post-loop では Driver がイベント待機を継続する |
| **プロセス終了** | CLI harness が worker / conductor を片付け、終了 JSON を stdout に出し、プロセスが exit すること |
| **post-loop 待機** | 自律ループ停止相当の状態になった後、harness が `/exit` や外部イベントを待つフェーズ。TTY では SessionDriver がイベント消費を継続する |

### 制約

- 非 TTY / CI は従来どおり自律ループ停止後に自動終了（テスト・自動化の期待）
- 終了 JSON はプロセス終了時のみ stdout（[session-logging.md](../session-logging.md) 維持）
- worker bridge は conductor セッション存続中（post-loop 含む）維持

## Decision

### 1. `shouldStopIssueLoop` の意味を固定する

**自律ループ（SessionDriver）の停止判定のみ**。プロセス終了条件ではない。コメントと ADR で明示する。

### 2. post-loop 待機は harness の UX とし、SessionDriver はイベント消費を継続する

自律ループ停止後、`waitForOperatorExit: true` のとき:

1. worker / conductor / operator input binding は **維持**
2. `onPostLoopWait` と `session.post_loop_wait` で案内（CLI は stderr）
3. SessionDriver は `shouldStopIssueLoop` が成立してもイベント消費ループを抜けず、`SessionEventQueue` で次の dispatch を待つ。`operator.message`、worker / permission、GitHub 更新は自律中と同じ経路で処理する
4. `/exit`（または `exit`）は専用の終了 signal で Driver の待機を中断し、harness 終了へ進む

GitHub 更新（`issue.comment` / `pr.review` / `pr.review_comment` / `ci.completed`）の dispatch は max-turns と整合させる:

| 状態 | `github.update` |
|------|----------------|
| ターン残あり（`autonomousTurns < maxTurns`、または無制限） | conductor へ通常 dispatch。状況把握ターンとして 1 ターン消費 |
| max-turns 到達後 | enqueue のみ。`canDispatchConductorSend` により `operator.message` / `permission.pending` のみ dispatch 可 |

`waitForOperatorExit: false`（非 TTY / `--no-wait`）では、従来どおり `shouldStopIssueLoop` 成立時に Driver が戻り、自動終了する。

`waitForOperatorExit` のデフォルトは **API では false**（ライブラリ利用者が明示）。CLI TTY では **true**（`--no-wait` で無効化）。

### 3. 明示的終了手段

| 手段 | 動作 |
|------|------|
| `/exit` または `exit` | post-loop 待機中・自律ループ中とも専用の終了 signal で Driver を中断し、即終了へ進む |
| `Ctrl+C` / `SIGTERM` | 従来どおり `interrupted` で終了 |
| 非 TTY | `waitForOperatorExit` なし → 自律ループ停止後に自動終了 |

### 4. TTY 判定

#45 と同様、`isOperatorInputInteractive()`（TTY または `ENSEMBLE_OPERATOR_MESSAGE`）で interactive を判定。`ENSEMBLE_OPERATOR_MESSAGE` 単発注入は post-loop 待機なし（従来の 1 ショット動作）。

## Consequences

### 良い点

- 「作業完了」と「プロセス終了」が分離され、dogfooding で CLI が先に落ちない
- SessionDriver は TTY post-loop でも常駐し、追加指示・worker / permission・GitHub 更新を同じイベント経路で処理できる
- `github.update` の種別ごとの resume 条件を増やさず、dispatch policy と max-turns policy を一元化できる

### 悪い点・リスク

- post-loop 中も worker ACP プロセスが存続する（意図通りだがリソース消費）
- TUI (#54) の具体 UI は本 ADR のスコープ外

### フォロー

- #54: TUI での post-loop UX

## 関連

- [ADR 0009](0009-conductor-session-event-queue.md) — harness 主導の終了
- [architecture.md](../architecture.md) §5 — ConductorSession ループ
- [operator-input.md](../operator-input.md) — SessionView / `/exit`
- Issue #65, #45
