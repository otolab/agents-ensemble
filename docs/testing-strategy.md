# テスト戦略

[architecture.md](architecture.md) に基づく agents-ensemble のテスト分類・配置・実行方針。
[modular-prompt の TESTING_STRATEGY.md](https://github.com/otolab/modular-prompt/blob/main/docs/TESTING_STRATEGY.md) を参考に、**unittest / integration test / e2e test を明示的に分離**する。

## 原則

1. **下位レイヤから積む** — ACP ブリッジの unittest を先に固め、integration → e2e の順で厚くする
2. **CI は unittest 必須** — integration / e2e は設定・環境が揃う場合のみ（未設定なら `skip`）
3. **外部依存は境界で切る** — `agent acp` / `gh` / `@cursor/sdk` は unittest ではモック or Fake
4. **Stage ごとの完了ゲートをテストレベルで定義する**（下表）

## テストレベルと Stage の対応

| レベル | Stage 1 の主対象 | 完了ゲート |
|--------|-----------------|-----------|
| **unittest** | JSON-RPC transport、AcpClient、Fake ACP server、型、プロンプトビルダー | #3 ACP ブリッジの「作りきり」 |
| **integration** | 実 `agent acp` との stdio 通信、session ライフサイクル、プロセス cleanup | #3 受け入れの一部 |
| **e2e** | `ensemble dispatch worker` CLI 縦切り | #6 Stage 1 完了 |

Stage 2 以降は conductor（SDK）・`gh`・permission 仲介が integration / e2e の対象に追加される。

---

## 1. ユニットテスト (Unit Tests)

**定義**: 単一モジュールの振る舞いを検証。**外部プロセス・ネットワーク・実 `agent acp` は使わない。**

### 対象（`packages/core` 中心）

| モジュール | 検証内容 |
|-----------|---------|
| **JsonRpcTransport** | stdio バッファリング、メッセージ境界、request/response 対応 |
| **AcpClient** | メソッド呼び出しの組み立て（transport はモック） |
| **FakeAcpServer** | 決まった JSON-RPC 応答を返すテスト用サーバ（in-process or 子スクリプト） |
| **SessionRunner** | `session/update` シーケンスの解釈、完了検知（Fake 使用） |
| **共有型** | URL パース、ロール enum 等 |
| **PromptBuilder** | ロール別起動文の組み立て |
| **WorktreeHelper** | パス・ブランチ名規約（temp dir + git は最小限の fixture） |
| **PermissionPolicy** | allow/deny 判定（純関数） |

### 配置

```
packages/core/src/**/*.test.ts
packages/core/src/**/*.spec.ts
```

### 実行

```bash
pnpm test              # watch（unittest のみ）
pnpm test:run          # 単発（CI デフォルト）
```

### vitest 設定方針

- `test/integration/**` と `test/e2e/**` を **exclude**
- タイムアウト: 10 秒程度
- 並列実行: 可（プロセス・GPU 依存なし）

### モック方針（modular-prompt の TestDriver 相当）

ACP 向けに **FakeAcpServer**（または `TestAcpTransport`）を core に置く。

| テストレベル | `agent acp` プロセス | JSON-RPC |
|------------|---------------------|----------|
| unittest | 使わない | Fake / モック transport |
| integration | 実プロセス | 実 stdio |
| e2e | 実プロセス（CLI 経由） | 実 stdio |

**モックすべきもの（unittest）**: 子プロセス、`agent` バイナリ、ネットワーク、`gh`、SDK Agent

**実装を直接テストすべきもの（unittest）**: パース、状態遷移、エラーメッセージ、プロンプト文字列

---

## 2. 統合テスト (Integration Tests)

**定義**: **複数モジュールの接続**、または **外部プロセス（`agent acp`）との実通信**を検証。ユーザー入口（CLI）は使わない。

### 対象

| シナリオ | 検証内容 |
|---------|---------|
| **dispatchWorker + Fake ACP** | in-process Fake、`responseText`、prompt 組み立て |
| **WorkerSession + inbox** | bootstrap → 完了コールバックまで（Fake ACP） |
| **AcpBridge ライフサイクル** | spawn → initialize → authenticate → session/new → session/prompt → update 購読 → 終了 |
| **プロセス cleanup** | 正常終了・異常終了でゾンビが残らない |
| **permission 往復** | `session/request_permission` → 応答（Stage 3） |
| **gh ラッパー** | 実 `gh` で Issue 取得（Stage 2、設定あり時のみ） |

### 配置

```
packages/core/test/integration/**/*.integration.test.ts
packages/core/test/fixtures/**          # 応答ログ、最小 repo 等
packages/core/test/integration/test-acp.yaml.example
```

### 実行

```bash
pnpm test:integration
```

### スキップ条件（modular-prompt の `test-drivers.yaml` パターン）

`test-acp.yaml`（gitignore）が無い、または `agent` が PATH に無い場合は `describe.skipIf` でスキップ。

```typescript
// 例
describe.skipIf(!hasAcpTestConfig())('AcpBridge integration', () => { ... });
```

### vitest 設定方針

- `include`: `**/test/integration/**/*.integration.test.ts` のみ
- タイムアウト: 60 秒以上（session 待ち）
- **逐次実行推奨**（`fileParallelism: false`）— 複数 `agent acp` の同時起動を避ける

### Stage 1 における位置づけ

**#3 ACP ブリッジの受け入れ条件の一部**。unittest が green になってから追加する。
ローカル開発者・夜間 CI で実行。PR の必須チェックにはしない（初期）。

---

## 3. E2E テスト (End-to-End Tests)

**定義**: **ユーザー入口（`ensemble` CLI）から**、Issue URL 入力〜 worker dispatch 完了までを検証。

### 対象

| Stage | シナリオ |
|-------|---------|
| **1** | `ensemble dispatch worker <issue-url> --skill <name>` — worktree + ACP + プロンプト |
| **2** | `ensemble issue <url>` — conductor + worker 連携（ping/pong 等） |
| **3+** | reviewer ループ、permission エスカレーション（別ファイルで追加） |

### 配置

```
packages/cli/test/e2e/**/*.e2e.test.ts
test/e2e/**/*.e2e.test.ts          # リポジトリ横断が必要な場合
```

### 実行

```bash
pnpm test:e2e
```

### 前提・スキップ

- `CURSOR_API_KEY` または `ensemble auth login` 済み（Stage 2 以降の conductor）
- `test-acp.yaml` + テスト用 Issue URL（または専用テスト repo）
- `gh` 認証（実 Issue を触る場合）

未設定時は skip。手動スモーク用のドキュメントを README に記載。

### vitest 設定方針

- `include`: `**/test/e2e/**` のみ
- タイムアウト: 数分（LLM + ACP 待ち）
- 逐次実行必須

### Stage 1 における位置づけ

**#6 の受け入れ条件 = e2e が 1 本以上 green**（設定がある環境で）。
#3 の unittest / integration が先。e2e は最後のゲート。

---

## コマンド一覧（予定）

```bash
pnpm test:run           # unittest（CI 必須）
pnpm test:integration   # integration（設定時のみ実行）
pnpm test:e2e           # e2e（設定時のみ実行）
pnpm test:all           # 全レベル（ローカル用）
```

## CI 戦略

| トリガー | unittest | integration | e2e |
|---------|----------|-------------|-----|
| PR | 必須 | スキップ（または nightly） | スキップ |
| main | 必須 | 任意（secrets + label） | スキップ |
| 手動 / nightly | 必須 | 推奨 | 任意 |
| リリース前 | 必須 | 必須（設定ある場合） | 推奨 |

## 実装順序（Stage 1）

```
1. vitest 基盤 + unittest 用 vitest.config
2. FakeAcpServer / transport の unittest
3. AcpClient / SessionRunner の unittest  ← #3 の核
4. integration: 実 agent acp
5. worktree / prompt（unittest）
6. e2e: ensemble dispatch worker          ← #6
```

## 関連 Issue

- #2 共有型（unittest 対象の型）
- #3 ACP ブリッジ（unittest + integration の主戦場）
- #19 テスト基盤（vitest・config・FakeAcpServer 骨格）
- #6 CLI dispatch（e2e 完了点）

## 参照

- [modular-prompt: TESTING_STRATEGY.md](https://github.com/otolab/modular-prompt/blob/main/docs/TESTING_STRATEGY.md)
- [modular-prompt: vitest.config.ts](https://github.com/otolab/modular-prompt/blob/main/packages/driver/vitest.config.ts) — unittest から integration/e2e を exclude する例
- [architecture.md §4](architecture.md) — ACP 起動パターン
