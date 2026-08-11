# セッションロギング

`ensemble issue` における **観測（ログ）** と **永続化**、**対話表示** の役割分担。実装の正本は `SessionLogger`（`packages/core/src/conductor/session/session-logger.ts`）。

関連 Issue: [#44](https://github.com/otolab/agents-ensemble/issues/44)

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
│                    ┌─────────────┼─────────────┐            │
│                    ▼             ▼             ▼            │
│              HarnessSink   DialogueSink   snapshot()        │
│              (stderr)      (stdout, TTY)   → 終了 JSON      │
└─────────────────────────────────────────────────────────────┘

  別経路（SessionLogger 外）:
    open question / escalation → stderr（`[open question]` 等）
    sidecar flush → {repoRoot}/.ensemble/sessions/{agentId}.json
```

### stdout

| 内容 | 条件 |
|------|------|
| `operator> …` / `conductor> …` | TTY（または `ENSEMBLE_OPERATOR_MESSAGE` で interactive 判定） |
| **SessionSummary** JSON | セッション終了時（常に 1 行 JSON） |

非 TTY では DialogueSink を付けない。stdout は **終了 JSON のみ**（e2e / パイプ向け）。

### stderr

| prefix | 内容 |
|--------|------|
| `[harness]` | `SessionLogger` → HarnessSink（worktree / send / worker round 等） |
| `[open question]` | open question 登録（`onOpenQuestionEnqueued`） |
| `[operator answer]` | open question 回答のエスカレーション記録 |
| `[worktree]` | `--worktree in-repo` 特別モードの注意 |

harness は **開発者向け**。オペレータの会話 UI には出さない。

### 終了 JSON（SessionSummary）

型名は互換のため `ConductorSessionResult` と同一（`SessionSummary` は別名）。

**会話ログではない。** exit report として次を載せる。

| 分類 | フィールド |
|------|-----------|
| メトリクス | `sendCount`, `stopReason`, `lastRunStatus` |
| 末尾のみ | `lastResult`, `lastError` |
| 蓄積（全履歴） | `workerDispatches` / CLI 出力では `workerResponses` に要約 |
| harness 参照用 | `agentId`, `issueUrl`, `repoRoot` |
| 終了時スナップショット | `escalations`, `openQuestions` |

resume の正本は **sidecar**。終了 JSON の `agentId` は参照用コピー。

CLI の JSON 形状は `packages/cli/src/format-session-summary.ts` が定義（e2e 互換）。

---

## 3. SessionLogger

`ConductorSession` がセッション中に `emit()` し、sink に配信する。同時に `snapshot()` 用の状態を蓄積する。

```typescript
const logger = new SessionLogger({ issueUrl, repoRoot });
logger.subscribe(createHarnessSink());
logger.subscribe(createDialogueSink()); // TTY のみ

await runIssueSession({ sessionLogger: logger, ... });
```

`sessionLogger` を渡さない場合、core は内部で生成する（レガシー callback 用の `attachLegacySessionCallbacks` あり）。

### SessionLogEvent 一覧

| type | 発火タイミング | snapshot への影響 |
|------|----------------|-------------------|
| `harness.worktree` | worktree resolve 直後 | なし（sink のみ） |
| `operator.input` | オペレータ発話をキューに載せる直前 | なし（sink のみ） |
| `conductor.send` | 各 `agent.send` 完了後 | `sendCount`, `lastRunStatus`, `lastResult`, `lastError` を更新 |
| `worker.round` | worker 1 ラウンド完了 | `workerDispatches` に追記 |
| `worker.failed` | worker 失敗 | `workerFailures` に追記 |
| `worker.process.stderr` | worker 子プロセス（`agent acp`）の stderr 1 行 | なし（sink のみ） |
| `session.stop` | セッション終了直前 | `stopReason` を確定 |

### 組み込み sink（CLI）

| 関数 | ファイル | 役割 |
|------|----------|------|
| `createHarnessSink()` | `packages/cli/src/session-sinks.ts` | stderr `[harness]` |
| `createDialogueSink()` | 同上 | stdout `operator>` / `conductor>` |

DialogueSink は `conductor.send` で `status === 'error'` のとき、応答テキストの代わりに再入力を促すメッセージを出す（model blocked 等）。

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
| worker（ACP） | ACP セッション | `worker.round` のメタデータ（name, stopReason, path）。**応答全文は Dialogue に出さない** |

オペレータが読むべき conductor 発話は DialogueSink 経由。worker の `responseText` は終了 JSON の `workerResponses` に載るが、TTY セッション中の会話 UI には混ぜない。

### worker 子プロセスの stdio

`spawnAcpProcess`（`packages/core/src/acp/acp-process.ts`）は worker の `agent acp` を子プロセスとして起動する。

| fd | 扱い | 理由 |
|----|------|------|
| stdin | pipe → ACP プロトコル | harness が JSON-RPC を書き込む |
| stdout | pipe → AcpClient / JsonRpcPeer | ACP プロトコル専用。対話 stdout には出さない |
| stderr | **pipe → capture** | 子の警告（例: `shell-parser`）を TTY の `operator>` 行に混ぜない |

stderr は行バッファで読み、`SessionLogger` の `worker.process.stderr` として sink へ配信する。CLI の HarnessSink は `[harness] worker.stderr name=…` を **stderr** に出す（DialogueSink / stdout には出さない）。

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

- 終了 JSON の薄型化（メトリクス中心、`workerResponses` をオプトイン）
- `conductorSends[]` 履歴（現状は末尾の `lastResult` / `lastError` のみ）
- open question 登録の `SessionLogEvent` 化（現状は CLI callback 直書き）

---

## 8. 関連コード

| パス | 内容 |
|------|------|
| `packages/core/src/conductor/session/session-logger.ts` | `SessionLogger`, 型定義 |
| `packages/core/src/acp/acp-process.ts` | worker 子プロセス spawn・stderr capture |
| `packages/core/src/conductor/conductor-session.ts` | `emit` 配線、`snapshot()` で終了 |
| `packages/cli/src/session-sinks.ts` | Harness / Dialogue sink |
| `packages/cli/src/format-session-summary.ts` | 終了 JSON 整形 |
| `packages/cli/src/index.ts` | sink 購読と interactive 判定 |

テスト: `session-logger.test.ts`, `session-sinks.test.ts`, `acp-process.test.ts`
