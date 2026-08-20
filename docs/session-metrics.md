# セッションメトリクス

`ensemble issue` セッションで harness が収集・照会できる **統計・状態の正本一覧**。[#172](https://github.com/otolab/agents-ensemble/issues/172)（終了サマリ）・[#173](https://github.com/otolab/agents-ensemble/issues/173)（TUI テンプレート）・オペレータ向けツールが同じ語彙を参照する。

**関連文書**

| 文書 | 内容 |
|------|------|
| [session-logging.md](session-logging.md) | 出力チャネル・SessionLogger・終了 JSON の役割 |
| [harness-events.md](harness-events.md) | SessionLogEvent / SessionEvent・exit JSON との対応 |
| [architecture.md](architecture.md) | `SessionUsageTracker`・`get_session_usage` の配線 |

**型の正本**

| 領域 | パス |
|------|------|
| 終了レポート | `ConductorSessionResult`（`packages/core/src/conductor/conductor-session.ts`） |
| CLI 終了 JSON | `formatIssueSessionSummaryJson`（`packages/cli/src/format-session-summary.ts`） |
| LLM usage 集計 | `SessionUsageSummary`（`packages/core/src/usage/types.ts`） |
| worker harness 状態 | `WorkerSessionStatusSummary`（`packages/core/src/runtime/worker-status.ts`） |
| SDK 課金 | `AgentUsage` / `UsageCost`（`@cursor/sdk` `usage-types`） |

---

## 1. 出力先の読み方

表の **出力先** 列は次の略称を使う。

| 略称 | 意味 |
|------|------|
| **TTY テキスト** | セッション終了時の人間向けサマリ（`formatIssueSessionSummaryText` → **stderr**。`--summary-format auto` で TTY 時に選択） |
| **終了 JSON** | プロセス終了時 **stdout** の JSON（非 TTY / `--summary-format auto` 既定。`formatIssueSessionSummaryJson`） |
| **`get_session_usage`** | conductor ツール（YAML 返却。`SessionUsageTracker.getSessionSummary()` と同型） |
| **`get_usage`** | conductor ツール（YAML。直近 1 ラウンド） |
| **`list_workers`** | conductor ツール（YAML。セッション worker 状態サマリ） |
| **`get_worker_status`** | conductor ツール（YAML。単一 worker 詳細） |
| **活動ログ** | TTY Ink Orchestration ペイン（`[harness]` / `[observation]` 等） |
| **sidecar** | `{repoRoot}/.ensemble/sessions/{agentId}.json`（resume 正本。exit report ではない） |

**未取得時** 列: フィールド省略・`null`・エラー・推定のいずれか。終了 JSON と `get_session_usage` の cost / tokens は **同一マージ経路**（`enrichSessionUsageWithCost`）で一致させる。

---

## 2. 終了レポート（`ConductorSessionResult`）

`SessionLogger.snapshot()` → `runConductorSession` の戻り値。CLI（`writeIssueSessionSummary`）は `--summary-format` に従い整形する。

| `--summary-format` | TTY | 非 TTY |
|--------------------|-----|--------|
| `auto`（既定） | テキスト → **stderr** | JSON → **stdout** |
| `text` | テキスト → stderr | テキスト → stderr |
| `json` | JSON → stdout | JSON → stdout |

### 2.1 識別・セッション結果

| フィールド | 型 | ソース | 出力先 | 未取得時 |
|-----------|-----|--------|--------|----------|
| `agentId` | `string` | SDK `ConductorAgent` | 終了 JSON・TTY テキスト（resume 用） | なし（常に設定） |
| `issueUrl` | `string` | セッション開始引数 | 終了 JSON | なし |
| `repoRoot` | `string` | worktree 解決後 | 終了 JSON | なし |
| `stopReason` | `IssueLoopStopReason` | `session.stop`（`completed` / `error` / `max_turns` / `interrupted`） | 終了 JSON・TTY テキスト | なし |
| `sendCount` | `number` | `conductor.send` 完了回数 | 終了 JSON・TTY テキスト・活動ログ（イベント本文） | `0` |
| `lastRunStatus` | `string` | 直近 `conductor.send` の SDK status | 終了 JSON | 最終 send 無し時は `'finished'` |
| `lastResult` | `string?` | 直近 `conductor.send` の応答末尾 | 終了 JSON | 省略 |
| `lastError` | `{ message, code? }?` | 直近 `conductor.send` 失敗 | 終了 JSON | 省略 |

### 2.2 worker ラウンド・失敗

| フィールド | 型 | ソース | 出力先 | 未取得時 |
|-----------|-----|--------|--------|----------|
| `workerDispatches` | `WorkerDispatchResult[]` | 各 `worker.round` | 終了 JSON 内 `workerResponses`（CLI 整形） | `[]` |
| `workerFailures` | `WorkerFailureRecord[]` | 各 `worker.failed` | 終了 JSON の `workerFailureCount` のみ（配列本体は CLI 未出力） | `[]` |
| `workerDispatchCount` | `number` | `workerDispatches.length`（CLI 導出） | 終了 JSON・TTY テキスト | `0` |
| `workerFailureCount` | `number` | `workerFailures.length`（CLI 導出） | 終了 JSON・TTY テキスト | `0` |

`WorkerDispatchResult` の主フィールド（終了 JSON `workerResponses` 要素）:

| フィールド | 型 | ソース | 終了 JSON | 未取得時 |
|-----------|-----|--------|-----------|----------|
| `name` | `string` | profile worker 名 | ○ | — |
| `kind` | `string` | profile kind | ○ | — |
| `source` | `'harness' \| 'conductor'` | init / instruction 区別 | ○ | 既定 `'conductor'` |
| `stopReason` | `string` | ACP `session/prompt` | ○ | — |
| `responseText` | `string?` | ACP 応答全文 | `--include-full-response-text` 時のみ | 省略 |
| `responsePreview` | `string?` | `responseText` 先頭 N 文字（既定 240） | ○（既定） | 省略 |

### 2.3 オペレータ対話・エスカレーション

| フィールド | 型 | ソース | 出力先 | 未取得時 |
|-----------|-----|--------|--------|----------|
| `escalations` | `EscalationRecord[]` | `escalation.recorded` 蓄積 | 終了 JSON の `escalationCount` のみ | `[]` |
| `openQuestions` | `OpenQuestion[]` | `OpenQuestionRegistry` 終了スナップショット | 終了 JSON の `openQuestionCount` のみ | `[]` |
| `escalationCount` | `number` | CLI 導出 | 終了 JSON・TTY テキスト | `0` |
| `openQuestionCount` | `number` | CLI 導出（未回答は別途フィルタ可） | 終了 JSON・TTY テキスト | `0` |

### 2.4 セッション時間（#172 候補・未実装）

| フィールド | 型 | ソース | 出力先 | 未取得時 |
|-----------|-----|--------|--------|----------|
| `startedAt` | `number?`（Unix ms） | セッション開始時刻（**未配線**） | 終了 JSON・TTY テキスト（案） | 省略 |
| `endedAt` | `number?` | 終了時刻（**未配線**） | 同上 | 省略 |
| `durationMs` | `number?` | `endedAt - startedAt`（**未配線**） | 同上 | 省略 |

---

## 3. LLM usage（`SessionUsageTracker`）

正本: `packages/core/src/usage/session-usage-tracker.ts`。conductor 各 `agent.send` は SDK `RunResult.usage`、worker 各 prompt は ACP `usage` または **推定**（`estimateTokenUsageFromText`）。

### 3.1 セッションサマリ（`SessionUsageSummary`）

`get_session_usage` と `ConductorSessionResult.sessionUsage` は **同一形状**（`enrichSessionUsageWithCost` 適用後）。`buildResult` では **`totals.rounds > 0` または `cost != null` のときのみ** `sessionUsage` を載せる（それ以外はフィールド自体を省略）。

| フィールド | 型 | ソース | 出力先 | 未取得時 |
|-----------|-----|--------|--------|----------|
| `totals.rounds` | `number` | 記録ラウンド総数 | `get_session_usage`・終了 JSON | `0` |
| `totals.roundsWithUsage` | `number` | `usage != null` のラウンド数 | 同上 | `0` |
| `totals.tokens` | `LlmTokenCounts \| null` | 全ラウンド合算 | 同上・TTY テキスト | `null` |
| `byAgent.conductor` | `SessionUsageAgentTotals` | conductor ラウンドのみ | 同上 | rounds `0`, tokens `null` |
| `byAgent.workers` | `Record<string, SessionUsageAgentTotals>` | worker 名別 | 同上 | `{}` |
| `context` | `SessionContextUtilization` | 下表 | 同上・TTY（limit 既知時） | 下表 |
| `latestRound` | `SessionUsageRound \| null` | 最終ラウンド | `get_session_usage` のみ（終了 JSON には含めない案） | `null` |

`LlmTokenCounts`（合算・1 ラウンド共通）:

| フィールド | 型 | ソース | 備考 |
|-----------|-----|--------|------|
| `inputTokens` | `number` | SDK / ACP / 推定 | 常に存在 |
| `outputTokens` | `number` | 同上 | 常に存在 |
| `totalTokens` | `number` | 同上 | 常に存在 |
| `reasoningTokens` | `number?` | いずれかのラウンドにあれば合算に含める | 全ラウンド欠如時は省略 |
| `cacheReadTokens` | `number?` | 同上 | 同上 |
| `cacheWriteTokens` | `number?` | 同上 | 同上 |

`SessionContextUtilization`:

| フィールド | 型 | ソース | 未取得時 |
|-----------|-----|--------|----------|
| `limit` | `number \| null` | `RunConductorSessionOptions.contextLimitTokens`（テスト・将来 SDK） | `null` + `limitUnavailableReason` |
| `usedInputTokens` | `number` | 全ラウンド `inputTokens` 累計 | 常に数値（`0` 可） |
| `percent` | `number \| null` | `usedInputTokens / limit`（上限既知時のみ） | `null` |
| `limitUnavailableReason` | `string?` | SDK 1.0.27 に context limit API 無し | limit 指定時は省略 |

### 3.2 ラウンド詳細（`SessionUsageRound`）

| フィールド | 型 | ソース | 出力先 | 未取得時 |
|-----------|-----|--------|--------|----------|
| `roundId` | `string` | harness 採番 | `get_usage` | — |
| `agentKind` | `'conductor' \| 'worker'` | 記録経路 | `get_usage` | — |
| `agentName` | `string?` | worker 名 | `get_usage` | conductor は省略 |
| `workerKind` | `string?` | profile kind | `get_usage` | 省略可 |
| `source` | `'harness' \| 'conductor'?` | worker prompt 由来 | `get_usage` | 省略 |
| `runId` | `string?` | SDK run ID（conductor のみ） | `get_usage` | 省略 |
| `modelId` | `string?` | SDK（conductor のみ） | `get_usage` | 省略 |
| `stopReason` | `string?` | send status / ACP stopReason | `get_usage` | 省略 |
| `usage` | `LlmUsageRecord \| null` | 下表 | `get_usage` | `null` |
| `recordedAt` | `number` | `Date.now()` | `get_usage` | — |

`LlmUsageRecord` = `LlmTokenCounts` + `source`:

| `source` | 意味 | いつ |
|----------|------|------|
| `sdk` | `@cursor/sdk` `TokenUsage` | conductor `agent.send` で usage 報告あり |
| `acp` | ACP `session/prompt` の `usage` | worker で ACP が usage を返した |
| `estimated` | `estimateTokenUsageFromText` | worker で ACP usage 無し |

### 3.3 課金コスト（SDK）

`ConductorAgent.getUsage()` → `AgentUsage.cost`。終了時と `get_session_usage` は `enrichSessionUsageWithCost` でマージ。

| フィールド | 型 | ソース | 出力先 | 未取得時 |
|-----------|-----|--------|--------|----------|
| `cost.rawCostCents` | `number` | `AgentUsage.cost`（セッション累計） | `sessionUsage.cost`・TTY テキスト | **フィールド省略**（エラーにしない） |
| `cost.chargedCents` | `number` | 同上（割引・Cursor Token Fee 込み実課金） | 同上 | 同上 |
| `runs[].cost` | `UsageCost?` | run 単位（`getUsage({ runId })`） | `get_usage` 拡張候補 | 省略 |

**注意**

- `RunResult.usage` / per-round tracker は **トークンのみ**。cost は `getUsage()` のみ。
- billing 反映 lag のため **run 終了直後は cost が無い**ことがある（SDK 型コメント）。
- worker ACP は現状 cost 無し。将来 `LlmUsageSnapshot` 拡張で tracker に載せる想定（[#172 コメント](https://github.com/otolab/agents-ensemble/issues/172#issuecomment)）。

---

## 4. Harness worker 状態（runtime）

正本: `WorkerRuntime` + `list_workers` / `get_worker_status`（`packages/core/src/dispatch/worker-status-tool.ts`）。**終了 JSON には現状載らない**（[#173](https://github.com/otolab/agents-ensemble/issues/173) テンプレートパラメータとして参照）。

### 4.1 セッション集計（`WorkerSessionStatusSummary`）

| フィールド | 型 | ソース | 出力先 | 未取得時 |
|-----------|-----|--------|--------|----------|
| `runningCount` | `number` | lifecycle `processing` 相当 | `list_workers` | `0` |
| `attachedCount` | `number` | ACP 接続済み worker | `list_workers` | `0` |
| `attachInFlight` | `number` | attach 中 | `list_workers` | `0` |
| `workerFailureCount` | `number` | 失敗 worker | `list_workers` | `0` |
| `workers` | `WorkerStatusSummary[]` | 各 worker 状態 | `list_workers` | `[]` |

### 4.2 単一 worker（`WorkerStatusSummary` / `WorkerStatusDetail`）

| フィールド | 型 | ソース | `list_workers` | `get_worker_status` | 未取得時 |
|-----------|-----|--------|----------------|---------------------|----------|
| `name` | `string` | profile | ○ | ○ | — |
| `kind` | `string` | profile | ○ | ○ | — |
| `state` | `WorkerLifecycleState` | harness FSM | ○ | ○ | — |
| `queueDepth` | `number` | 待ち prompt 数 | ○ | ○ | `0` |
| `worktreePath` | `string?` | Issue worktree | ○ | ○ | 省略 |
| `workspacePath` | `string?` | ACP cwd | ○ | ○ | 省略 |
| `acpSessionId` | `string?` | ACP セッション | ○ | ○ | 省略 |
| `error` | `string?` | attach 失敗 | ○ | ○ | 省略 |
| `queuePreview` | `string[]` | キュー先頭 | — | ○ | `[]` |
| `preemptPending` | `boolean` | プリエンプト待ち | — | ○ | `false` |
| `cancelInFlight` | `boolean` | キャンセル中 | — | ○ | `false` |
| `lastFailure.error` | `string?` | `workerFailures` から結合 | — | ○ | 省略 |

TUI 表示語彙 `WorkerDisplayStatus`（`idle` / `running` / `failed`）は **別層**。reducer が lifecycle から導出（[harness-events.md §6](harness-events.md)）。

---

## 5. セッションポリシー・自律ループ（driver 内部）

| 名前 | 型 | ソース | 終了 JSON | ツール / TTY | 備考 |
|------|-----|--------|-----------|--------------|------|
| `autonomousTurns` | `number` | `ConductorSessionDriver` | **未出力** | `SessionView`（TTY 入力バインド） | オペレータ入力でリセット |
| `maxTurns` | `number` | `resolveMaxTurns(options.maxTurns)` | **未出力** | `SessionView`（`null` = 無制限） | `<= 0` は無制限 |
| `DEFAULT_MAX_ISSUE_TURNS` | `5` | `session-policy.ts` | — | — | CLI 未指定時の既定 |

`stopReason: 'max_turns'` は終了 JSON に載るが、**`autonomousTurns` / `maxTurns` の数値自体は exit report に含まれない**（[#172 非スコープ](https://github.com/otolab/agents-ensemble/issues/172) 案: harness 未配線のため先送り。配線するなら別フィールド設計）。

---

## 6. GitHub 監視

| 名前 | 型 | ソース | 終了 JSON | 活動ログ / イベント | 備考 |
|------|-----|--------|-----------|---------------------|------|
| `harness.github.update` | `itemCount: number` | poll 差分件数 | **未集計** | SessionEvent・活動ログ | セッション累計カウンタ **無し** |
| `harness.github.monitor_error` | `message: string`, `phase?`, `prNumber?`, `cause?`, `retryable?` | API 失敗（フェーズ単位） | **未集計** | 同上 | stderr は `message` のみ 1 行（後方互換） |
| `githubMonitor` cursor | `GitHubMonitorCursor` | sidecar のみ | — | — | exit report 対象外 |

終了サマリへの「GitHub 監視 N 件」は **現状取れない**。必要なら tracker 追加が別 Issue。

---

## 7. sidecar（resume・メトリクス正本ではない）

| フィールド | 用途 | exit JSON との関係 |
|-----------|------|-------------------|
| `conductorAgentId` | resume キー | 終了 JSON `agentId` と同値コピー |
| `openQuestions` | 未回答の正本 | 終了 JSON はスナップショット件数のみ |
| `workers.*.acpSessionId` | worker 再開 | 終了 JSON には載せない |
| `githubMonitor` | poll カーソル | 終了 JSON には載せない |
| `sequence` / `updatedAt` | flush 順序 | 終了 JSON には載せない |

---

## 8. #172 実装対応（完了）

| 変更 | メトリクス節 |
|------|-------------|
| 終了 JSON に `sessionUsage` 追加 | §3.1（`get_session_usage` と一致） |
| `responseText` → `responsePreview` | §2.2 |
| TTY `formatIssueSessionSummaryText` | §1, §2.1–2.3, §3.1 tokens, §3.3 cost |
| `getUsage().cost` マージ | §3.3 |
| `--summary-format` / `--include-full-response-text` | §2 冒頭表 |
| `startedAt` / `durationMs` | §2.4（**未実装**） |

---

## 9. 関連コード

| パス | 内容 |
|------|------|
| `packages/core/src/usage/session-usage-tracker.ts` | ラウンド記録・`getSessionSummary()` |
| `packages/core/src/dispatch/session-usage-tool.ts` | `get_session_usage` / `get_usage` |
| `packages/core/src/dispatch/worker-status-tool.ts` | `list_workers` / `get_worker_status` |
| `packages/core/src/conductor/conductor-session.ts` | `sessionUsage` を `buildResult` に載せる |
| `packages/core/src/conductor/session/session-logger.ts` | exit report 蓄積 |
| `packages/cli/src/format-session-summary.ts` | 終了 JSON / テキスト整形 |
| `packages/cli/src/write-issue-session-summary.ts` | stdout / stderr への書き込み |
