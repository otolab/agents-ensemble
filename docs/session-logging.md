# セッションロギング

`ensemble issue` における **観測（ログ）** と **永続化**、**対話表示** の役割分担。実装の正本は `SessionLogger`（`packages/core/src/conductor/session/session-logger.ts`）。

関連 Issue: [#44](https://github.com/otolab/agents-ensemble/issues/44)

イベント型の一覧・SessionEvent との対応・init prompt 方針は [harness-events.md](harness-events.md) を正本とする。利用可能な統計・トークン・コスト・worker 状態のフィールド一覧は [session-metrics.md](session-metrics.md) を正本とする。

---

## 1. なぜ分けるか

conductor セッションには性質の異なる出力が混在する。

| 種類 | 読者 | 例 |
|------|------|-----|
| **対話** | オペレータ（人間） | `operator>` / `conductor>` のやりとり |
| **harness テレメトリ** | 開発者・運用者 | worktree 解決、worker ラウンド完了、send 回数 |
| **exit report** | e2e / CI / スクリプト | 終了時 JSON（`stopReason`, `workerResponses` 等） |
| **resume 状態** | 次回 `ensemble issue --resume` | sidecar JSON |

これらを 1 本の stderr に混ぜると、TTY 利用時に **会話相手が worker に見える**・**conductor の応答が終了まで見えない** といった UX 問題が起きる（#44）。

**原則**: 観測は `SessionLogger` に集約し、**sink** で出力先・フォーマットを分離する。永続化の正本は sidecar（会話本文は SDK / ACP 側）。

---

## 2. 出力チャネル（CLI）

```
┌─────────────────────────────────────────────────────────────┐
│  ConductorSession                                           │
│    emit(SessionLogEvent) ──► SessionLogger                  │
│                                  │                          │
│         ┌────────────────────────┼────────────────────┐   │
│         ▼                        ▼                    ▼   │
│   HarnessSink            DisplaySink          ObservationSink│
│   (stderr)          reducer → backend         (stderr)    │
│                     (Ink TUI or stdout)                   │
│   TTY 時は Harness/Observation を stderr に出さず、      │
│   TuiTelemetrySink → 活動ログ（Orchestration メインペイン）へ       │
│                                  │                          │
│                                  └────► snapshot()          │
│                                        → 終了 JSON          │
└─────────────────────────────────────────────────────────────┘

  別経路（SessionLogger 外）:
    sidecar flush → {repoRoot}/.ensemble/sessions/{agentId}.json
```

### stdout

| 内容 | 条件 |
|------|------|
| `operator> …` / `conductor> …` | TTY: Ink TUI ペイン。非 TTY + env: string backend（`bindAsyncOperatorInput` 経路） |
| **SessionSummary** JSON | 非 TTY 終了時（`--summary-format auto` 既定）。e2e / パイプ向け |

非 TTY では DisplaySink は noop backend（または env 時のみ string backend）。stdout は **終了サマリ JSON**（`--summary-format auto` 既定）。TTY では Ink TUI が対話を表示する（stdout への逐次 `write` は行わない）。

### stderr

| prefix | 内容 | 条件 |
|--------|------|------|
| `[harness]` | `SessionLogger` → HarnessSink（worktree / send / worker round 等） | **非 TTY のみ**（TTY + Ink 時は活動ログへ） |
| `[open question]` | `open.question.enqueued` → ObservationSink | **非 TTY のみ** |
| `[operator answer]` | `escalation.recorded` → ObservationSink | **非 TTY のみ** |
| `[worktree]` | `session.worktree.notice` → ObservationSink | **非 TTY のみ** |
| `[continue]` | `session.continue` → ObservationSink | **非 TTY のみ** |
| （終了サマリ） | `formatIssueSessionSummaryText`（`writeIssueSessionSummary`） | **TTY のみ**（`--summary-format auto` または `text`）。Ink unmount 後 |

TTY + Ink 時は harness / observation イベントを **stderr に書かず**、`createTuiTelemetrySink` 経由で Ink の **Orchestration** メインペイン（活動ログ）に `[harness]` / `[observation]` ラベル付きで追記する。operator / conductor 応答は DisplaySink → Ink backend が `[operator]` / `[conductor]` として同ペインに追記する（末尾 300 エントリ windowing。#108）。

### 終了 JSON（SessionSummary）

型名は互換のため `ConductorSessionResult` と同一（`SessionSummary` は deprecated alias）。

**会話ログではない。** exit report として次を載せる。

| 分類 | フィールド |
|------|-----------|
| メトリクス | `sendCount`, `stopReason`, `lastRunStatus` |
| 末尾のみ | `lastResult`, `lastError` |
| 蓄積（全履歴） | `workerDispatches` / CLI 出力では `workerResponses` に要約 |
| harness 参照用 | `agentId`, `issueUrl`, `repoRoot` |
| 終了時スナップショット | `escalations`, `openQuestions` |
| LLM usage | `sessionUsage`（`get_session_usage` と同型。cost は conductor `getUsage()` からマージ） |
| worker 応答要約 | `workerResponses[].responsePreview`（全文は `--include-full-response-text`） |

フィールドごとの型・ソース・ツールとの対応・未取得時の扱いは [session-metrics.md](session-metrics.md) を正本とする。

resume の正本は **sidecar**。終了 JSON の `agentId` は参照用コピー。

CLI の JSON 形状は `packages/cli/src/format-session-summary.ts` が定義（e2e 互換）。`--summary-format` / `--include-full-response-text` で終了出力を制御する。

---

## 3. SessionLogger

`ConductorSession` がセッション中に `emit()` し、sink に配信する。同時に `snapshot()` 用の状態を蓄積する。

```typescript
const logger = new SessionLogger({ issueUrl, repoRoot });
logger.subscribe(createHarnessSink());
logger.subscribe(createObservationSink());
logger.subscribe(createSessionDisplaySink({
  backend: selectSessionDisplayBackend({ interactive }),
}));

await runIssueSession({ sessionLogger: logger, ... });
```

`sessionLogger` を渡さない場合、core は内部で生成する（レガシー callback 用の `attachLegacySessionCallbacks` あり）。

### SessionLogEvent 一覧

[harness-events.md](harness-events.md) に全イベント・SessionEvent 対応・init prompt 方針を記載。概要:

| type | 発火タイミング | snapshot への影響 |
|------|----------------|-------------------|
| `harness.worktree` | worktree resolve 直後 | なし（sink のみ） |
| `harness.worker.prompt.*` | worker prompt 開始 / 完了 / 失敗（init / instruction 対称） | なし（sink のみ） |
| `harness.worker.state` / `harness.session.workers` | worker harness 状態遷移 / セッション開始時 seed（#147） | なし（sink のみ） |
| `operator.input` | オペレータ発話をキューに載せる直前 | なし（sink のみ） |
| `conductor.send.started` | 各 `agent.send` 開始直前 | なし（sink のみ） |
| `conductor.send.progress` | conductor ターン中の SDK ツール開始 | なし（log 相当。活動ログ / stderr には出さない。Workers ペイン活動ヒントのみ #161） |
| `conductor.send` | 各 `agent.send` 完了後 | `sendCount`, `lastRunStatus`, `lastResult`, `lastError` を更新 |
| `worker.round` | worker 1 ラウンド完了（init prompt 含む） | `workerDispatches` に追記 |
| `worker.failed` | worker 失敗 | `workerFailures` に追記 |
| `worker.process.stderr` | worker 子プロセス（`agent acp`）の stderr 1 行 | なし（sink のみ） |
| `session.stop` | セッション終了直前 | `stopReason` を確定 |

### 組み込み sink（CLI）

| 関数 | ファイル | 役割 |
|------|----------|------|
| `createHarnessSink()` | `packages/cli/src/session-sinks.ts` | stderr `[harness]`（非 TTY） |
| `createObservationSink()` | 同上 | stderr 観測（非 TTY） |
| `createTuiTelemetrySink()` | `packages/cli/src/tui/` | TTY Ink 活動ログ（harness + observation） |
| `createSessionDisplaySink()` | `packages/cli/src/display/` | `SessionLogEvent` → reducer → `SessionDisplayBackend` |
| `selectSessionDisplayBackend()` | 同上 | interactive かつ非 TTY 時は string backend、TTY は Ink host、非 interactive は noop |
| `createDialogueSink()` | `session-sinks.ts` | 低レベル stdout 整形（string backend が `operator.input` / `conductor.send` で利用） |

表示 state（`SessionDisplayState`）は worker 状態・conductor 直近出力・未回答 open question を保持する。TTY では Ink TUI（`packages/cli/src/tui/`）が同じ reducer / backend 契約で 4 ペイン表示する（#94）。

---

## 4. sidecar との関係

| | SessionSummary（終了 JSON） | sidecar |
|--|---------------------------|---------|
| **目的** | 1 回の実行結果の報告 | セッション再開用の harness 状態 |
| **タイミング** | プロセス終了時に 1 回 | 状態変化時に best-effort flush + 終了時 |
| **会話本文** | 載せない（worker 応答の要約のみ） | 載せない |
| **open question** | 終了時の一覧スナップショット | 正本（registry 全体） |
| **worker session** | 載せない | `acpSessionId` を保持 |

詳細は [ADR 0011](adr/0011-session-sidecar-resume.md) と [README のセッション再開](../README.md#セッションの停止と再開)。

---

## 5. SDK / ACP の会話ログ

| 主体 | 正本 | harness が載せるもの |
|------|------|---------------------|
| conductor（SDK） | SDK store（`agentId`） | `conductor.send` の status / 末尾 result のみ |
| worker（ACP） | ACP セッション | `worker.round` のメタデータ（name, stopReason, path）。**応答全文は対話 stdout に出さない** |

オペレータが読むべき conductor 発話は DisplaySink → string backend（内部で `createDialogueSink`）経由。worker の `responseText` は終了 JSON の `workerResponses` に載るが、TTY セッション中の会話 UI には混ぜない。

### worker 子プロセスの stdio

`spawnAcpProcess`（`packages/core/src/acp/acp-process.ts`）は worker の `agent acp` を子プロセスとして起動する。

| fd | 扱い | 理由 |
|----|------|------|
| stdin | pipe → ACP プロトコル | harness が JSON-RPC を書き込む |
| stdout | pipe → AcpClient / JsonRpcPeer | ACP プロトコル専用。対話 stdout には出さない |
| stderr | **pipe → capture** | 子の警告（例: `shell-parser`）を TTY の `operator>` 行に混ぜない |

stderr は行バッファで読み、`SessionLogger` の `worker.process.stderr` として sink へ配信する。CLI の HarnessSink は `[harness] worker.stderr name=…` を **stderr** に出す（対話 stdout には出さない）。

stdout へのプロトコル外出力は JsonRpc 層でパース失敗として検知される。現状は stderr capture を優先し、stdout 漏れの二重読みは行わない。

conductor（SDK）子プロセスの stdio は本 Issue のスコープ外（follow-up）。

---

## 6. カスタム sink

`SessionLogSink = (event: SessionLogEvent) => void` を `subscribe()` で追加できる。

用途例:

- 構造化ログ（JSON Lines）をファイルへ
- CI で harness のみ収集し stdout は JSON だけパース
- 将来の Web UI へのイベントストリーム

レガシー API（`onSendComplete`, `onWorkerDispatched`, `onWorkerFailed`）は内部で同じイベントから呼ばれる。新規コードは `SessionLogger.subscribe` を推奨。

---

## 7. 今後の拡張（未実装）

- 終了 JSON への `startedAt` / `durationMs`（セッション経過時間）
- exit JSON への `autonomousTurns` / `maxTurns` 配線
- GitHub 監視累計カウンタ
- `conductorSends[]` 履歴（現状は末尾の `lastResult` / `lastError` のみ）

---

## 8. 関連コード

| パス | 内容 |
|------|------|
| `packages/core/src/conductor/session/session-logger.ts` | `SessionLogger`, 型定義 |
| `packages/core/src/acp/acp-process.ts` | worker 子プロセス spawn・stderr capture |
| `packages/core/src/conductor/conductor-session.ts` | `emit` 配線、`snapshot()` で終了 |
| `packages/cli/src/session-sinks.ts` | Harness / Observation / Dialogue sink |
| `packages/cli/src/display/` | 表示 state・reducer・DisplaySink |
| `packages/cli/src/format-session-summary.ts` | 終了 JSON / テキスト整形 |
| `packages/cli/src/resolve-summary-format.ts` | `--summary-format` 解決 |
| `packages/cli/src/issue-command.ts` | sink 購読と interactive 判定 |

テスト: `session-logger.test.ts`, `session-sinks.test.ts`, `session-display-reducer.test.ts`, `select-session-display-backend.test.ts`, `acp-process.test.ts`
