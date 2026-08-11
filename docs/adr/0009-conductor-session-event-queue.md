# ADR 0009: ConductorSession とセッションイベント列

- Status: accepted
- Date: 2026-08-08

## Context

conductor への入力経路が整理されていなかった。

- worker 完了 / 失敗は `ConductorInbox` 経由
- オペレータ発話は `bindOperatorInput` → `submitOperatorInput` → `operator.message` 経由
- 自律ターン更新は毎ループ `buildConductorFollowUpPrompt` で Issue / worker 状態を **丸ごと投影** して `agent.send`

これは ACP worker 向け「毎ターン full state を prompt で送る」パターンの名残であり、SDK conductor の意図（`agent.send` = user ターン 1 本の append）と合わない。Queue がないため「なんとなく send」し、フル state dump で穴を塞いでいた（#28）。

### 用語

| 用語 | 意味 |
|------|------|
| **ConductorSession** | 1 Issue あたりの harness ループ（旧 `issue-session`）。イベント列・`agent.send`・open question 待ちを担う |
| **WorkerSession** | 同一 Issue の worker 群の起動・ACP 接続 |
| **ConductorAgent** | `@cursor/sdk` の長寿命 Agent ハンドル |
| **operator** | CLI / TTY で conductor を監督する人間（open question に答える側） |
| **SDK user ターン** | `agent.send` が会話に追加するロール。operator 発話もこのロールで載る |

`WorkerSession` / `ConductorSession` は対をなす名前とする。

### SDK の制約

`@cursor/sdk`（1.0.27 時点）の公開 API に caller 向け system prompt 専用フィールドはない。`agent.send(string | SDKUserMessage)` が会話への user ターン追加手段。custom tool の戻り値は SDK が会話に tool 結果として載せる（我々のイベント列には入れない）。

## Decision

### セッションイベント列（1 本）

worker / operator / harness 由来の「conductor に伝えるべきこと」は **1 本のイベント列** に集約する。`ConductorInbox` と conductor 向け Queue を別箱にしない。

```
worker ──┐
operator ┼──► ConductorSession イベント列 ──► ループが処理
harness ─┘
```

| イベント | 処理 |
|---------|------|
| `permission.request` | policy で即決 → worker に返す。deferred なら pending 登録 + **`permission.pending` を列に積む** |
| `worker.completed` / `worker.failed` | フォーマットして **`agent.send`**（1 イベント = 1 send） |
| `operator.message` | **`agent.send`**（将来: 優先度・割り込み） |
| `max_turns` 到達 | open question 登録（`source: max_turns`）。**send しない**。operator 回答が `operator.message` として列に入る |

`agent.send` 対象かどうかはイベント種別の分岐で決める。箱は 1 つ。

ループは Queue が空で worker 実行中なら **inbox イベントまでブロック** し、空 send しない。

### modular-prompt と `agent.send`

| レイヤ | 役割 |
|--------|------|
| **modular-prompt** | conductor の **system prompt 文**（persona / guidelines / materials） |
| **初回 `agent.send`** | system prompt compile 結果 + Issue ブリーフィング（**1 本**。圧縮しない方針） |
| **2 ターン目以降** | イベント列から drain した内容のみ `agent.send` |
| **SDK 会話** | LLM 会話の正本。tool 結果は SDK が載せる |

毎ターン `compileConductorTurnUpdate` で full state を送る経路は廃止する（#28 Phase 4）。

###  outbound メッセージ形式（基本方針）

詳細フィールドは別 Issue で詰めてよい。「あるデータは全部渡す」。

| 内容 | 形式 |
|------|------|
| 構造化データ | YAML |
| 長文 | Markdown |
| 単純な operator 発話 | プレーンテキスト |

### セッション終了

**LLM が終わったと思ったら終わるのは誤り**。終了条件は harness（ConductorSession）が握る。現行の `shouldStopIssueLoop` 改修は保留（#28 フォロー）。

## Consequences

### 良い点

- conductor への入力がイベント列として明示される
- 空 send とフル state dump をやめられる
- `WorkerSession` / `ConductorSession` で対称な命名

### 悪い点・リスク

- 大規模な構造変更（ループ・inbox 配線・テスト）
- SDK に system API が無いため、初回 send に system 文を載せる妥協（将来 API 出現時に分離検討）
- イベント種別ごとのペイロード詳細は未確定（フォロー Issue 可）

### フォロー

- #28: 実装（Phase 1〜4、1 PR）
- open question / operator integration テスト: #26
- worker ACP 復元: `session/load`（`session/resume` は Cursor `agent acp` 未対応）。実測は [ADR 0011](0011-session-sidecar-resume.md)
- セッション終了条件の見直し（harness 主導）
- イベントペイロード詳細・優先度 / 割り込み
- permission pending の届け方（ADR 0007 からの変更）: [ADR 0010](0010-permission-pending-event-delivery.md)

## 関連

- [ADR 0008](0008-human-dialogue-open-questions.md) — open question・operator
- [architecture.md](../architecture.md) §3, §5
