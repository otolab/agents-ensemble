# テスト戦略

> **正本:** agents-ensemble の unittest / integration / e2e の分類・配置・実行方針。

[architecture.md](architecture.md) に基づき、**unittest / integration / e2e を明示的に分離**する。参考: [modular-prompt の TESTING_STRATEGY.md](https://github.com/otolab/modular-prompt/blob/main/docs/TESTING_STRATEGY.md)。

## 原則

1. **下位レイヤから積む** — transport / client の unittest を先に固め、integration → e2e の順で厚くする
2. **CI は unittest 必須** — integration / e2e は設定・環境が揃う場合のみ（未設定なら `skip`）
3. **外部依存は境界で切る** — `agent acp` / GitHub API / `@cursor/sdk` は unittest ではモック or Fake
4. **レベルごとに責務を分ける** — 下表の定義に従い、同じ振る舞いを複数レベルで重複検証しない

## テストレベルの定義

| レベル | 入口 | 外部プロセス | 主な目的 |
|--------|------|-------------|----------|
| **unittest** | モジュール直接 | 使わない | パース、状態遷移、純関数、Fake transport |
| **integration** | core API | 実 `agent acp` 等（設定時） | モジュール接続、stdio 通信、session ライフサイクル |
| **e2e** | `ensemble` CLI | CLI 経由で実依存 | Issue URL 入力から終了 JSON までの縦切り |

---

## 1. ユニットテスト

**定義**: 単一モジュールの振る舞いを検証。**外部プロセス・ネットワーク・実 `agent acp` は使わない。**

### 対象（`packages/core` 中心）

| モジュール | 検証内容 |
|-----------|---------|
| **JsonRpcTransport** | stdio バッファリング、メッセージ境界、request/response 対応 |
| **AcpClient** | メソッド呼び出しの組み立て（transport はモック） |
| **FakeAcpServer** | 決まった JSON-RPC 応答を返すテスト用サーバ |
| **SessionRunner** | `session/update` シーケンスの解釈、完了検知（Fake 使用） |
| **共有型** | URL パース、ロール enum 等 |
| **PromptBuilder** | ロール別起動文の組み立て |
| **WorktreeHelper** | パス・ブランチ名規約（temp dir + git は最小限の fixture） |
| **PermissionPolicy** | allow/deny 判定（純関数） |

`packages/cli` の表示・TUI・サマリ整形も同様に `src/**/*.test.ts` で unittest する。

### 配置

```
packages/core/src/**/*.test.ts
packages/cli/src/**/*.test.ts
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

### モック方針

| テストレベル | `agent acp` プロセス | JSON-RPC |
|------------|---------------------|----------|
| unittest | 使わない | Fake / モック transport |
| integration | 実プロセス | 実 stdio |
| e2e | 実プロセス（CLI 経由） | 実 stdio |

**モックすべきもの（unittest）**: 子プロセス、`agent` バイナリ、ネットワーク、GitHub API クライアント、SDK Agent

**実装を直接テストすべきもの（unittest）**: パース、状態遷移、エラーメッセージ、プロンプト文字列

---

## 2. 統合テスト

**定義**: **複数モジュールの接続**、または **外部プロセス（`agent acp`）との実通信**を検証。ユーザー入口（CLI）は使わない。

### 対象

| シナリオ | 検証内容 |
|---------|---------|
| **AcpBridge ライフサイクル** | spawn → initialize → authenticate → session/new → session/prompt → update 購読 → 終了 |
| **attachWorker / WorkerSession** | bootstrap → 完了コールバック（Fake または実 ACP） |
| **permission 往復** | `session/request_permission` → 応答 |
| **conductor session** | SDK conductor + dispatch + operator 入力 |
| **session resume** | sidecar 復元と worker 再開 |
| **GitHub API クライアント** | 実 GitHub API で Issue 取得（トークン設定時のみ） |
| **team profile / workspace** | profile 解決と ACP cwd |

### 配置

```
packages/core/test/integration/**/*.integration.test.ts
packages/core/test/fixtures/**
packages/core/test/integration/test-acp.yaml.example
```

### 実行

```bash
pnpm test:integration
```

### スキップ条件

`test-acp.yaml`（gitignore）が無い、または `agent` が PATH に無い場合は `describe.skipIf` でスキップ。

### vitest 設定方針

- `include`: `**/test/integration/**/*.integration.test.ts` のみ
- タイムアウト: 60 秒以上（session 待ち）
- **逐次実行推奨**（`fileParallelism: false`）— 複数 `agent acp` の同時起動を避ける

---

## 3. E2E テスト

**定義**: **ユーザー入口（`ensemble` CLI）から**、Issue URL 入力〜セッション終了までを検証。

### 対象

| シナリオ | 検証内容 |
|---------|---------|
| **smoke** | `ensemble issue` — conductor + worker 連携、終了 JSON の必須フィールド |
| **operator 入力** | `ENSEMBLE_OPERATOR_MESSAGE` による post-loop 入力 |
| **roundtrip** | worker メッセージの往復（profile 別 fixture） |

### 配置

```
packages/cli/test/e2e/**/*.e2e.test.ts
packages/cli/test/e2e/fixtures/**
```

### 実行

```bash
pnpm test:e2e
```

### 前提・スキップ

- `CURSOR_API_KEY` または `ensemble auth login` 済み
- `test-acp.yaml` + テスト用 Issue URL（または専用テスト repo）
- GitHub API トークン（`GITHUB_TOKEN` / `GH_TOKEN`。実 Issue を触る場合）

未設定時は skip。

### vitest 設定方針

- `include`: `**/test/e2e/**` のみ
- タイムアウト: 数分（LLM + ACP 待ち）
- 逐次実行必須

---

## コマンド一覧

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

## 参照

- [modular-prompt: TESTING_STRATEGY.md](https://github.com/otolab/modular-prompt/blob/main/docs/TESTING_STRATEGY.md)
- [modular-prompt: vitest.config.ts](https://github.com/otolab/modular-prompt/blob/main/packages/driver/vitest.config.ts) — unittest から integration/e2e を exclude する例
- [architecture.md §4](architecture.md) — ACP 起動パターン
- [development.md](development.md) — ローカルでの実行手順
