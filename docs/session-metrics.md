# セッションメトリクス

> **正本:** `ensemble issue` の終了サマリ、usage、worker 状態などのメトリクス項目。出力チャネルは [session-logging.md](session-logging.md)、イベント型は [harness-events.md](harness-events.md) を参照します。

`ensemble issue` セッションで harness が収集・照会できる **統計・状態の正本一覧**。終了サマリ・TUI テンプレート・オペレータ向けツールが同じ語彙を参照する。

**関連文書**

| 文書 | 内容 |
|------|------|
| [session-logging.md](session-logging.md) | 出力チャネル・SessionLogger・終了 JSON の役割 |
| [harness-events.md](harness-events.md) | SessionLogEvent / SessionEvent・exit JSON との対応 |
| [architecture.md](architecture.md) | `SessionUsageTracker`・`get_session_usage` の配線 |
| [token-usage-semantics.md](token-usage-semantics.md) | LLM usage の source 別の意味、課金との違い、harness 集計の注意 |

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
| **sidecar** | `{repoRoot}/.ensemble/sessions/{agentId}.json`（resume 用 harness 状態。exit report ではない） |
| **open question YAML** | `{repoRoot}/.ensemble/sessions/{agentId}/open-questions.yaml`（Registry の正本。sidecar との移行仕様は [session-logging.md](session-logging.md#4-sidecar-と-open-question-yaml)） |

**未取得時** 列: フィールド省略・`null`・エラー・推定のいずれか。終了 JSON と `get_session_usage` の tokens / cache stats / compaction count は同じ `SessionUsageTracker` のスナップショットを使い、conductor cost は同一の `enrichSessionUsageWithCost` 経路で揃える。

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
| `startedAt` | `number` | `SessionLogger` 生成時の `Date.now()`（Unix epoch ms） | 終了 JSON | なし |
| `durationMs` | `number` | 終了 snapshot 生成時の `Date.now() - startedAt` | 終了 JSON・TTY テキスト | なし。snapshot 以後の teardown は含まない |
| `stopReason` | `IssueLoopStopReason` | `session.stop`（`completed` / `error` / `cancelled` / `max_turns` / `interrupted`） | 終了 JSON・TTY テキスト | なし |
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

---

### 2.4 TTY 終了サマリ例

`sessionUsage` があるときは、取得・記録できた usage の input / output tokens を表示する。合計には worker の成功応答から推定した値が含まれる場合があり、失敗などで usage round が残らなかった消費分は含まれない。cache rate と cost / compaction は取得できる項目だけ表示する。

```text
セッション終了 (completed)
  経過時間: 2分15秒
  conductor ターン: 3
  worker ラウンド: 3 完了 / 0 失敗
  トークン（取得・記録済み usage）:
    取得・記録済み合計: input 3k / output 920
    conductor: input 2k / output 600
    worker implementer: input 500 / output 120
    worker reviewer: input 300 / output 200
    worker は ACP が usage を返さないラウンドで応答文からの推定値を含む場合があります。
  キャッシュヒット率: 全体 21.7% (read 500, write 20) / conductor 20% (read 400, write 20) / worker implementer 33.3% (read 100, write 0)
  コンテキスト: 1% (100,000 上限)
  課金（取得できた conductor 実課金。worker 分は未算出）: $0.42 (raw $0.51)
  コンテキスト圧縮: 2 回
  未回答 open question: 0
  agentId: agent-1
```

cost 行は conductor から取得できた実課金だけを示す。worker が成功して token usage が記録された場合も、失敗して usage が残らなかった場合も、worker cost は取得できないため、セッション全体の金額として conductor cost を表示しない。cost 未取得時は行を省略する。

worker がモデル要求後に切断され、token usage が記録されない場合の表示例:

```text
セッション終了 (completed)
  conductor ターン: 1
  worker ラウンド: 0 完了 / 1 失敗
  トークン（取得・記録済み usage）:
    取得・記録済み合計: input 1k / output 100
    conductor: input 1k / output 100
    失敗などで usage が未記録の消費分は含まれません。
  課金（取得できた conductor 実課金。worker 分は未算出）: $0.42 (raw $0.51)
  未回答 open question: 0
  agentId: agent-1
```

## 3. LLM usage（`SessionUsageTracker`）

正本: `packages/core/src/usage/session-usage-tracker.ts`。conductor 各 `agent.send` は SDK `RunResult.usage`、worker 各 prompt は ACP `usage` または **推定**（`estimateTokenUsageFromText`）。

input / output / cache の source ごとの意味、provider 課金との違い、cache rate と context utilization の読み方は [token-usage-semantics.md](token-usage-semantics.md) を参照してください。

### 3.1 セッションサマリ（`SessionUsageSummary`）

`get_session_usage` と `ConductorSessionResult.sessionUsage` は **同一形状**（`enrichSessionUsageWithCost` 適用後）。`buildResult` では usage round、cost、または信頼できる compaction counter があるときだけ `sessionUsage` を載せる（それ以外はフィールド自体を省略）。

| フィールド | 型 | ソース | 出力先 | 未取得時 |
|-----------|-----|--------|--------|----------|
| `tokenScope` | `SessionUsageTokenScope?` | tracker 固定値 `recorded-usage-only` | 終了 JSON・`get_session_usage` YAML / structured content・TTY 表示 | tracker の実出力では常に存在。利用側が構築する既存 summary では省略可 |
| `totals.rounds` | `number` | 記録ラウンド総数 | `get_session_usage`・終了 JSON | `0` |
| `totals.roundsWithUsage` | `number` | `usage != null` のラウンド数 | 同上 | `0` |
| `totals.tokens` | `LlmTokenCounts \| null` | usage が記録されたラウンドの合算 | 同上・TTY テキスト | `null` |
| `byAgent.conductor` | `SessionUsageAgentTotals` | conductor ラウンドのみ | 同上 | rounds `0`, tokens `null` |
| `byAgent.workers` | `Record<string, SessionUsageAgentTotals>` | worker 名別 | 同上 | `{}` |
| `context` | `SessionContextUtilization` | 下表 | 同上・TTY（limit 既知時） | 下表 |
| `cacheStats` | `SessionUsageCacheSummary?` | cache counters を報告した round から算出 | 同上・TTY（rate が算出可能な scope のみ） | 全 round で cache fields が無ければ省略 |
| `compactionCount` | `number?` | 下記の backend 固有イベント | 同上・TTY | 信頼できる counter が無い backend では省略。Pi では `0` も counter 利用可能を表す値として返す |
| `cost` | `SessionUsageCost?` | conductor が報告した実課金。`scope: 'conductor-only'` | 同上・TTY・`get_session_usage` | 未取得時は省略 |
| `latestRound` | `SessionUsageRound \| null` | 最終ラウンド | `get_session_usage`・終了 JSON | `null` |

`tokenScope: 'recorded-usage-only'` は合計が実際の全消費量を保証せず、usage を取得・記録できたラウンドだけを集計することを示す。worker が正常に完了して ACP usage を返さない場合は応答文からの推定 usage が含まれる一方、usage round が残らない失敗 worker の消費分は含まれない。`totals` と `byAgent` は同じ scope に従う。

`SessionUsageSummary` の `tokenScope` と cost の `scope` は、以前の object literal を構築する TypeScript 利用者との互換性のため公開型では optional とする。`SessionUsageTracker` は `tokenScope` を、`enrichSessionUsageWithCost` は cost がある場合の `scope: 'conductor-only'` を、いずれも runtime 出力に常に含める。

`LlmTokenCounts`（合算・1 ラウンド共通）:

| フィールド | 型 | ソース | 備考 |
|-----------|-----|--------|------|
| `inputTokens` | `number` | SDK / ACP / 推定 | 常に存在 |
| `outputTokens` | `number` | 同上 | 常に存在 |
| `totalTokens` | `number` | 同上 | 常に存在 |
| `reasoningTokens` | `number?` | いずれかのラウンドにあれば合算に含める | 全ラウンド欠如時は省略 |
| `cacheReadTokens` | `number?` | 同上 | 同上 |
| `cacheWriteTokens` | `number?` | 同上 | 同上 |

`cacheStats` は全体・conductor・worker 名別に、cache counters を得られた round の値を集約する。cache hit rate の定義は次のとおり。

```text
sum(cacheReadTokens) / sum(inputTokens + cacheReadTokens)
```

この合計は `cacheReadTokens` が報告された round に限る。`inputTokens` は同じ round の値を使い、cache counter が無い round の input は分母に含めない。分母が 0 の scope では `cacheHitRate` を省略する。全 round で cache fields が無い場合は `cacheStats` 自体を省略し、0% と扱わない。`cacheWriteTokens` は報告された round のみを加算し、hit rate の式には含めない。比率は `0..1` の値で JSON / YAML に載り、TTY は百分率で表示する。

集計 token 数は SDK / ACP の usage と応答文から推定した worker usage が混在することがある。worker の ACP usage が無いラウンドでは `estimateTokenUsageFromText` の値を使う。

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

### 3.3 Conductor 課金コスト

`ConductorAgent.getUsage()` → `cost`。終了時と `get_session_usage` は `enrichSessionUsageWithCost` でマージ。

| フィールド | 型 | ソース | 出力先 | 未取得時 |
|-----------|-----|--------|--------|----------|
| `cost.scope` | `'conductor-only'?` | `enrichSessionUsageWithCost` が runtime で明示。worker cost を含まない | 終了 JSON・`get_session_usage`・TTY テキスト | cost ごと省略。公開型では後方互換のため optional |
| `cost.rawCostCents` | `number` | Cursor `AgentUsage.cost.rawCostCents` のセッション累計 | 同上 | **フィールド省略**（エラーにしない） |
| `cost.chargedCents` | `number` | Cursor `AgentUsage.cost.chargedCents`（割引・Cursor Token Fee 込み） | 同上 | 同上 |
| `runs[].cost` | `UsageCost?` | run 単位（`getUsage({ runId })`） | `get_usage` | 省略 |

Pi backend の `AssistantMessage.usage.cost` は `pi-ai` v1.2.0 の `calculateCost` が `model.cost` の token 単価と usage から算出する値で、provider の請求記録ではない（[Pi v1.2.0 `calculateCost`](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/src/models.ts#L1119-L1137)）。この値は `ConductorAgent.getUsage()` / `enrichSessionUsageWithCost` に渡さず、`sessionUsage.cost`・`get_session_usage`・TTY に載せない。コスト欄は実課金を報告する backend 値がある場合だけ表示する。

worker cost は **表示しない（Issue #469 の方針 A）**。ACP の `PromptResult.usage` は token counts のみで、現行の worker usage record に model ID が無い。Pi の `models.json` にモデル単価を設定できる場合も、それを任意の ACP worker の provider / model に安全に対応付けられないため、単価を当てはめた推定は行わない。`sessionUsage.cost.scope` は常に `conductor-only` で、JSON / YAML 利用者にも cost が conductor 分だけであることを伝える。TTY も取得できた conductor 実課金を worker 分未算出と併記し、セッション全体の金額とは呼ばない。worker failure で usage round が残らない場合も同じ scope を保つ。

**注意**

- `RunResult.usage` / per-round tracker は **トークンのみ**。実課金 cost は backend が請求記録として報告する場合に限り `getUsage()` から取得する。モデル料金率による計算値は実課金 cost に含めない。
- billing 反映 lag のため **run 終了直後は cost が無い**ことがある（SDK 型コメント）。
- worker ACP は現状 cost 無し。

### 3.4 Context compaction 回数

Pi v1.2.0 の `AgentSessionEvent.compaction_end` は成功時に `result` を含み、失敗時は `result: undefined`、中断時は `aborted: true` を通知する（[event type](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/agent-session.ts#L207-L214)、[manual compaction](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/agent-session.ts#L2713-L2735)、[auto compaction](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/agent-session.ts#L3017-L3047)）。Pi conductor は `result` があり、中断・エラーでない `compaction_end` だけを数える。`entry_appended` は通常成功経路では発火しないため counter source に使わない。組み込み Pi backend は `compactionCount` を含め、成功イベントが無いセッションは `0` と表示する。Cursor SDK および差し替え backend factory はこのカウンタを提供しないため、フィールドと TTY 行を出さない。

---

## 4. Harness worker 状態（runtime）

正本: `WorkerRuntime` + `list_workers` / `get_worker_status`（`packages/core/src/dispatch/worker-status-tool.ts`）。**終了 JSON には載らない**（TUI テンプレートパラメータとして参照）。

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

TUI 表示語彙 `WorkerDisplayStatus`（`sleep` / `idle` / `running` / `failed`）は **別層**。runtime `sleeping` は未 attach、`idle` は attach 済みで prompt 待ち。reducer が lifecycle から導出（[harness-events.md §6](harness-events.md)）。

---

## 5. セッションポリシー・自律ループ（driver 内部）

| 名前 | 型 | ソース | 終了 JSON | ツール / TTY | 備考 |
|------|-----|--------|-----------|--------------|------|
| `autonomousTurns` | `number` | `ConductorSessionDriver` | **未出力** | `SessionView`（TTY 入力バインド） | オペレータ入力でリセット |
| `maxTurns` | `number` | `resolveMaxTurns(options.maxTurns)` | **未出力** | `SessionView`（`null` = 無制限） | `<= 0` は無制限 |
| `DEFAULT_MAX_ISSUE_TURNS` | `5` | `session-policy.ts` | — | — | CLI 未指定時の既定 |

`stopReason: 'max_turns'` は終了 JSON に載るが、**`autonomousTurns` / `maxTurns` の数値自体は exit report に含まれない**。

---

## 6. GitHub 監視

| 名前 | 型 | ソース | 終了 JSON | 活動ログ / イベント | 備考 |
|------|-----|--------|-----------|---------------------|------|
| `harness.github.update` | `itemCount: number` | poll 差分件数 | **未集計** | SessionEvent・活動ログ | セッション累計カウンタ **無し** |
| `harness.github.monitor_error` | `message: string`, `phase?`, `prNumber?`, `cause?`, `retryable?` | API 失敗（フェーズ単位） | **未集計** | 同上 | stderr は `message` のみ 1 行（後方互換） |
| `githubMonitor` cursor | `GitHubMonitorCursor` | sidecar のみ | — | — | exit report 対象外 |

終了サマリへの「GitHub 監視 N 件」は **現状取れない**（poll 差分はイベント単位のみ）。

---

## 7. resume 状態（メトリクス正本ではない）

| 保存先 / フィールド | 用途 | exit JSON との関係 |
|--------------------|------|-------------------|
| sidecar `conductorAgentId` | resume キー | 終了 JSON `agentId` と同値コピー |
| YAML `openQuestions` | Registry の正本 | 終了 JSON はスナップショット件数のみ |
| YAML `sequence` | 次の question ID を復元 | 終了 JSON には載せない |
| sidecar `openQuestions` / `sequence` | YAML 導入前後の互換コピー | 終了 JSON には載せない |
| sidecar `workers.*.acpSessionId` | worker 再開 | 終了 JSON には載せない |
| sidecar `githubMonitor` | poll カーソル | 終了 JSON には載せない |
| sidecar `updatedAt` | `--continue` のセッション選択 | 終了 JSON には載せない |

---

## 8. 関連コード

| パス | 内容 |
|------|------|
| `packages/core/src/usage/session-usage-tracker.ts` | ラウンド記録・`getSessionSummary()` |
| `packages/core/src/dispatch/session-usage-tool.ts` | `get_session_usage` / `get_usage` |
| `packages/core/src/dispatch/worker-status-tool.ts` | `list_workers` / `get_worker_status` |
| `packages/core/src/conductor/conductor-session.ts` | `sessionUsage` を `buildResult` に載せる |
| `packages/core/src/conductor/session/session-logger.ts` | exit report 蓄積 |
| `packages/cli/src/format-session-summary.ts` | 終了 JSON / テキスト整形 |
| `packages/cli/src/write-issue-session-summary.ts` | stdout / stderr への書き込み |
