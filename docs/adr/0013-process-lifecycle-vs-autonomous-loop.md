# ADR 0013: プロセスライフサイクルと自律ループ停止の分離

- Status: accepted
- Date: 2026-08-11

## Context

Issue #65。マージ完了・Issue 作業の一区切り（conductor `finished` + 待ち事項なし）後も、dogfooding ではオペレータが追加指示や状態確認をしたい。しかし現状は `shouldStopIssueLoop` が true になると `runConductorSession` が return し、CLI プロセスが終了 JSON を出して落ちる。

[ADR 0009](0009-conductor-session-event-queue.md) では「終了条件は harness が握る」とあるが、`shouldStopIssueLoop` が **自律ループ停止** と **プロセス終了** の両方に直結していた。

### 用語

| 用語 | 意味 |
|------|------|
| **自律ループ停止** | SessionDriver が `shouldStopIssueLoop` でイベント消費ループを抜けること。作業報告の一区切り |
| **プロセス終了** | CLI harness が worker / conductor を片付け、終了 JSON を stdout に出し、プロセスが exit すること |
| **post-loop 待機** | 自律ループ停止後、harness がオペレータの `/exit`、TTY 追加入力、または Issue コメント（条件付き）を待つフェーズ |

### 制約

- 非 TTY / CI は従来どおり自律ループ停止後に自動終了（テスト・自動化の期待）
- 終了 JSON はプロセス終了時のみ stdout（[session-logging.md](../session-logging.md) 維持）
- worker bridge は conductor セッション存続中（post-loop 含む）維持

## Decision

### 1. `shouldStopIssueLoop` の意味を固定する

**自律ループ（SessionDriver）の停止判定のみ**。プロセス終了条件ではない。コメントと ADR で明示する。

### 2. post-loop 待機は harness（`runConductorSession`）が担う

自律ループ停止後、`waitForOperatorExit: true` のとき:

1. worker / conductor / operator input binding は **維持**
2. `onPostLoopWait` で案内（CLI は stderr）
3. `OperatorPostLoopGate` で次を待つ:
   - `/exit`（または `exit`）→ harness 終了へ
   - 追加 `operator.message`（TTY `operator>` 等）→ **無条件** `notifyResume` → SessionDriver 再実行
   - `issue.comment` を含む `github.update`（GitHub 監視）→ **`autonomousTurns < maxTurns`（または無制限）のときのみ** `notifyResume` → SessionDriver 再実行（#160）。max-turns 到達時は `enqueue` のみで停止維持（ターン回復しない）
4. 再実行時はイベントキューに積まれた `operator.message` または `github.update` を処理

`waitForOperatorExit` のデフォルトは **API では false**（ライブラリ利用者が明示）。CLI TTY では **true**（`--no-wait` で無効化）。

### 3. 明示的終了手段

| 手段 | 動作 |
|------|------|
| `/exit` または `exit` | post-loop 待機中は即終了。自律ループ中は `shutdownSignal` を abort |
| `Ctrl+C` / `SIGTERM` | 従来どおり `interrupted` で終了 |
| 非 TTY | `waitForOperatorExit` なし → 自律ループ停止後に自動終了 |

### 4. TTY 判定

#45 と同様、`isOperatorInputInteractive()`（TTY または `ENSEMBLE_OPERATOR_MESSAGE`）で interactive を判定。`ENSEMBLE_OPERATOR_MESSAGE` 単発注入は post-loop 待機なし（従来の 1 ショット動作）。

## Consequences

### 良い点

- 「作業完了」と「プロセス終了」が分離され、dogfooding で CLI が先に落ちない
- SessionDriver / SessionPolicy は変更最小（外側ループのみ）
- 追加指示で自律ループを再開できる

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
