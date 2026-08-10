# ADR 0012: conductor → worker 作業指示（`prompt_worker` / ACP 往復）

- Status: proposed
- Date: 2026-08-10
- Related: Issue #36, [ADR 0002](0002-star-topology-sdk-conductor-acp-worker.md), [ADR 0009](0009-conductor-session-event-queue.md), [ADR 0011](0011-session-sidecar-resume.md)

## Context

### ユースケース（標準動作モード）

1. conductor と worker（implementer / reviewer 等）が **セッション開始時に起動**する
2. conductor が Issue / Skill 等を確認し、**判断**する
3. conductor が worker に **作業開始を指示**する
4. worker が指示と Issue / Skill をもとに **作業**する
5. 一段落したら **Issue に報告**し、同時に harness へ **ACP ラウンド完了**を返す
6. conductor が進捗を確認し、worker に **追加の作業指示**を送る
7. worker が追加作業 → 完了報告（5 と同型）
8. conductor が Issue に完了メッセージ等を書き、**オペレータの回答待ち**に入る

複数 worker が **非同期・並行**で上記を **数往復**する。

### 現状ギャップ（#36）

| 経路 | 状態 |
|------|------|
| worker → conductor（permission） | 実装済み |
| worker → conductor（`worker.completed` / `failed`） | 実装済み（ACP prompt 終了通知） |
| conductor → worker（bootstrap 初回 prompt） | 実装済み（harness 固定文） |
| conductor → worker（**判断後の作業指示**） | **未実装** |
| worker の作業報告 | Issue / PR（harness 外・設計どおり） |
| conductor の進捗確認 | Issue 閲覧（SDK ツール依存）+ `worker.completed` YAML |

bootstrap 後は ACP bridge が閉じ、`acpSessionId` は sidecar にあるが **2 回目の `session/prompt` 経路がない**。

### 検討した選択肢

| 案 | 概要 | 不採用理由 |
|----|------|------------|
| A. Issue 更新をトリガーに worker を動かす | Issue webhook / ポーリング | Issue は正本でありトリガーではない（team.md）。harness が複雑化 |
| B. conductor が worker ACP を直接握る | SDK から ACP RPC | 二系統の責務が conductor LLM に漏れる |
| **C. harness API + conductor custom tool（採用）** | `prompt_worker` → `WorkerSession.promptWorker` → `session/prompt` | ADR 0002 のスター型・0009 のイベント列と整合 |
| D. bootstrap 1 本で走り切り | 現状に近い | 常駐 worker + 数往復のユースケースを満たせない |

## Decision

### 通信を二層に分ける

| 層 | 用途 | 実装 |
|----|------|------|
| **同期（harness）** | 動かす・許可する・ラウンド終了を知る | ACP `session/prompt`, `session/request_permission`, inbox → イベント列 |
| **非同期（Issue / PR）** | 作業内容・進捗・論点の正本 | worker / conductor が GitHub ツールで読み書き。harness は仲介しない |

**Issue に書いただけでは worker は動かない。** 作業のトリガーは harness 同期経路（`prompt_worker`）のみ。

### conductor → worker: `prompt_worker`

1. conductor LLM が SDK custom tool **`prompt_worker`** を呼ぶ
   - 引数: `worker`（profile の `workers[].name`）, `instruction`（作業指示文・Markdown 可）
2. harness **`WorkerSession.promptWorker({ name, instruction })`** が処理する
3. sidecar / ランタイムが保持する **`acpSessionId`** で ACP に接続
   - [ADR 0011](0011-session-sidecar-resume.md): プロセス再起動後は `session/load` が必須
4. 既存 session へ **`session/prompt`**（`instruction`）を送る
5. tool は **非ブロック**で返す（bootstrap と同型）
   - 戻り値: 受付成功 / エラー（worker 名不明、load 失敗等）
   - **完了は `worker.completed` イベント**で conductor に届く（[ADR 0009](0009-conductor-session-event-queue.md)）

`prompt_worker` の tool 結果は SDK 会話に載る。**セッションイベント列には積まない**（permission / worker 完了と同じ分離）。

### worker → conductor（変更なし）

| 意味 | 経路 |
|------|------|
| 操作許可 | ACP permission → inbox → `resolve_permission` or 即決 |
| **ラウンド完了** | ACP prompt 終了 → `worker.completed` → イベント列 → `agent.send` |
| **作業報告・論点** | **Issue / PR への投稿**（worker が書く。conductor は読む） |

`worker.completed` は **「タスク全体の完了」ではなく「1 回の `session/prompt` ラウンドの終了」** と解釈する。conductor は Issue を読んで進捗を判断する。

### bootstrap の役割変更

| 項目 | 現状 | 本 ADR 後 |
|------|------|-----------|
| bootstrap prompt | 起動文書 + ensemble（作業待ちの文言はあるが実質 1 本で走る） | **待機・役割・permission のみ**の最小 prompt。実作業の開始は conductor の `prompt_worker` |
| ACP 接続 | `dispatchWorker` 完了後に bridge close | **初回も close 可**。`prompt_worker` ごとに connect → load → prompt → close（0011 と同型） |
| `acpSessionId` | bootstrap 結果を sidecar へ | 維持。各 `prompt_worker` で load に使用 |

### 並行・数往復

- worker ごとに **独立した ACP session**（name → `acpSessionId`）
- `WorkerRuntime` は **worker 単位で running 状態**を持つ。同一 worker への `prompt_worker` は **前ラウンド完了まで拒否**（またはキューイングはフォロー Issue。初版は拒否でよい）
- 異なる worker への `prompt_worker` は **並行**可能（implementer と reviewer 同時稼働）
- conductor ループは **running worker ありならイベント待ち**（現行 [ConductorSession](packages/core/src/conductor/conductor-session.ts) の挙動を維持）

### 初回 Issue コンテキスト

conductor の初回 `agent.send` に Issue 本文を載せるかは **本 ADR の必須範囲外**（別 PR 可）。conductor は SDK 経由で `gh` 等を使って Issue を読む前提は変えない。

## Consequences

### 良い点

- ユースケース（判断 → 指示 → 作業 → 報告 → 再指示）がスター型トポロジのまま実現できる
- ADR 0009 の「1 イベント = 1 send」と矛盾しない（worker 完了は従来どおりイベント）
- ADR 0011 の `session/load` + `acpSessionId` をそのまま再利用できる
- Issue = 正本 / harness = トリガー の分担が明確

### 悪い点・リスク

- bootstrap と「常駐」の意味が変わる（integration テスト・Fake ACP の更新が必要）
- `prompt_worker` ごとの connect / load / close はオーバーヘッドがある（初版は単純さ優先）
- conductor が Issue を読まず `worker.completed` だけで進捗判断すると誤動作する → prompt / team.md で Issue 正本を強調

### フォロー

- [architecture.md](../architecture.md) §5 の双方向フロー図を更新
- modular-prompt の `FIXME(#36)` を実装後に削除
- 同一 worker への指示キュー、prompt 失敗時の再 bootstrap — 必要になったら別 ADR / Issue

## 実装フェーズ（案）

| Phase | 内容 | 受け入れ |
|-------|------|----------|
| **1** | `WorkerSession` / `WorkerRuntime`: name → session レジストリ、`promptWorker()`、running ガード | unit + fake ACP: 同一 session で 2 回 `session/prompt` |
| **2** | `prompt_worker` custom tool、`ConductorSession` 配線 | integration: tool 呼び出し → 2 回目 prompt 受信 |
| **3** | bootstrap prompt を待機中心に調整、プロンプト `FIXME` 削除 | ensemble / profile テスト更新 |
| **4**（任意） | 初回 conductor send へ `formatIssueContextForPrompt` 注入 | issue-session integration |

Phase 1–2 で #36 の受け入れ条件を満たす。Phase 3 はユースケース整合。Phase 4 は別 Issue でも可。
